#!/usr/bin/env bash
# Robinhood Chain MAINNET (chain 4663) deploy runbook for rob-20.
#
# Deploys InscriptionHub + InscriptionMarket, (optionally) the genesis "robin"
# tick, verifies source on Blockscout, and writes indexer/config.production.json
# with the live addresses + deploy block. THIS SPENDS REAL ETH.
#
# Safety: does NOTHING that costs money unless you pass CONFIRM=yes. Without it,
# the script only runs preflight checks and prints the plan (a dry run).
#
# Required:
#   KEYFILE   path to the deployer private-key file (funded with mainnet ETH)
#   OWNER     platform fee recipient (a COLD wallet — never goes on the server)
#   OPERATOR  oracle hot-wallet address (the one in /etc/rob20/oracle.env)
# Optional:
#   RPC             mainnet RPC (default: dRPC keyed endpoint)
#   DEPLOY_GENESIS  1 to also deploy the "robin" genesis tick (default 0)
#   VERIFY          1 to verify contracts on Blockscout (default 1)
#   CONFIRM         yes to actually broadcast (default: dry run only)
#
# Usage (dry run first, ALWAYS):
#   KEYFILE=~/.keys/mainnet-deployer.key OWNER=0xCold OPERATOR=0xHot bash script/deploy-mainnet.sh
# Then, when the plan looks right:
#   CONFIRM=yes KEYFILE=... OWNER=0xCold OPERATOR=0xHot DEPLOY_GENESIS=1 bash script/deploy-mainnet.sh
set -euo pipefail

RPC="${RPC:-https://YOUR_DRPC_ENDPOINT}"
EXPECTED_CHAIN=4663
EXPLORER="https://robinhoodchain.blockscout.com"
DEPLOY_GENESIS="${DEPLOY_GENESIS:-0}"
VERIFY="${VERIFY:-1}"
CONFIRM="${CONFIRM:-no}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${KEYFILE:?set KEYFILE to the funded mainnet deployer key file}"
: "${OWNER:?set OWNER to the platform fee recipient (cold wallet)}"
: "${OPERATOR:?set OPERATOR to the oracle hot-wallet address}"
KEY="$(cat "$KEYFILE")"
DEPLOYER="$(cast wallet address --private-key "$KEY")"

echo "======================= rob-20 MAINNET deploy ======================="
echo "  RPC:       $RPC"
echo "  deployer:  $DEPLOYER"
echo "  owner:     $OWNER   (fee recipient — keep cold, never on server)"
echo "  operator:  $OPERATOR   (oracle hot wallet)"
echo "  genesis:   $([ "$DEPLOY_GENESIS" = 1 ] && echo 'yes — robin 21000×1000, 10/wallet, 0.001 ETH' || echo 'no')"
echo "====================================================================="

# ---- preflight (always runs, costs nothing) ----
echo "▸ preflight"
chain="$(cast chain-id --rpc-url "$RPC")"
[ "$chain" = "$EXPECTED_CHAIN" ] || { echo "✗ RPC chain-id is $chain, expected $EXPECTED_CHAIN (mainnet). Aborting."; exit 1; }
echo "  chain-id OK: $chain"
balWei="$(cast balance "$DEPLOYER" --rpc-url "$RPC")"
echo "  deployer balance: $(cast to-unit "$balWei" ether) ETH"
# ~0.01 ETH is plenty for two deploys on an L2; warn if under.
min="10000000000000000"
[ "$(node -e "process.stdout.write(BigInt('$balWei')<BigInt('$min')?'1':'0')")" = 1 ] && \
  echo "  ⚠ balance looks low (<0.01 ETH) — top up before broadcasting."
[ "$OWNER" = "$DEPLOYER" ] && echo "  ⚠ OWNER == deployer. Fees will accrue to the deployer key. Prefer a separate COLD wallet."
[ "$OPERATOR" = "$OWNER" ] && echo "  ⚠ OPERATOR == OWNER. The oracle hot wallet should NOT be the fee/cold wallet."

