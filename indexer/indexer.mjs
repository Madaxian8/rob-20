#!/usr/bin/env node
// rob-20 platform indexer — canonical accounting for all ticks (see ../PROTOCOL.md)
// Zero dependencies; requires Node 18+ (built-in fetch).
//
// Usage:
//   node indexer.mjs            # scan continuously + serve HTTP API / web app
//   node indexer.mjs --once     # catch up to (head - confirmations), then exit
//   RPC_URL=... node indexer.mjs

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(DIR, "config.json");
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const RPC_URL = process.env.RPC_URL || cfg.rpcUrl;
const HUB = cfg.hubAddress.toLowerCase();
const MARKET = cfg.marketAddress.toLowerCase();
const STATE_PATH = path.resolve(DIR, cfg.stateFile || "state.json");
const EVENTS_PATH = path.resolve(DIR, cfg.eventsFile || "events.jsonl");
const CONFIRMATIONS = cfg.confirmations ?? 10;
const BATCH_BLOCKS = cfg.batchBlocks ?? 50;
const POLL_MS = cfg.pollMs ?? 3000;
const ONCE = process.argv.includes("--once");

// ---- rob-20 canonical forms ----
const TRANSFER_RE = /^data:,\{"p":"rob-20","op":"transfer","tick":"([a-z0-9]{1,8})","amt":"([1-9][0-9]{0,29})"\}$/;
const ACCEPT_RE = /^data:,\{"p":"rob-20","op":"accept","tick":"([a-z0-9]{1,8})","bid":"([1-9][0-9]{0,29})"\}$/;

// event topic0 hashes (keccak256 of the signatures)
const T = {
  Deployed: "0xbd32a5aa8c78251b72ca19f5247f3981cb58b0bd35ec7688360e09914de3b709", // Deployed(bytes32,address,string,uint64,uint128,uint32,uint128)
  Inscribed: "0xb83539c9454f41c8e951a8f786ba40870336cc9626d2775eea08db544f8c4ff5", // Inscribed(bytes32,address,uint64)
  Listed: "0x1844ca806b7e864dab5b4dcbe58d1a20b9047271da99368429ac5e0d82d7f720", // Listed(uint256,address,bytes32,string,uint256,uint256)
  Confirmed: "0xc13332a43e47b855337e607df3246f6827921cb8d114a3e933ec50107c72ca3d", // ListingConfirmed(uint256)
  Bought: "0xc54c8cc1c7525b424ec71b685c00d9355581a280488018c22005332ceb2fd406", // Bought(uint256,address)
  Cancelled: "0xc41d93b8bfbf9fd7cf5bfe271fd649ab6a6fec0ea101c23b82a2a28eca2533a9", // Cancelled(uint256)
  BidPlaced: "0xfaaf78085e2c2d821322f054efd5ee566d92fe1cbae9123a42ec9abf5169f998", // BidPlaced(uint256,address,bytes32,string,uint256,uint256)
  BidFilled: "0xccaaec2a776da8d0eeb5f11e4d2be4d028082e9b5077028a178f921e92480abf", // BidFilled(uint256,address)
  BidCancelled: "0xc1546e394b1975212fe013e7e6995653585f44e568c407d1157483f7d4b94581", // BidCancelled(uint256)
};

// ---- state ----
function freshState() {
  return {
    lastBlock: cfg.deployBlock - 1,
    lastBlockHash: null, // parent-hash continuity check (reorg detection)
    // ticks[tick] = {tickHash, deployer, maxMints, amountPerMint, walletLimit, mintPriceWei, totalMints, deployTx, deployBlock}
    ticks: {},
    tickByHash: {}, // tickHash -> tick
    balances: {}, // balances[tick][addr] = string
    mintsOf: {}, // mintsOf[tick][addr] = number
    // listings[id] = {seller, tick, amt, price, chainStatus: pending|active|sold|cancelled,
    //                 escrow: valid|invalid|released, buyer?, listTx, block}
    listings: {},
    // bids[id] = {bidder, tick, amt, price, chainStatus: open|filled|cancelled,
    //             escrow: none|valid|released, accepter?, seller?, placeTx, block}
    bids: {},
    recentMints: [], // [{tick, n, minter, tx, block}]
    recentTrades: [], // [{id, tick, amt, price, seller, buyer, tx, block}] most-recent-first
    recentActivity: [], // unified feed: [{type, tick, ..., block, tx}] most-recent-first
    invalidTransfers: 0,
  };
}

