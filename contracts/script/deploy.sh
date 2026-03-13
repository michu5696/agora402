#!/usr/bin/env bash
# Deploy PayCrowEscrow to Base Sepolia
# Usage: ./deploy.sh
#
# Required environment variables (set in ../.env):
#   PRIVATE_KEY          — Deployer wallet private key (0x...)
#   ARBITER_ADDRESS      — Address that can resolve disputes
#   TREASURY_ADDRESS     — Address that receives protocol fees
#   BASE_SEPOLIA_RPC_URL — RPC URL (default: https://sepolia.base.org)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$CONTRACTS_DIR")"

# Load .env from project root
if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"

# Validate required env vars
for var in PRIVATE_KEY ARBITER_ADDRESS TREASURY_ADDRESS; do
  if [ -z "${!var:-}" ] || [ "${!var}" = "0x..." ]; then
    echo "Error: $var is not set. Configure it in .env"
    exit 1
  fi
done

echo "=== PayCrow Deployment ==="
echo "Chain:    Base Sepolia"
echo "RPC:      $RPC_URL"
echo "Arbiter:  $ARBITER_ADDRESS"
echo "Treasury: $TREASURY_ADDRESS"
echo "Fee:      200 bps (2%)"
echo ""

# Check deployer balance
DEPLOYER_ADDR=$(cast wallet address "$PRIVATE_KEY" 2>/dev/null)
if [ -n "$DEPLOYER_ADDR" ]; then
  BALANCE=$(cast balance "$DEPLOYER_ADDR" --rpc-url "$RPC_URL" 2>/dev/null || echo "unknown")
  echo "Deployer: $DEPLOYER_ADDR"
  echo "Balance:  $BALANCE wei"
  echo ""
fi

read -p "Deploy? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

cd "$CONTRACTS_DIR"

forge script script/Deploy.s.sol \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --verify \
  -vvv

echo ""
echo "=== Deployment complete ==="
echo "Copy the contract address from above and add to .env:"
echo "  ESCROW_CONTRACT_ADDRESS=0x..."
