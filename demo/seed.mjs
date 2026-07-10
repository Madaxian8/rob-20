#!/usr/bin/env node
// Local demo: deploy Hub+Market on a running anvil, seed ticks/mints/listings,
// and write demo/config.json for the indexer. Assumes anvil on 127.0.0.1:8545.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEMO = path.join(ROOT, "demo");
const RPC = "http://127.0.0.1:8545";
const hex = (s) => "0x" + Buffer.from(s, "utf8").toString("hex");
const weiHex = (n) => "0x" + n.toString(16);
const calldata = (...a) => execFileSync("cast", ["calldata", ...a]).toString().trim();

let id = 0;
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const b = await res.json();
  if (b.error) throw new Error(`${method}: ${b.error.message}`);
  return b.result;
}
async function send(tx, expectFail = false) {
  const hash = await rpc("eth_sendTransaction", [expectFail ? { ...tx, gas: "0x7a120" } : tx]);
  for (let i = 0; i < 60; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await new Promise((s) => setTimeout(s, 100));
  }
  throw new Error("receipt timeout");
}

for (let i = 0; i < 60; i++) {
  try { await rpc("eth_chainId", []); break; } catch { await new Promise((s) => setTimeout(s, 200)); }
}
const accts = await rpc("eth_accounts", []);
const [a0, a1, a2, a3, a4, a5] = accts;
const pad = (a) => a.slice(2).padStart(64, "0");

execFileSync("forge", ["build"], { cwd: ROOT, stdio: "ignore" });
const art = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, `out/${n}.sol/${n}.json`), "utf8")).bytecode.object;

const startBlock = Number(BigInt(await rpc("eth_blockNumber", [])));
const HUB = (await send({ from: a0, data: art("InscriptionHub") })).contractAddress;
const MARKET = (await send({ from: a0, data: art("InscriptionMarket") + pad(a0) + pad(a0) })).contractAddress;
console.log("Hub", HUB, "Market", MARKET);

const deploySig = "deployTick(string,uint64,uint128,uint32,uint128)";
const mint = (t, amt) => hex(`data:,{"p":"rob-20","op":"mint","tick":"${t}","amt":"${amt}"}`);
const list = (t, amt, price) => hex(`data:,{"p":"rob-20","op":"list","tick":"${t}","amt":"${amt}","price":"${price}"}`);

// robin — the platform genesis tick (partially minted so the progress bar shows movement)
await send({ from: a0, to: HUB, data: calldata(deploySig, "robin", "21000", "1000", "10", (10n ** 15n).toString()) });
for (const who of [a1, a2, a3, a4, a5]) {
  const n = 3 + (accts.indexOf(who) % 4);
  for (let i = 0; i < n; i++) await send({ from: who, to: HUB, value: weiHex(10n ** 15n), data: mint("robin", "1000") });
}
// pepe — free mint, more advanced
await send({ from: a1, to: HUB, data: calldata(deploySig, "pepe", "100", "10000", "20", "0") });
for (const who of [a2, a3, a4]) for (let i = 0; i < 8; i++) await send({ from: who, to: HUB, value: "0x0", data: mint("pepe", "10000") });
// hood — a small pricier tick, nearly sold out
await send({ from: a2, to: HUB, data: calldata(deploySig, "hood", "10", "500", "5", (5n * 10n ** 15n).toString()) });
for (let i = 0; i < 5; i++) await send({ from: a3, to: HUB, value: weiHex(5n * 10n ** 15n), data: mint("hood", "500") });
for (let i = 0; i < 4; i++) await send({ from: a4, to: HUB, value: weiHex(5n * 10n ** 15n), data: mint("hood", "500") });

// market: multi-level order books per tick, confirmed by operator (a0), plus trades.
const E = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 12n).toString(); // ETH(float) -> wei string
const asks = [
  [a1, "robin", "1000", E(0.02)],   // 1
  [a2, "robin", "500", E(0.012)],   // 2
  [a3, "robin", "2000", E(0.03)],   // 3  (cheapest unit 0.000015)
  [a4, "robin", "1000", E(0.025)],  // 4
  [a5, "robin", "1500", E(0.05)],   // 5  (left pending)
  [a2, "pepe", "10000", E(0.005)],  // 6
  [a3, "pepe", "20000", E(0.008)],  // 7
  [a4, "pepe", "10000", E(0.011)],  // 8
  [a3, "hood", "500", E(0.01)],     // 9
  [a4, "hood", "1000", E(0.018)],   // 10
];
for (const [who, tick, amt, price] of asks) await send({ from: who, to: MARKET, data: list(tick, amt, price) });
for (const id of [1, 2, 3, 4, 6, 7, 8, 9, 10]) await send({ from: a0, to: MARKET, data: calldata("confirm(uint256)", String(id)) });
// leave id 5 pending (待平台确认); execute a few buys to seed the trades feed
const pay = (wei) => weiHex(BigInt(wei) + (BigInt(wei) * 500n) / 10000n);
await send({ from: a0, to: MARKET, data: calldata("buy(uint256)", "3"), value: pay(E(0.03)) }); // robin trade
await send({ from: a0, to: MARKET, data: calldata("buy(uint256)", "6"), value: pay(E(0.005)) }); // pepe trade
await send({ from: a5, to: MARKET, data: calldata("buy(uint256)", "9"), value: pay(E(0.01)) }); // hood trade

// bids (buy orders): a few open buy orders on robin at different prices; one gets accepted+settled
const placeBid = (who, tick, amt, price) =>
  send({ from: who, to: MARKET, value: pay(price), data: calldata("placeBid(string,uint128,uint128)", tick, amt, price) });
await placeBid(a1, "robin", "1000", E(0.015)); // bid 1  unit 0.000015 (accepted below)
await placeBid(a4, "robin", "1000", E(0.012)); // bid 2  unit 0.000012
await placeBid(a2, "robin", "2000", E(0.02));  // bid 3  unit 0.00001
await placeBid(a3, "pepe", "10000", E(0.004)); // bid 4
// a3 accepts bid 1 (has robin): send accept inscription to bidder a1, then operator settles
const accept = (tick, bid) => hex(`data:,{"p":"rob-20","op":"accept","tick":"${tick}","bid":"${bid}"}`);
await send({ from: a3, to: a1, value: "0x0", data: accept("robin", "1") });
await send({ from: a0, to: MARKET, data: calldata("settleBid(uint256,address)", "1", a3) });
// leave bids 2,3,4 open (visible on the buy side of the book)

fs.mkdirSync(DEMO, { recursive: true });
fs.writeFileSync(path.join(DEMO, "config.json"), JSON.stringify({
  rpcUrl: RPC, hubAddress: HUB, marketAddress: MARKET, deployBlock: startBlock,
  confirmations: 0, batchBlocks: 500, pollMs: 2000, port: 3000,
  stateFile: path.join(DEMO, "state.json"), eventsFile: path.join(DEMO, "events.jsonl"),
}, null, 2));
// fresh ledger each seed
for (const f of ["state.json", "events.jsonl"]) fs.rmSync(path.join(DEMO, f), { force: true });
console.log("seeded: 3 ticks (robin/pepe/hood), mints, 3 listings (2 active, 1 pending)");
console.log("config:", path.join(DEMO, "config.json"));