let state;

/// Rewind to the last durable checkpoint: reload state.json and drop any
/// events.jsonl lines past it. Called at startup AND after a mid-batch scan
/// error, so a partially-applied block in memory (or a partially-logged batch
/// on disk) can never double-apply or duplicate events on the next attempt.
function reloadFromCheckpoint() {
  state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : freshState();
  // Backfill any top-level fields added since the checkpoint was written, so a
  // code upgrade that introduces new state (e.g. bids) can't crash on load.
  for (const [k, v] of Object.entries(freshState())) {
    if (state[k] === undefined) state[k] = v;
  }
  if (fs.existsSync(EVENTS_PATH)) {
    const lines = fs.readFileSync(EVENTS_PATH, "utf8").split("\n").filter(Boolean);
    const kept = lines.filter((l) => {
      try {
        return JSON.parse(l).block <= state.lastBlock;
      } catch {
        return false;
      }
    });
    if (kept.length !== lines.length) {
      fs.writeFileSync(EVENTS_PATH, kept.length ? kept.join("\n") + "\n" : "");
      console.error(`rewound events.jsonl to checkpoint (dropped ${lines.length - kept.length} uncheckpointed lines)`);
    }
  }
}
reloadFromCheckpoint();

function saveState() {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}
const logEvent = (ev) => fs.appendFileSync(EVENTS_PATH, JSON.stringify(ev) + "\n");

function pushActivity(item) {
  state.recentActivity.unshift(item);
  if (state.recentActivity.length > 300) state.recentActivity.pop();
}
// running per-tick volume + trade count (persisted), for discovery sorting
function addVolume(tick, priceWei) {
  const t = state.ticks[tick];
  if (!t) return;
  t.volumeWei = (BigInt(t.volumeWei || "0") + BigInt(priceWei)).toString();
  t.tradeCount = (t.tradeCount || 0) + 1;
}

// ---- JSON-RPC ----
let rpcId = 0;
async function rpc(method, params, attempt = 0) {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    if (res.status === 429) throw new Error("rate limited");
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  } catch (err) {
    if (attempt >= 6) throw err;
    await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 15000)));
    return rpc(method, params, attempt + 1);
  }
}

const hexToNum = (h) => Number(BigInt(h));
const hexToBig = (h) => BigInt(h);
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();
const word = (data, i) => data.slice(2 + i * 64, 2 + (i + 1) * 64); // i-th 32-byte word of event data

function decodeAbiString(data, offsetWordIdx) {
  const off = Number(BigInt("0x" + word(data, offsetWordIdx)));
  const lenWord = data.slice(2 + off * 2, 2 + off * 2 + 64);
  const len = Number(BigInt("0x" + lenWord));
  const strHex = data.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2);
  return Buffer.from(strHex, "hex").toString("utf8");
}

function decodeUtf8(inputHex) {
  if (!inputHex || inputHex === "0x") return "";
  return Buffer.from(inputHex.slice(2), "hex").toString("utf8");
}

function bal(tick, addr) {
  return BigInt(state.balances[tick]?.[addr] || "0");
}
// A tick may only be traded once it is 100% minted (totalMints == maxMints).
// Gate both ask escrow and bid-accept escrow on this so nothing is confirmable
// until the tick is fully minted.
function isSoldOut(tick) {
  const t = state.ticks[tick];
  return !!t && t.totalMints >= t.maxMints;
}
function setBal(tick, addr, v) {
  state.balances[tick] ??= {};
  if (v === 0n) delete state.balances[tick][addr];
  else state.balances[tick][addr] = v.toString();
}

// ---- settlement rules (PROTOCOL.md) ----

