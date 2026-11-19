#!/usr/bin/env bash
# Live-data local end-to-end run: anvil + MockUSDC + ArraVault + REAL Gemini markets (no secrets).
# Uses anvil's public, well-known dev mnemonic. Never reuse these keys anywhere real.
#   ./script/e2e-live-gemini.sh      (needs network access to api.gemini.com / ws.gemini.com)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8546}
RPC="http://127.0.0.1:$PORT"
MNEMONIC="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
addr() { cast wallet address --private-key "$1"; }

anvil --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

DEPLOYER=$(key 0); OPERATOR=$(key 1); S1=$(key 2); S2=$(key 3); S3=$(key 4)
LP=$(key 5); BARS="$(key 6),$(key 7),$(key 8),$(key 9)"

forge build --silent
OUT=$(OPERATOR_ADDRESS=$(addr "$OPERATOR") \
  SETTLERS="$(addr "$S1"),$(addr "$S2"),$(addr "$S3")" \
  SETTLER_THRESHOLD=2 DISPUTE_WINDOW_SEC=60 EVENT_CAP_BPS=1000 USE_MOCK_USDC=true \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$DEPLOYER" 2>&1)
VAULT=$(echo "$OUT" | awk '/ArraVault:/ {print $2}')
USDC=$(echo "$OUT" | awk '/MockUSDC:/ {print $2}')
[ -n "$VAULT" ] && [ -n "$USDC" ] || { echo "$OUT"; echo "deploy failed"; exit 1; }
echo "ArraVault $VAULT  MockUSDC $USDC"

cd offchain
RPC_URL="$RPC" CHAIN_ID=31337 VAULT_ADDRESS="$VAULT" USDC_ADDRESS="$USDC" \
  OPERATOR_PRIVATE_KEY="$OPERATOR" SETTLER_PRIVATE_KEYS="$S1,$S2,$S3" \
  LP_PK="$LP" BAR_PKS="$BARS" MOCK_GEMINI=false DRY_RUN=true \
  REGISTRY_PATH="$(mktemp -d)/registry.json" EVIDENCE_DIR="$(mktemp -d)" WS_DEPTH=${WS_DEPTH:-true} \
  node scripts/e2e-live.js
