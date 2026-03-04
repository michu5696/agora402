# paycrow

The trust layer for agent-to-agent commerce. Escrow protection for x402 payments on Base.

Agents pay for API calls with USDC via [x402](https://x402.org). But payments are final — no refunds, no disputes, no recourse. **paycrow** fixes this by routing payments through on-chain escrow: funds are locked until delivery is verified, then released automatically.

Install as an MCP server. Your agent gets escrow-protected payments in one tool call.

## Quick Start

### 1. Generate a wallet

```bash
npx paycrow init
```

This creates a fresh wallet and prints your Claude Desktop config — copy-paste and go.

### 2. Fund it

Send a small amount of ETH (for gas, ~$0.50) and USDC (for payments) to the printed address on **Base**.

### 3. Add to Claude Desktop

```json
{
  "mcpServers": {
    "paycrow": {
      "command": "npx",
      "args": ["paycrow"],
      "env": {
        "PRIVATE_KEY": "0x_YOUR_KEY_FROM_INIT"
      }
    }
  }
}
```

Restart Claude Desktop. Done — your agent now has escrow-protected payments.

### Any MCP Client

```bash
PRIVATE_KEY=0x... npx paycrow
```

Runs over stdio. Compatible with any MCP client (Claude Desktop, Claude Code, Cursor, Windsurf, OpenClaw, etc).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | **Yes** | Wallet private key (hex, with 0x prefix) |
| `CHAIN` | No | `"base"` for mainnet, defaults to Base Sepolia |
| `BASE_RPC_URL` | No | Custom RPC URL for Base mainnet |
| `BASE_SEPOLIA_RPC_URL` | No | Custom RPC URL for Base Sepolia |

Contract addresses are hardcoded — no need to configure them.

## Tools

### `x402_protected_call` — Flagship

Make an API call with automatic escrow protection. One tool call does everything:

1. Creates USDC escrow on-chain
2. Calls the API
3. Verifies the response (JSON Schema or hash-lock)
4. Auto-releases payment if valid, auto-disputes if not

```
Parameters:
  url               — API endpoint to call
  seller_address    — Ethereum address of the API provider
  amount_usdc       — Payment amount ($0.10 - $100)
  method            — GET, POST, PUT, DELETE (default: GET)
  headers           — HTTP headers (optional)
  body              — Request body for POST/PUT (optional)
  verification_strategy — "schema" or "hash-lock" (default: schema)
  verification_data — JSON Schema string or expected response hash
  timelock_minutes  — Auto-refund timeout, 5-43200 min (default: 30)
```

### `escrow_create`

Create a USDC escrow manually for any agent-to-agent transaction.

### `escrow_release`

Confirm delivery and release funds to the seller.

### `escrow_dispute`

Flag bad delivery. Locks funds for arbiter review.

### `escrow_status`

Check the current state of an escrow.

### `trust_score_query`

Look up any agent's on-chain trust score before transacting. Reads the PayCrow Reputation contract — scores are 0-100 based on real escrow history, not self-reported.

Returns: score, success rate, volume, timestamps, recommendation (high_trust / moderate_trust / low_trust).

## How It Works

```
Agent (buyer) ──→ paycrow MCP Server ──→ Escrow Contract (Base L2)
                        │                        │
                  Verify response          USDC held until
                  (schema/hash)            delivery confirmed
                        │                        │
                   Auto-release ←─── Verification passes
                   Auto-dispute ←─── Verification fails
```

**Escrow lifecycle:**

```
FUNDED → RELEASED         (delivery confirmed, seller paid minus 2% fee)
       → DISPUTED → RESOLVED  (arbiter rules: splits funds)
       → EXPIRED → REFUNDED   (timeout: full refund, no fee)
```

- 2% protocol fee on release/resolve. Zero fee on refund.
- $0.10 minimum, $100 maximum per escrow (v1 safety cap).
- Timelock: 5 minutes to 30 days.
- On-chain reputation auto-recorded for every escrow outcome.

## Chain

| | Testnet | Mainnet |
|-|---------|---------|
| **Network** | Base Sepolia | Base |
| **USDC** | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **Gas cost** | ~$0.005/escrow cycle | ~$0.005/escrow cycle |

Set `CHAIN=base` for mainnet. Defaults to Base Sepolia.

## Contract

Solidity smart contracts with:
- Escrow: full 7-state machine with 2% protocol fee
- Reputation: on-chain trust scores based on escrow history
- OpenZeppelin ReentrancyGuard + Pausable
- 135 tests (unit + fuzz + invariant + integration)

Source: [github.com/michu5696/paycrow](https://github.com/michu5696/paycrow)

## License

MIT