function applyLog(log, txHash, blockNum, blockTs) {
  const addr = log.address.toLowerCase();
  const topic0 = log.topics[0];

  if (addr === HUB && topic0 === T.Deployed) {
    const tickHash = log.topics[1].toLowerCase();
    const deployer = topicAddr(log.topics[2]);
    const tick = decodeAbiString(log.data, 0);
    const maxMints = Number(BigInt("0x" + word(log.data, 1)));
    const amountPerMint = BigInt("0x" + word(log.data, 2)).toString();
    const walletLimit = Number(BigInt("0x" + word(log.data, 3)));
    const mintPriceWei = BigInt("0x" + word(log.data, 4)).toString();
    state.ticks[tick] = {
      tickHash, deployer, maxMints, amountPerMint, walletLimit, mintPriceWei,
      totalMints: 0, volumeWei: "0", tradeCount: 0, deployTx: txHash, deployBlock: blockNum,
    };
    state.tickByHash[tickHash] = tick;
    pushActivity({ type: "deploy", tick, actor: deployer, tx: txHash, block: blockNum });
    logEvent({ op: "deploy", tick, deployer, maxMints, amountPerMint, walletLimit, mintPriceWei, tx: txHash, block: blockNum });
    return;
  }

  if (addr === HUB && topic0 === T.Inscribed) {
    const tick = state.tickByHash[log.topics[1].toLowerCase()];
    if (!tick) return fatal(`Inscribed for unknown tickHash ${log.topics[1]} at ${txHash}`);
    const minter = topicAddr(log.topics[2]);
    const n = Number(BigInt(log.data === "0x" ? "0x0" : log.data));
    const t = state.ticks[tick];
    if (n > t.maxMints) return fatal(`tick ${tick} over-minted (${n} > ${t.maxMints}) at ${txHash}`);
    t.totalMints = Math.max(t.totalMints, n);
    state.mintsOf[tick] ??= {};
    state.mintsOf[tick][minter] = (state.mintsOf[tick][minter] || 0) + 1;
    setBal(tick, minter, bal(tick, minter) + BigInt(t.amountPerMint));
    state.recentMints.unshift({ tick, n, minter, tx: txHash, block: blockNum });
    if (state.recentMints.length > 100) state.recentMints.pop();
    pushActivity({ type: "mint", tick, n, actor: minter, amt: t.amountPerMint, tx: txHash, block: blockNum });
    logEvent({ op: "mint", tick, n, minter, tx: txHash, block: blockNum });
    return;
  }

  if (addr === MARKET && topic0 === T.Listed) {
    const id = BigInt(log.topics[1]).toString();
    const seller = topicAddr(log.topics[2]);
    const tick = state.tickByHash[log.topics[3].toLowerCase()];
    const amt = BigInt("0x" + word(log.data, 1));
    const price = BigInt("0x" + word(log.data, 2)).toString();
    // escrow check: unknown tick, not-fully-minted tick, or insufficient balance
    // -> invalid, never confirmable. A tick must be 100% minted to be listed.
    let escrow = "invalid";
    if (tick && isSoldOut(tick) && bal(tick, seller) >= amt) {
      setBal(tick, seller, bal(tick, seller) - amt);
      escrow = "valid";
    }
    state.listings[id] = {
      seller, tick: tick || null, amt: amt.toString(), price,
      chainStatus: "pending", escrow, listTx: txHash, block: blockNum,
    };
    if (tick) pushActivity({ type: "list", tick, id: Number(id), actor: seller, amt: amt.toString(), price, tx: txHash, block: blockNum });
    logEvent({ op: "list", id, seller, tick, amt: amt.toString(), price, escrow, tx: txHash, block: blockNum });
    return;
  }

  if (addr === MARKET && (topic0 === T.Confirmed || topic0 === T.Bought || topic0 === T.Cancelled)) {
    const id = BigInt(log.topics[1]).toString();
    const l = state.listings[id];
    if (!l) return fatal(`market event for unknown listing ${id} at ${txHash}`);

    if (topic0 === T.Confirmed) {
      l.chainStatus = "active";
      if (l.escrow !== "valid") console.error(`WARNING: operator confirmed listing ${id} with ${l.escrow} escrow`);
    } else if (topic0 === T.Bought) {
      const buyer = topicAddr(log.topics[2]);
      l.chainStatus = "sold";
      l.buyer = buyer;
      l.soldTx = txHash;
      l.soldBlock = blockNum;
      if (l.escrow === "valid") {
        setBal(l.tick, buyer, bal(l.tick, buyer) + BigInt(l.amt));
        l.escrow = "released";
      } else {
        console.error(`CRITICAL: listing ${id} sold without valid escrow — buyer ${buyer} received nothing`);
      }
      if (l.tick) {
        state.recentTrades.unshift({
          id: Number(id), tick: l.tick, amt: l.amt, price: l.price,
          seller: l.seller, buyer, tx: txHash, block: blockNum, ts: blockTs,
        });
        if (state.recentTrades.length > 500) state.recentTrades.pop();
        addVolume(l.tick, l.price);
        pushActivity({ type: "trade", tick: l.tick, id: Number(id), actor: buyer, seller: l.seller, amt: l.amt, price: l.price, tx: txHash, block: blockNum });
      }
    } else {
      l.chainStatus = "cancelled";
      if (l.escrow === "valid") {
        setBal(l.tick, l.seller, bal(l.tick, l.seller) + BigInt(l.amt));
        l.escrow = "released";
      }
    }
    logEvent({ op: l.chainStatus, id, tx: txHash, block: blockNum });
    return;
  }

  // ---- bids (buy orders) ----
  if (addr === MARKET && topic0 === T.BidPlaced) {
    const id = BigInt(log.topics[1]).toString();
    const bidder = topicAddr(log.topics[2]);
    const tick = decodeAbiString(log.data, 0); // first non-indexed arg is `string tick`
    const amt = BigInt("0x" + word(log.data, 1)).toString();
    const price = BigInt("0x" + word(log.data, 2)).toString();
    state.bids[id] = {
      bidder, tick, amt, price, chainStatus: "open", escrow: "none",
      accepter: null, placeTx: txHash, block: blockNum,
    };
    if (state.ticks[tick]) pushActivity({ type: "bid", tick, id: Number(id), actor: bidder, amt, price, tx: txHash, block: blockNum });
    logEvent({ op: "bid", id, bidder, tick, amt, price, tx: txHash, block: blockNum });
    return;
  }

  if (addr === MARKET && (topic0 === T.BidFilled || topic0 === T.BidCancelled)) {
    const id = BigInt(log.topics[1]).toString();
    const b = state.bids[id];
    if (!b) return fatal(`bid event for unknown bid ${id} at ${txHash}`);
    if (topic0 === T.BidFilled) {
      const seller = topicAddr(log.topics[2]);
      b.chainStatus = "filled";
      b.seller = seller;
      b.filledTx = txHash;
      b.filledBlock = blockNum;
      // the accepter's escrowed inscription is delivered to the bidder
      if (b.escrow === "valid" && b.tick) {
        setBal(b.tick, b.bidder, bal(b.tick, b.bidder) + BigInt(b.amt));
        b.escrow = "released";
        state.recentTrades.unshift({
          id: Number(id), kind: "bid", tick: b.tick, amt: b.amt, price: b.price,
          seller, buyer: b.bidder, tx: txHash, block: blockNum, ts: blockTs,
        });
        if (state.recentTrades.length > 500) state.recentTrades.pop();
        addVolume(b.tick, b.price);
        pushActivity({ type: "trade", tick: b.tick, id: Number(id), kind: "bid", actor: b.bidder, seller, amt: b.amt, price: b.price, tx: txHash, block: blockNum });
      } else {
        console.error(`CRITICAL: bid ${id} settled without valid accept escrow — seller ${seller} paid, buyer got nothing`);
      }
    } else {
      b.chainStatus = "cancelled";
      // release any pending accept escrow back to the accepter
      if (b.escrow === "valid" && b.tick && b.accepter) {
        setBal(b.tick, b.accepter, bal(b.tick, b.accepter) + BigInt(b.amt));
        b.escrow = "released";
      }
    }
    logEvent({ op: "bid-" + b.chainStatus, id, tx: txHash, block: blockNum });
  }
}

