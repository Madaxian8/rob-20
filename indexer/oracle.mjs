#!/usr/bin/env node
// rob-20 market oracle — confirms listings whose escrow the indexer validated.
// Polls the indexer API and sends InscriptionMarket.confirm(id) via `cast`.
//
// Usage:
//   ORACLE_ACCOUNT=<cast keystore name> node oracle.mjs        # keystore (recommended)
//   ORACLE_PRIVATE_KEY=0x... node oracle.mjs                   # raw key (testing only)
// Optional: API_URL (default http://localhost:3000), RPC_URL, POLL_MS.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH || path.join(DIR, "config.json"), "utf8"));

const API = process.env.API_URL || `http://localhost:${cfg.port || 3000}`;
const RPC = process.env.RPC_URL || cfg.rpcUrl;
const MARKET = cfg.marketAddress;
const POLL_MS = Number(process.env.POLL_MS || 5000);
// Liveness heartbeat: the oracle writes the current epoch-ms after every poll
// cycle. healthcheck.sh alerts if this file goes stale — that catches a process
// that is "running" per systemd but wedged (RPC hang, stuck fetch), which
// Restart=always alone cannot detect.
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || path.join(DIR, "oracle.heartbeat");

const auth = process.env.ORACLE_ACCOUNT
  ? ["--account", process.env.ORACLE_ACCOUNT]
  : process.env.ORACLE_PRIVATE_KEY
    ? ["--private-key", process.env.ORACLE_PRIVATE_KEY]
    : null;
if (!auth) {
  console.error("Set ORACLE_ACCOUNT (cast keystore) or ORACLE_PRIVATE_KEY.");
  process.exit(1);
}

const confirmed = new Set(); // avoid re-sending within this process lifetime

console.log(`rob-20 oracle — market ${MARKET}, api ${API}`);
const settled = new Set(); // bid ids already settled this process lifetime

function castSend(args, doneSet, key, label) {
  try {
    execFileSync("cast", ["send", MARKET, ...args, "--rpc-url", RPC, ...auth], { stdio: "pipe" });
    doneSet.add(key);
    console.log(label);
  } catch (err) {
    const msg = String(err.stderr || err.message);
    if (msg.includes("BadState")) doneSet.add(key); // already confirmed/settled/cancelled on-chain
    else console.error(`${label} failed:`, msg.slice(0, 200));
  }
}

for (;;) {
  try {
    const { confirmable, settleable } = await (await fetch(`${API}/api/oracle/pending`)).json();
    for (const id of confirmable) {
      if (confirmed.has(id)) continue;
      castSend(["confirm(uint256)", String(id)], confirmed, id, `confirmed listing ${id}`);
    }
    for (const { id, seller } of settleable || []) {
      if (settled.has(id)) continue;
      castSend(["settleBid(uint256,address)", String(id), seller], settled, id, `settled bid ${id} → ${seller}`);
    }
  } catch (err) {
    console.error("oracle poll error:", err.message);
  }
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch { /* non-fatal */ }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
