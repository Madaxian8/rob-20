#!/usr/bin/env bash
# Health check for the rob-20 stack. Alerts (exit 1 + optional webhook) when:
#   - the indexer API is down
#   - the indexer has fallen too far behind the chain head (stuck/crashed scan)
#   - the oracle systemd service is not active
#   - there are confirmable listings / settleable bids piling up (oracle stalled)
# Run from cron every minute:
#   * * * * * /opt/rob20/ops/healthcheck.sh || curl -s -X POST "$SLACK_WEBHOOK" ...
set -uo pipefail

API="${API:-http://127.0.0.1:3000}"
RPC="${RPC:-https://YOUR_DRPC_ENDPOINT}"
MAX_LAG="${MAX_LAG:-30}"          # blocks behind head before alerting
MAX_PENDING="${MAX_PENDING:-25}"  # confirmable+settleable backlog before alerting
WEBHOOK="${WEBHOOK:-}"
HEARTBEAT_FILE="${HEARTBEAT_FILE:-/opt/rob20/indexer/oracle.heartbeat}"
MAX_HEARTBEAT_AGE="${MAX_HEARTBEAT_AGE:-90}"   # seconds since oracle last looped
ORACLE_ADDR="${ORACLE_ADDR:-}"                 # oracle hot wallet; set to enable gas check
MIN_GAS_WEI="${MIN_GAS_WEI:-5000000000000000}" # 0.005 ETH — alert when oracle can't pay gas

fail() { echo "UNHEALTHY: $1"; [ -n "$WEBHOOK" ] && curl -s -X POST -H 'content-type: application/json' -d "{\"text\":\"rob-20 UNHEALTHY: $1\"}" "$WEBHOOK" >/dev/null 2>&1; exit 1; }

status="$(curl -sf --max-time 8 "$API/api/status")" || fail "indexer API down"
lastBlock="$(echo "$status" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).lastBlock))')"

head_hex="$(curl -sf --max-time 8 -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).result))')" || fail "RPC unreachable"
head=$((head_hex))
lag=$((head - lastBlock))
[ "$lag" -gt "$MAX_LAG" ] && fail "indexer lag $lag blocks (head $head, indexed $lastBlock)"

if command -v systemctl >/dev/null; then
  systemctl is-active --quiet rob20-oracle || fail "oracle service not active"
fi

pending="$(curl -sf --max-time 8 "$API/api/oracle/pending" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log((j.confirmable?.length||0)+(j.settleable?.length||0))})')" || pending=0
[ "$pending" -gt "$MAX_PENDING" ] && fail "oracle backlog: $pending pending (confirm+settle) — oracle stalled?"

# Oracle heartbeat freshness — catches a wedged (running-but-not-looping) oracle
# that systemd's Restart=always cannot see.
hb_age="n/a"
if [ -f "$HEARTBEAT_FILE" ]; then
  hb_ms="$(cat "$HEARTBEAT_FILE" 2>/dev/null)"
  now_ms=$(( $(date +%s) * 1000 ))
  hb_age=$(( (now_ms - ${hb_ms:-0}) / 1000 ))
  [ "$hb_age" -gt "$MAX_HEARTBEAT_AGE" ] && fail "oracle heartbeat stale (${hb_age}s > ${MAX_HEARTBEAT_AGE}s) — oracle wedged?"
else
  fail "oracle heartbeat file missing ($HEARTBEAT_FILE) — oracle not running?"
fi

# Oracle wallet gas balance — an out-of-gas oracle fails silently (tx never lands).
gas="skip"
if [ -n "$ORACLE_ADDR" ] && command -v cast >/dev/null; then
  bal="$(cast balance "$ORACLE_ADDR" --rpc-url "$RPC" 2>/dev/null)" || bal=""
  if [ -n "$bal" ]; then
    gas="$bal"
    # bash can't compare 18-digit wei natively; use node for the big-int compare
    low="$(node -e "process.stdout.write(BigInt('$bal') < BigInt('$MIN_GAS_WEI') ? '1':'0')" 2>/dev/null || echo 0)"
    [ "$low" = "1" ] && fail "oracle wallet low on gas: $bal wei < $MIN_GAS_WEI (top up $ORACLE_ADDR)"
  fi
fi

echo "OK  head=$head indexed=$lastBlock lag=$lag pending=$pending hb=${hb_age}s gas=$gas"