function fatal(msg) {
  console.error("FATAL:", msg);
  // Do NOT overwrite the canonical checkpoint: fatal() can fire mid-block (from
  // applyLog, after some txs of the block already mutated state but before
  // lastBlock advances). saveState() here would persist a partially-applied
  // block and, on restart, that block would be re-applied → double-counted.
  // Keep state.json at the last CLEAN block-boundary checkpoint; write a
  // forensic snapshot separately for debugging.
  try { fs.writeFileSync(STATE_PATH + ".corrupt", JSON.stringify(state, null, 2)); } catch { /* best effort */ }
  process.exit(1);
}

/// op: transfer — top-level calldata inscription to any non-system address.
/// `knownSuccess` skips the receipt fetch when the tx already proved success
/// (it emitted Hub/Market logs).
async function applyTransfer(tx, blockNum, knownSuccess) {
  const to = tx.to ? tx.to.toLowerCase() : null;
  if (to === null || to === HUB || to === MARKET) return;
  const text = decodeUtf8(tx.input ?? tx.data ?? "0x");
  const mt = TRANSFER_RE.exec(text);
  const ma = mt ? null : ACCEPT_RE.exec(text);
  if (!mt && !ma) return;

  const from = tx.from.toLowerCase();
  const ensureSuccess = async () => {
    if (knownSuccess) return true;
    const receipt = await rpc("eth_getTransactionReceipt", [tx.hash]);
    return receipt && receipt.status === "0x1";
  };

  if (mt) {
    const [, tick, amtStr] = mt;
    if (!state.ticks[tick]) return;
    if (!(await ensureSuccess())) return;
    const amt = BigInt(amtStr);
    if (bal(tick, from) < amt) {
      state.invalidTransfers += 1;
      logEvent({ op: "transfer", valid: false, tick, from, to, amt: amtStr, tx: tx.hash, block: blockNum });
      return;
    }
    setBal(tick, from, bal(tick, from) - amt);
    setBal(tick, to, bal(tick, to) + amt);
    logEvent({ op: "transfer", valid: true, tick, from, to, amt: amtStr, tx: tx.hash, block: blockNum });
    return;
  }

  // op: accept — a seller delivers into a bid. Escrow the seller's balance; the
  // operator's settleBid then releases it to the bidder (PROTOCOL.md).
  const [, tick, bidId] = ma;
  const b = state.bids[bidId];
  if (!b || b.chainStatus !== "open" || b.escrow === "valid") return; // unknown/closed/already-accepted
  if (b.tick !== tick) return;
  if (!(await ensureSuccess())) return;
  const amt = BigInt(b.amt);
  // a tick must be 100% minted before any market trade (asks or bids) can settle
  if (!isSoldOut(tick) || bal(tick, from) < amt) {
    logEvent({ op: "accept", valid: false, bid: bidId, seller: from, tx: tx.hash, block: blockNum });
    return;
  }
  setBal(tick, from, bal(tick, from) - amt); // escrow the seller's inscription
  b.accepter = from;
  b.escrow = "valid";
  logEvent({ op: "accept", valid: true, bid: bidId, seller: from, tx: tx.hash, block: blockNum });
}

