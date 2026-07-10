#!/usr/bin/env bash
# Robinhood Chain testnet (chain 46630) end-to-end dry-run.
# Deploys Hub+Market, seeds ticks + real on-chain mints/listings/buys/sweep from
# throwaway wallets, and writes indexer/testnet-config.json. The deployer is
# owner+operator. Requires a funded deployer key (~0.01 testnet ETH is plenty).
# NOTE: mint/listing prices are scaled down 10x for the testnet budget
#       (robin mint = 0.0001 ETH here; mainnet launch uses 0.001).
#
# Usage:
#   KEYFILE=/path/to/testnet-deployer.key bash script/testnet-dryrun.sh
set -euo pipefail

RPC="${RPC:-https://rpc.testnet.chain.robinhood.com}"
KEYFILE="${KEYFILE:?set KEYFILE to the deployer private-key file}"
KEY="$(cat "$KEYFILE")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXPLORER="https://explorer.testnet.chain.robinhood.com"
cd "$ROOT"

DEPLOYER="$(cast wallet address --private-key "$KEY")"
echo "▸ deployer / owner / operator: $DEPLOYER"
echo "▸ balance: $(cast to-unit "$(cast balance "$DEPLOYER" --rpc-url "$RPC")" ether) ETH"
echo

send() { cast send --rpc-url "$RPC" --private-key "$1" --json "${@:2}" \
  | node -e 'process.stdin.on("data",d=>{const r=JSON.parse(d);console.error("  tx "+r.transactionHash+"  block "+parseInt(r.blockNumber)+"  status "+r.status)})'; }
hexdata() { node -e 'console.log("0x"+Buffer.from(process.argv[1],"utf8").toString("hex"))' "$1"; }

echo "== 1. deploy contracts =="
START_BLOCK="$(cast block-number --rpc-url "$RPC")"
HUB="$(forge create src/InscriptionHub.sol:InscriptionHub --rpc-url "$RPC" --private-key "$KEY" --broadcast 2>&1 | grep -i "Deployed to:" | awk '{print $3}')"
echo "  InscriptionHub:    $HUB"
MARKET="$(forge create src/InscriptionMarket.sol:InscriptionMarket --rpc-url "$RPC" --private-key "$KEY" --broadcast --constructor-args "$DEPLOYER" "$DEPLOYER" 2>&1 | grep -i "Deployed to:" | awk '{print $3}')"
echo "  InscriptionMarket: $MARKET"
[ -n "$HUB" ] && [ -n "$MARKET" ] || { echo "deploy failed"; exit 1; }
echo

echo "== 2. genesis + free ticks =="
send "$KEY" "$HUB" "deployTick(string,uint64,uint128,uint32,uint128)" robin 21000 1000 10 100000000000000  # 0.0001 ETH
send "$KEY" "$HUB" "deployTick(string,uint64,uint128,uint32,uint128)" test 100 500 20 0                    # free
echo

echo "== 3. fund two test wallets =="
S1_KEY="$(cast wallet new --json | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d)[0].private_key))')"
S2_KEY="$(cast wallet new --json | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d)[0].private_key))')"
S1="$(cast wallet address --private-key "$S1_KEY")"; S2="$(cast wallet address --private-key "$S2_KEY")"
send "$KEY" "$S1" --value 0.002ether
send "$KEY" "$S2" --value 0.002ether
echo "  wallet A: $S1"
echo "  wallet B: $S2"
echo

echo "== 4. mints (real on-chain, exact fee) =="
MINT_ROBIN="$(hexdata 'data:,{"p":"rob-20","op":"mint","tick":"robin","amt":"1000"}')"
MINT_TEST="$(hexdata 'data:,{"p":"rob-20","op":"mint","tick":"test","amt":"500"}')"
for i in 1 2 3; do send "$S1_KEY" "$HUB" --value 0.0001ether "$MINT_ROBIN"; done  # A: 3x robin -> 3000
for i in 1 2; do send "$S2_KEY" "$HUB" --value 0.0001ether "$MINT_ROBIN"; done      # B: 2x robin -> 2000
send "$S1_KEY" "$HUB" "$MINT_TEST"                                                  # A: 1x free test
echo

echo "== 5. listings + operator confirm =="
send "$S1_KEY" "$MARKET" "$(hexdata 'data:,{"p":"rob-20","op":"list","tick":"robin","amt":"1000","price":"200000000000000"}')"  # id1 0.0002
send "$S2_KEY" "$MARKET" "$(hexdata 'data:,{"p":"rob-20","op":"list","tick":"robin","amt":"1000","price":"180000000000000"}')"  # id2 0.00018
send "$KEY" "$MARKET" "confirm(uint256)" 1
send "$KEY" "$MARKET" "confirm(uint256)" 2
echo

echo "== 6. buy single + sweep (real ETH) =="
# deployer buys cheapest single (id2 0.00018): +5% = 0.000189
send "$KEY" "$MARKET" "buy(uint256)" 2 --value 189000000000000
# two more listings, then sweep both in one tx
send "$S1_KEY" "$MARKET" "$(hexdata 'data:,{"p":"rob-20","op":"list","tick":"robin","amt":"1000","price":"150000000000000"}')"  # id3 0.00015
send "$S2_KEY" "$MARKET" "$(hexdata 'data:,{"p":"rob-20","op":"list","tick":"robin","amt":"1000","price":"160000000000000"}')"  # id4 0.00016
send "$KEY" "$MARKET" "confirm(uint256)" 3
send "$KEY" "$MARKET" "confirm(uint256)" 4
# sweep id3+id4: (0.00015+0.00016)*1.05 = 0.0003255
send "$KEY" "$MARKET" "sweep(uint256[])" "[3,4]" --value 325500000000000
echo

echo "== 6b. bids: place -> accept -> settle, and place -> cancel =="
# deployer bids to buy 1000 robin @ 0.0001 (escrow +5% = 0.000105)
send "$KEY" "$MARKET" "placeBid(string,uint128,uint128)" robin 1000 100000000000000 --value 105000000000000  # bid 1
# wallet A (holds robin) accepts by sending the accept inscription to the bidder (deployer)
send "$S1_KEY" "$DEPLOYER" "$(hexdata 'data:,{"p":"rob-20","op":"accept","tick":"robin","bid":"1"}')"
# operator (deployer) settles bid 1 to wallet A → A paid, deployer credited the robin in the ledger
send "$KEY" "$MARKET" "settleBid(uint256,address)" 1 "$S1"
# place bid 2 and cancel it (full refund)
send "$KEY" "$MARKET" "placeBid(string,uint128,uint128)" robin 500 80000000000000 --value 84000000000000  # bid 2
send "$KEY" "$MARKET" "cancelBid(uint256)" 2
echo

echo "== 7. write indexer/testnet-config.json =="
cat > indexer/testnet-config.json <<EOF
{
  "rpcUrl": "$RPC",
  "hubAddress": "$HUB",
  "marketAddress": "$MARKET",
  "deployBlock": $START_BLOCK,
  "confirmations": 2,
  "batchBlocks": 500,
  "pollMs": 3000,
  "port": 3000,
  "stateFile": "testnet-state.json",
  "eventsFile": "testnet-events.jsonl"
}
EOF
echo "  wrote indexer/testnet-config.json (deployBlock $START_BLOCK)"
echo
echo "✅ dry-run txs submitted."
echo "   Hub    $EXPLORER/address/$HUB"
echo "   Market $EXPLORER/address/$MARKET"
