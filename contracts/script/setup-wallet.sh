#!/usr/bin/env bash
# Generate a fresh wallet for Base Sepolia testing
# Usage: ./setup-wallet.sh
#
# After running:
# 1. Fund with testnet ETH: https://www.alchemy.com/faucets/base-sepolia
# 2. Fund with testnet USDC: https://faucet.circle.com/
# 3. Copy the private key to your .env file

set -euo pipefail

echo "=== Agora402 Wallet Setup ==="
echo ""

# Generate wallet
WALLET=$(cast wallet new 2>/dev/null)
ADDRESS=$(echo "$WALLET" | grep "Address" | awk '{print $2}')
PRIVATE_KEY=$(echo "$WALLET" | grep "Private key" | awk '{print $3}')

echo "New wallet generated:"
echo ""
echo "  Address:     $ADDRESS"
echo "  Private Key: $PRIVATE_KEY"
echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Get testnet ETH (for gas):"
echo "   https://www.alchemy.com/faucets/base-sepolia"
echo "   https://docs.base.org/docs/tools/network-faucets/"
echo ""
echo "2. Get testnet USDC:"
echo "   https://faucet.circle.com/"
echo "   Select 'Base Sepolia' and paste: $ADDRESS"
echo ""
echo "3. Add to your .env file:"
echo ""
echo "   PRIVATE_KEY=$PRIVATE_KEY"
echo "   ARBITER_ADDRESS=$ADDRESS"
echo "   TREASURY_ADDRESS=$ADDRESS"
echo ""
echo "   (For testing, you can use the same address for all three."
echo "    In production, use separate addresses.)"
echo ""
echo "4. Deploy:"
echo "   cd contracts && ./script/deploy.sh"