async function scanToTarget() {
  const head = hexToNum(await rpc("eth_blockNumber", []));
  const target = head - CONFIRMATIONS;
  while (state.lastBlock < target) {
    const from = state.lastBlock + 1;
    const to = Math.min(from + BATCH_BLOCKS - 1, target);

    // ONE eth_getLogs per batch captures every Hub/Market event regardless of
    // call path (direct tx, Safe/factory internal call, contract wrapper) —
    // logs only exist for successful txs, so no receipt checks are needed.
    const logs = await rpc("eth_getLogs", [
      { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: [HUB, MARKET] },
    ]);
    const logsByBlockTx = new Map(); // blockNum -> txIndex -> [logs in logIndex order]
    for (const lg of logs) {
      const b = hexToNum(lg.blockNumber);
      const ti = hexToNum(lg.transactionIndex);
      if (!logsByBlockTx.has(b)) logsByBlockTx.set(b, new Map());
      const byTx = logsByBlockTx.get(b);
      if (!byTx.has(ti)) byTx.set(ti, []);
      byTx.get(ti).push(lg);
    }
    for (const byTx of logsByBlockTx.values()) {
      for (const arr of byTx.values()) arr.sort((x, y) => hexToNum(x.logIndex) - hexToNum(y.logIndex));
    }

    // Fetch blocks CONCURRENTLY (network I/O is the bottleneck), in windows of
    // `blockConcurrency` to bound memory, then APPLY strictly in order so the
    // ledger stays deterministic. This lets the indexer keep up with fast chains.
    const CONC = cfg.blockConcurrency ?? 20;
    for (let base = from; base <= to; base += CONC) {
      const end = Math.min(base + CONC - 1, to);
      const cnt = end - base + 1;
      const blks = await Promise.all(
        Array.from({ length: cnt }, (_, k) => rpc("eth_getBlockByNumber", ["0x" + (base + k).toString(16), true]))
      );
      for (let k = 0; k < cnt; k++) {
        const b = base + k;
        const block = blks[k];
        if (!block) throw new Error(`block ${b} not available`);
        if (state.lastBlockHash && block.parentHash.toLowerCase() !== state.lastBlockHash) {
          fatal(
            `reorg detected at block ${b} (parentHash mismatch). ` +
              `Delete state.json and events.jsonl, then restart to replay from genesis (deterministic).`
          );
        }
        const byTx = logsByBlockTx.get(b);
        const blockTs = hexToNum(block.timestamp); // unix seconds, for trade time-ranges
        for (const tx of block.transactions) {
          const txLogs = byTx?.get(hexToNum(tx.transactionIndex));
          if (txLogs) for (const lg of txLogs) applyLog(lg, tx.hash, b, blockTs);
          // a tx can also be a top-level transfer inscription (mutually exclusive
          // with system-contract logs in practice; both applied deterministically)
          await applyTransfer(tx, b, Boolean(txLogs));
        }
        state.lastBlock = b;
        state.lastBlockHash = block.hash.toLowerCase();
      }
    }
    saveState();
    console.log(`scanned to ${state.lastBlock}/${target} — ticks ${Object.keys(state.ticks).length}`);
    sseBroadcast(state.lastBlock);
  }
}