if [ "$CONFIRM" != "yes" ]; then
  echo
  echo "DRY RUN — nothing broadcast. Re-run with CONFIRM=yes to deploy for real."
  exit 0
fi

# ---- broadcast (real money) ----
echo "▸ deploying (broadcasting to mainnet)…"
START_BLOCK="$(cast block-number --rpc-url "$RPC")"
echo "  start block: $START_BLOCK"

verify_args=()
[ "$VERIFY" = 1 ] && verify_args=(--verify --verifier blockscout --verifier-url "$EXPLORER/api")

HUB="$(forge create src/InscriptionHub.sol:InscriptionHub \
  --rpc-url "$RPC" --private-key "$KEY" --broadcast "${verify_args[@]}" 2>&1 \
  | tee /dev/stderr | grep -i "Deployed to:" | awk '{print $3}')"
[ -n "$HUB" ] || { echo "✗ Hub deploy failed"; exit 1; }
echo "  InscriptionHub:    $HUB"

MARKET="$(forge create src/InscriptionMarket.sol:InscriptionMarket \
  --rpc-url "$RPC" --private-key "$KEY" --broadcast --constructor-args "$OWNER" "$OPERATOR" "${verify_args[@]}" 2>&1 \
  | tee /dev/stderr | grep -i "Deployed to:" | awk '{print $3}')"
[ -n "$MARKET" ] || { echo "✗ Market deploy failed"; exit 1; }
echo "  InscriptionMarket: $MARKET"

if [ "$DEPLOY_GENESIS" = 1 ]; then
  echo "▸ deploying genesis tick 'robin' (21000×1000, 10/wallet, 0.001 ETH)…"
  cast send "$HUB" "deployTick(string,uint64,uint128,uint32,uint128)" \
    robin 21000 1000 10 1000000000000000 --rpc-url "$RPC" --private-key "$KEY" >/dev/null
  echo "  genesis tick deployed"
fi

# ---- write production config ----
CFG="indexer/config.production.json"
echo "▸ writing $CFG (hub/market/deployBlock)…"
node -e '
  const fs=require("fs");
  const f="'"$CFG"'";
  const base=JSON.parse(fs.readFileSync("indexer/config.mainnet.json","utf8"));
  base.hubAddress="'"$HUB"'";
  base.marketAddress="'"$MARKET"'";
  base.deployBlock=Number("'"$START_BLOCK"'");
  delete base._comment;
  fs.writeFileSync(f, JSON.stringify(base,null,2)+"\n");
  console.log("  wrote",f);
'

cat <<EOF

================= DEPLOYED =================
  InscriptionHub:    $HUB
  InscriptionMarket: $MARKET
  owner (fees):      $OWNER
  operator (oracle): $OPERATOR
  deployBlock:       $START_BLOCK
  explorer:          $EXPLORER/address/$MARKET
===========================================

Next steps:
  1) Upload the config to the server:
       scp -i ~/.ssh/rob20_server_ed25519 indexer/config.production.json \\
         root@<your-server>:/opt/rob20/indexer/config.production.json
  2) Point monitor.env RPC at mainnet and set ORACLE_ADDR=$OPERATOR:
       ssh ... 'sed -i "s|^RPC=.*|RPC=$RPC|;s|^ORACLE_ADDR=.*|ORACLE_ADDR=$OPERATOR|" /etc/rob20/monitor.env'
  3) Fund the operator hot wallet ($OPERATOR) with gas (≥0.05 ETH recommended).
  4) Reset indexer state for the new chain and restart the stack:
       ssh ... 'systemctl stop rob20-indexer rob20-oracle; \\
                 rm -f /opt/rob20/indexer/state.json /opt/rob20/indexer/events.jsonl; \\
                 systemctl start rob20-indexer rob20-oracle'
  5) Verify: curl http://127.0.0.1:3000/api/status  (hub/market should match above)
EOF
