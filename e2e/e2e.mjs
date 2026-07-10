#!/usr/bin/env node
// End-to-end test for the rob-20 platform: deploy Hub + Market on anvil, run a
// full lifecycle (2 ticks, valid/invalid mints, transfers, list/confirm/buy/
// cancel incl. an invalid-escrow listing), then run the indexer (--once) and
// assert the ledger matches PROTOCOL.md. Run: node e2e/e2e.mjs
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8600;
const RPC = `http://127.0.0.1:${PORT}`;

const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const weiHex = (n) => "0x" + n.toString(16);
const PRICE_MINT = 10n ** 15n; // 0.001 ETH
const FORCE_GAS = "0x7a120"; // mine failing txs with status 0 instead of erroring

const calldata = (...args) => execFileSync("cast", ["calldata", ...args]).toString().trim();

let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function send(tx, expectFail = false) {
  const hash = await rpc("eth_sendTransaction", [expectFail ? { ...tx, gas: FORCE_GAS } : tx]);
  for (let i = 0; i < 50; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) {
      assert.equal(r.status, expectFail ? "0x0" : "0x1", `tx status mismatch (${JSON.stringify(tx).slice(0, 120)})`);
      return r;
    }
    await new Promise((s) => setTimeout(s, 100));
  }
  throw new Error("receipt timeout");
}

const anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());