// ---- HTTP API + web app ----
const sseClients = new Set();
function sseBroadcast(block) {
  for (const res of sseClients) {
    try {
      res.write(`data: ${block}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// One pass over listings+bids → floor / listedCount / bidCount / topBid per tick.
function perTickMarket() {
  const m = {};
  const get = (t) => (m[t] ??= { listedCount: 0, bidCount: 0, floor: null, topBid: null });
  const cheaper = (a, b) => BigInt(a.price) * BigInt(b.amt) < BigInt(b.price) * BigInt(a.amt);
  for (const l of Object.values(state.listings)) {
    if (l.chainStatus !== "active" || !l.tick) continue;
    const e = get(l.tick);
    e.listedCount++;
    if (!e.floor || cheaper(l, e.floor)) e.floor = { price: l.price, amt: l.amt };
  }
  for (const b of Object.values(state.bids)) {
    if (b.chainStatus !== "open" || !b.tick) continue;
    const e = get(b.tick);
    e.bidCount++;
    if (!e.topBid || cheaper(e.topBid, b)) e.topBid = { price: b.price, amt: b.amt };
  }
  return m;
}

function tickSummary(tick, mkt) {
  const t = state.ticks[tick];
  const e = (mkt && mkt[tick]) || {};
  return {
    tick, ...t,
    holders: Object.keys(state.balances[tick] || {}).length,
    soldOut: t.totalMints >= t.maxMints,
    volumeWei: t.volumeWei || "0",
    tradeCount: t.tradeCount || 0,
    floor: e.floor || null,
    topBid: e.topBid || null,
    listedCount: e.listedCount || 0,
    bidCount: e.bidCount || 0,
  };
}

/// Exchange-style order book for one tick: active sell orders (asks) sorted by
/// unit price (price/amt) ascending, with cumulative depth, plus recent trades
/// and summary stats. Unit-price ordering is exact via BigInt cross-multiply.
function marketBook(tick) {
  const asks = Object.entries(state.listings)
    .filter(([, l]) => l.tick === tick && l.chainStatus === "active")
    .map(([id, l]) => ({ id: Number(id), seller: l.seller, amt: l.amt, price: l.price, listTx: l.listTx, block: l.block }));
  asks.sort((a, b) => {
    const l = BigInt(a.price) * BigInt(b.amt);
    const r = BigInt(b.price) * BigInt(a.amt);
    return l < r ? -1 : l > r ? 1 : a.id - b.id;
  });
  let cum = 0n;
  for (const a of asks) {
    cum += BigInt(a.amt);
    a.cumAmt = cum.toString();
  }
  // open bids (buy orders), best (highest unit price) first
  const bids = Object.entries(state.bids)
    .filter(([, b]) => b.tick === tick && b.chainStatus === "open")
    .map(([id, b]) => ({ id: Number(id), bidder: b.bidder, amt: b.amt, price: b.price, escrow: b.escrow }));
  bids.sort((a, b) => {
    const l = BigInt(a.price) * BigInt(b.amt);
    const r = BigInt(b.price) * BigInt(a.amt);
    return l > r ? -1 : l < r ? 1 : a.id - b.id;
  });
  let bidCum = 0n;
  for (const bd of bids) {
    bidCum += BigInt(bd.amt);
    bd.cumAmt = bidCum.toString();
  }

  const trades = state.recentTrades.filter((t) => t.tick === tick).slice(0, 400);
  return {
    tick,
    asks,
    bids,
    trades,
    listedCount: asks.length,
    bidCount: bids.length,
    totalForSale: cum.toString(),
    totalBidAmt: bidCum.toString(),
    floor: asks[0] ? { price: asks[0].price, amt: asks[0].amt } : null,
    topBid: bids[0] ? { price: bids[0].price, amt: bids[0].amt } : null,
    last: trades[0] ? { price: trades[0].price, amt: trades[0].amt } : null,
  };
}

const TICK_RE = /^[a-z0-9]{1,8}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

function startServer() {
  const pub = path.join(DIR, "public");
  // Never let a request kill the process — the scanner lives here too.
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res);
    } catch (err) {
      try {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"bad request"}');
      } catch {}
    }
  });
  server.on("clientError", (err, socket) => socket.destroy());

  function handleRequest(req, res) {
    const url = new URL(req.url, "http://localhost");
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(obj));
    };
    const p = url.pathname;

    if (p === "/api/status") {
      json(200, {
        hub: HUB, market: MARKET, lastBlock: state.lastBlock,
        tickCount: Object.keys(state.ticks).length, recentMints: state.recentMints.slice(0, 30),
      });
    } else if (p === "/api/ticks") {
      const mkt = perTickMarket();
      json(200, { ticks: Object.keys(state.ticks).map((t) => tickSummary(t, mkt)).sort((a, b) => b.deployBlock - a.deployBlock) });
    } else if (p === "/api/activity") {
      const type = url.searchParams.get("type");
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20));
      const filtered = state.recentActivity.filter((a) => !type || a.type === type);
      json(200, { activity: filtered.slice(offset, offset + limit), total: filtered.length });
    } else if (p === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache",
        connection: "keep-alive", "access-control-allow-origin": "*",
      });
      res.write(`data: ${state.lastBlock}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    } else if (p.startsWith("/api/tick/") && p.endsWith("/holders")) {
      const tick = p.split("/")[3];
      if (!TICK_RE.test(tick) || !state.ticks[tick]) return json(404, { error: "unknown tick" });
      const holders = Object.entries(state.balances[tick] || {})
        .map(([address, balance]) => ({ address, balance }))
        .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1)).slice(0, 100);
      json(200, { holders });
    } else if (p.startsWith("/api/tick/")) {
      const tick = p.split("/")[3];
      if (!TICK_RE.test(tick) || !state.ticks[tick]) return json(404, { error: "unknown tick" });
      json(200, {
        ...tickSummary(tick),
        recentMints: state.recentMints.filter((m) => m.tick === tick).slice(0, 20),
      });
    } else if (p.startsWith("/api/market/")) {
      const tick = p.split("/")[3];
      if (!TICK_RE.test(tick) || !state.ticks[tick]) return json(404, { error: "unknown tick" });
      json(200, marketBook(tick));
    } else if (p.startsWith("/api/balances/")) {
      const addr = p.slice("/api/balances/".length).toLowerCase();
      if (!ADDR_RE.test(addr)) return json(400, { error: "bad address" });
      const out = {};
      for (const tick of Object.keys(state.ticks)) {
        const b = state.balances[tick]?.[addr];
        if (b) out[tick] = b;
      }
      json(200, { address: addr, balances: out });
    } else if (p === "/api/listings") {
      const tick = url.searchParams.get("tick");
      const status = url.searchParams.get("status");
      const items = Object.entries(state.listings)
        .map(([id, l]) => ({ id: Number(id), ...l }))
        .filter((l) => (!tick || l.tick === tick) && (!status || l.chainStatus === status))
        .sort((a, b) => b.id - a.id).slice(0, 200);
      json(200, { listings: items });
    } else if (p === "/api/bids") {
      const addr = (url.searchParams.get("bidder") || "").toLowerCase();
      const items = Object.entries(state.bids)
        .map(([id, b]) => ({ id: Number(id), ...b }))
        .filter((b) => !addr || b.bidder === addr)
        .sort((a, b) => b.id - a.id).slice(0, 200);
      json(200, { bids: items });
    } else if (p === "/api/oracle/pending") {
      // listings to confirm: on-chain Pending w/ valid escrow.
      // bids to settle: on-chain Open w/ a valid accept escrow (→ settleBid(id, accepter)).
      const confirmable = Object.entries(state.listings)
        .filter(([, l]) => l.chainStatus === "pending" && l.escrow === "valid")
        .map(([id]) => Number(id));
      const settleable = Object.entries(state.bids)
        .filter(([, b]) => b.chainStatus === "open" && b.escrow === "valid" && b.accepter)
        .map(([id, b]) => ({ id: Number(id), seller: b.accepter }));
      json(200, { confirmable, settleable });
    } else {
      // static web app
      const file = p === "/" ? "index.html" : p.replace(/^\//, "");
      const full = path.join(pub, path.normalize(file));
      if (!full.startsWith(pub) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return json(404, { error: "not found" });
      }
      const mime = full.endsWith(".html") ? "text/html; charset=utf-8"
        : full.endsWith(".js") ? "text/javascript" : full.endsWith(".css") ? "text/css"
        : full.endsWith(".svg") ? "image/svg+xml"
        : full.endsWith(".png") ? "image/png"
        : full.endsWith(".jpg") || full.endsWith(".jpeg") ? "image/jpeg"
        : full.endsWith(".webp") ? "image/webp"
        : full.endsWith(".ico") ? "image/x-icon" : "application/octet-stream";
      // code/markup: always revalidate so deploys take effect immediately (no
      // stale JS/CSS from the browser cache). Images can be cached briefly.
      const cache = /\.(png|jpg|jpeg|webp|ico|svg)$/.test(full) ? "public, max-age=3600" : "no-cache";
      res.writeHead(200, { "content-type": mime, "cache-control": cache });
      res.end(fs.readFileSync(full));
    }
  }

  server.listen(cfg.port || 3000, () => console.log(`rob-20 platform on http://localhost:${cfg.port || 3000}`));
}

// ---- main ----
console.log(`rob-20 indexer — hub ${HUB}, market ${MARKET}, rpc ${RPC_URL}, from block ${state.lastBlock + 1}`);
if (ONCE) {
  await scanToTarget();
  saveState();
  console.log("done (--once)");
} else {
  startServer();
  for (;;) {
    try {
      await scanToTarget();
    } catch (err) {
      console.error("scan error:", err.message);
      // A block may have been half-applied in memory before the error —
      // rewind to the last durable checkpoint so the retry can't double-apply.
      reloadFromCheckpoint();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