try {
  for (let i = 0; i < 50; i++) {
    try { await rpc("eth_chainId", []); break; } catch { await new Promise((s) => setTimeout(s, 200)); }
  }
  const [a0, a1, a2, a3, a4] = await rpc("eth_accounts", []);

  // ---- deploy contracts ----
  execFileSync("forge", ["build"], { cwd: ROOT, stdio: "ignore" });
  const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `out/${n}.sol/${n}.json`), "utf8")).bytecode.object;
  const hubR = await send({ from: a0, data: art("InscriptionHub") });
  const HUB = hubR.contractAddress.toLowerCase();
  const pad = (a) => a.slice(2).padStart(64, "0");
  const marketR = await send({ from: a0, data: art("InscriptionMarket") + pad(a0) + pad(a0) }); // owner=operator=a0
  const MARKET = marketR.contractAddress.toLowerCase();
  console.log("Hub:", HUB, "Market:", MARKET);

  // ---- deploy ticks ----
  const deploySig = "deployTick(string,uint64,uint128,uint32,uint128)";
  // robin: maxMints == the 13 valid mints below, so it ends 100% minted and is
  // therefore tradable (a tick must be sold out to be listed — the trade gate).
  await send({ from: a0, to: HUB, data: calldata(deploySig, "robin", "13", "1000", "10", PRICE_MINT.toString()) });
  await send({ from: a1, to: HUB, data: calldata(deploySig, "free", "100", "5", "2", "0") });
  // duplicate tick reverts
  await send({ from: a2, to: HUB, data: calldata(deploySig, "robin", "1", "1", "1", "0") }, true);

  // ---- mints ----
  const mint = (tick, amt) => hex(`data:,{"p":"rob-20","op":"mint","tick":"${tick}","amt":"${amt}"}`);
  for (let i = 0; i < 10; i++) await send({ from: a1, to: HUB, value: weiHex(PRICE_MINT), data: mint("robin", "1000") });
  await send({ from: a1, to: HUB, value: weiHex(PRICE_MINT), data: mint("robin", "1000") }, true); // 11th: wallet limit
  await send({ from: a2, to: HUB, value: weiHex(2n * PRICE_MINT), data: mint("robin", "1000") }, true); // wrong value
  for (let i = 0; i < 3; i++) await send({ from: a2, to: HUB, value: weiHex(PRICE_MINT), data: mint("robin", "1000") });
  await send({ from: a2, to: HUB, value: weiHex(PRICE_MINT), data: mint("robin", "999") }, true); // amt mismatch
  for (let i = 0; i < 2; i++) await send({ from: a3, to: HUB, value: "0x0", data: mint("free", "5") });

  // deployer fees accrued: 13 paid robin mints -> a0 pending 0.013 ETH
  const pendingFees = await rpc("eth_call", [{ to: HUB, data: calldata("pendingFees(address)", a0) }, "latest"]);
  assert.equal(BigInt(pendingFees), 13n * PRICE_MINT, "hub fee accounting");

  // ---- transfers ----
  const transfer = (tick, amt) => hex(`data:,{"p":"rob-20","op":"transfer","tick":"${tick}","amt":"${amt}"}`);
  await send({ from: a1, to: a3, value: "0x0", data: transfer("robin", "500") }); // valid
  await send({ from: a3, to: a4, value: "0x0", data: transfer("robin", "10000") }); // over balance: on-chain ok, ledger-invalid
  await send({ from: a2, to: a4, value: "0x0", data: transfer("robin", "0500") }); // leading zero: not an op at all
  await send({ from: a2, to: a2, value: "0x0", data: transfer("robin", "100") }); // self-transfer: valid, no net change
  // exact-balance spend-all WITH nonzero ETH attached (both are protocol-legal)
  await send({ from: a3, to: a4, value: weiHex(10n ** 15n), data: transfer("free", "10") });

  // ---- sold-out boundary at the ledger level ----
  await send({ from: a0, to: HUB, data: calldata(deploySig, "tiny", "2", "1", "2", "0") });
  await send({ from: a4, to: HUB, value: "0x0", data: mint("tiny", "1") });
  await send({ from: a4, to: HUB, value: "0x0", data: mint("tiny", "1") });
  await send({ from: a3, to: HUB, value: "0x0", data: mint("tiny", "1") }, true); // SoldOut

  // ---- contract-mediated (internal call) deploy + market ops ----
  // A Safe/factory registering a tick emits Deployed with tx.to = the proxy,
  // NOT the Hub — the indexer must still see it (via eth_getLogs) and must not
  // crash when the tick is subsequently minted by an EOA.
  const proxyR = await send({ from: a3, data: art("CallProxy") });
  const PROXY = proxyR.contractAddress;
  const viaProxy = (target, inner, value = "0x0") => ({
    from: a3, to: PROXY, value, data: calldata("exec(address,bytes)", target, inner),
  });
  await send(viaProxy(HUB, calldata(deploySig, "safetick", "1", "50", "1", "0")));
  await send({ from: a4, to: HUB, value: "0x0", data: mint("safetick", "50") }); // EOA mints the proxy-deployed tick → 1/1, sold out (tradable)

  // ---- market ----
  const list = (tick, amt, price) => hex(`data:,{"p":"rob-20","op":"list","tick":"${tick}","amt":"${amt}","price":"${price}"}`);
  const PRICE_LIST = 5n * 10n ** 16n; // 0.05 ETH
  const FEE = (PRICE_LIST * 500n) / 10000n;

  await send({ from: a1, to: MARKET, data: list("robin", "500", PRICE_LIST.toString()) }); // id 1, escrow valid
  await send({ from: a4, to: MARKET, data: list("robin", "999999", "1000") }); // id 2, escrow INVALID (a4 has none)
  await send({ from: a2, to: MARKET, data: list("robin", "300", "1000") }); // id 3, escrow valid

  await send({ from: a0, to: MARKET, data: calldata("confirm(uint256)", "1") });
  await send({ from: a0, to: MARKET, data: calldata("confirm(uint256)", "3") });
  await send({ from: a2, to: MARKET, data: calldata("buy(uint256)", "2"), value: weiHex(1050n) }, true); // pending -> BadState
  await send({ from: a2, to: MARKET, data: calldata("buy(uint256)", "1"), value: weiHex(PRICE_LIST + FEE) }); // sold to a2
  await send({ from: a2, to: MARKET, data: calldata("cancel(uint256)", "3") }); // a2 reclaims 300

  // proxy-mediated market op: a4 lists safetick directly (id 4), then a CANCEL routed
  // through the proxy must fail (seller is a4, not the proxy); a4 cancels directly.
  await send({ from: a4, to: MARKET, data: list("safetick", "50", "1000") }); // id 4, escrow valid
  await send(viaProxy(MARKET, calldata("cancel(uint256)", "4")), true); // NotSeller: proxy != a4
  await send({ from: a4, to: MARKET, data: calldata("cancel(uint256)", "4") });

  // ---- bids (buy orders): place -> accept -> settle, and place -> cancel ----
  const accept = (tick, bid) => hex(`data:,{"p":"rob-20","op":"accept","tick":"${tick}","bid":"${bid}"}`);
  const BID_PRICE = 10n ** 16n; // 0.01 ETH
  const BID_FEE = (BID_PRICE * 500n) / 10000n;
  // a3 bids to buy 500 robin (escrows price + 5%)
  await send({ from: a3, to: MARKET, value: weiHex(BID_PRICE + BID_FEE), data: calldata("placeBid(string,uint128,uint128)", "robin", "500", BID_PRICE.toString()) }); // bid 1
  // a1 (holds robin) accepts by sending the accept inscription to the bidder a3
  await send({ from: a1, to: a3, value: "0x0", data: accept("robin", "1") });
  // operator settles the bid to a1
  await send({ from: a0, to: MARKET, data: calldata("settleBid(uint256,address)", "1", a1) });
  // a4 places a bid then cancels it (full refund, no ledger effect)
  const BID2 = 5n * 10n ** 15n;
  await send({ from: a4, to: MARKET, value: weiHex(BID2 + (BID2 * 500n) / 10000n), data: calldata("placeBid(string,uint128,uint128)", "robin", "100", BID2.toString()) }); // bid 2
  await send({ from: a4, to: MARKET, data: calldata("cancelBid(uint256)", "2") });

  // ---- trade gate: a tick that is NOT 100% minted must not get a valid escrow ----
  await send({ from: a0, to: HUB, data: calldata(deploySig, "gated", "5", "100", "5", "0") });
  await send({ from: a4, to: HUB, value: "0x0", data: mint("gated", "100") });
  await send({ from: a4, to: HUB, value: "0x0", data: mint("gated", "100") }); // 2/5 minted — NOT sold out
  await send({ from: a4, to: MARKET, data: list("gated", "100", "1000") }); // id 5 — escrow must be INVALID (gated)

  // ---- index and verify ledger ----
  const tmpDir = fs.mkdtempSync(path.join(ROOT, "e2e/run-"));
  const config = {
    rpcUrl: RPC, hubAddress: HUB, marketAddress: MARKET, deployBlock: 0, confirmations: 0,
    batchBlocks: 200, stateFile: path.join(tmpDir, "state.json"), eventsFile: path.join(tmpDir, "events.jsonl"),
  };
  const configPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runIndexer = () =>
    execFileSync("node", [path.join(ROOT, "indexer/indexer.mjs"), "--once"], {
      env: { ...process.env, CONFIG_PATH: configPath }, stdio: "pipe",
    });
  runIndexer();
  const st = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));

  const [A1, A2, A3, A4] = [a1, a2, a3, a4].map((a) => a.toLowerCase());

  // ticks
  assert.equal(st.ticks.robin.maxMints, 13);
  assert.equal(st.ticks.robin.amountPerMint, "1000");
  assert.equal(st.ticks.robin.mintPriceWei, PRICE_MINT.toString());
  assert.equal(st.ticks.robin.totalMints, 13);
  assert.equal(st.ticks.free.totalMints, 2);
  assert.equal(st.ticks.tiny.totalMints, 2, "tiny minted out at exactly maxMints");
  assert.equal(st.ticks.tiny.maxMints, 2);
  // balances after listings AND the bid flow: a1 delivered 500 into bid#1 (9000-500=8500),
  // a3 received 500 from bid#1 (500+500=1000); a2 unchanged
  assert.equal(st.balances.robin[A1], "8500");
  assert.equal(st.balances.robin[A2], "3500");
  assert.equal(st.balances.robin[A3], "1000");
  assert.equal(st.balances.robin[A4], undefined);
  // bid #1 filled by a1, delivered to bidder a3; bid #2 cancelled (refund, no ledger effect)
  assert.equal(st.bids["1"].chainStatus, "filled");
  assert.equal(st.bids["1"].escrow, "released");
  assert.equal(st.bids["1"].seller, A1);
  assert.equal(st.bids["1"].bidder, A3);
  assert.equal(st.bids["2"].chainStatus, "cancelled");
  // free: a3 spent ALL 10 to a4 (with ETH attached) — zero balance must be deleted, not "0"
  assert.equal(st.balances.free[A3], undefined);
  assert.equal(st.balances.free[A4], "10");
  assert.equal(st.balances.tiny[A4], "2");
  // proxy-deployed tick was indexed (Deployed via internal call) and minted safely
  assert.equal(st.ticks.safetick.totalMints, 1, "internal-call deploy must be indexed");
  assert.equal(st.balances.safetick[A4], "50");
  assert.equal(st.listings["4"].chainStatus, "cancelled");
  assert.equal(st.listings["4"].escrow, "released");
  assert.equal(st.mintsOf.robin[A1], 10);
  assert.equal(st.mintsOf.robin[A2], 3);
  assert.equal(st.invalidTransfers, 1);
  // listings
  assert.equal(st.listings["1"].chainStatus, "sold");
  assert.equal(st.listings["1"].escrow, "released");
  assert.equal(st.listings["1"].buyer, A2);
  assert.equal(st.listings["2"].chainStatus, "pending");
  assert.equal(st.listings["2"].escrow, "invalid");
  assert.equal(st.listings["3"].chainStatus, "cancelled");
  assert.equal(st.listings["3"].escrow, "released");
  // conservation: all robin balances sum to 13 mints x 1000
  const sum = Object.values(st.balances.robin).reduce((a, b) => a + BigInt(b), 0n);
  assert.equal(sum, 13000n);

  // trade gate: a not-fully-minted tick (gated 2/5) must never get a valid escrow
  assert.equal(st.ticks.gated.totalMints, 2);
  assert.equal(st.ticks.gated.maxMints, 5);
  assert.equal(st.listings["5"].escrow, "invalid", "not-sold-out tick must not get valid escrow");
  assert.equal(st.listings["5"].chainStatus, "pending", "gated listing stays pending, never confirmable");

  // ---- replay determinism (state AND event log) ----
  const eventsFirstRun = fs.readFileSync(config.eventsFile, "utf8");
  // delete ONLY state.json — the indexer must rewind events.jsonl itself and
  // reproduce it byte-identically, with no duplicated lines
  fs.rmSync(config.stateFile);
  runIndexer();
  assert.deepEqual(JSON.parse(fs.readFileSync(config.stateFile, "utf8")), st, "state replay must be identical");
  const eventsSecondRun = fs.readFileSync(config.eventsFile, "utf8");
  assert.equal(eventsSecondRun, eventsFirstRun, "events.jsonl replay must be identical (no duplicates)");
  const keys = eventsSecondRun.trim().split("\n").map((l) => {
    const e = JSON.parse(l);
    return `${e.op}:${e.tx}:${e.id ?? ""}`;
  });
  assert.equal(new Set(keys).size, keys.length, "no duplicate event lines");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log("\n✅ e2e passed: ticks, mints incl. sold-out boundary, transfers (self/spend-all/valued), full market lifecycle, TRADE GATE (not-sold-out tick can't be listed), ledger conserved, state+events replay deterministic");
} finally {
  anvil.kill();
}
