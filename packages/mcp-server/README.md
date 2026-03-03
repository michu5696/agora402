# agora402

The trust layer for agent-to-agent commerce. Escrow protection for x402 payments on Base.

Agents pay for API calls with USDC via [x402](https://x402.org). But payments are final — no refunds, no disputes, no recourse. **agora402** fixes this by routing payments through on-chain escrow: funds are locked until delivery is verified, then released automatically.

Install as an MCP server. Your agent gets escrow-protected payments in one tool call.

## Quick Start

### Claude Desktop / Claude Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "agora402": {
      "command": "npx",
      "args": ["agora402"],
      "env": {
        "PRIVATE_KEY": "0x_YOUR_WALLET_PRIVATE_KEY",
        "ESCROW_CONTRACT_ADDRESS": "0x_DEPLOYED_CONTRACT_ADDRESS",
        "BASE_SEPOLIA_RPC_URL": "https://sepolia.base.org"
      }
    }
  }
}
```

### Any MCP Client

```bash
npx agora402
```

Runs over stdio. Compatible with any MCP client (Claude Desktop, Claude Code, Cursor, Windsurf, OpenClaw, etc).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Wallet private key (hex, with 0x prefix) |
| `ESCROW_CONTRACT_ADDRESS` | Yes | Deployed Agora402Escrow contract address |
| `BASE_SEPOLIA_RPC_URL` | No | RPC URL (defaults to Base Sepolia) |

## Tools

### `x402_protected_call` — Flagship

Make an API call with automatic escrow protection. One tool call does everything:

1. Creates USDC escrow on-chain
2. Calls the API
3. Verifies the response (schema or hash-lock)
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

```
Parameters:
  seller       — Seller's Ethereum address
  amount_usdc  — Amount in USDC ($0.10 - $100)
  service_url  — URL/identifier of the service
  timelock_minutes — Auto-refund timeout (default: 30)
```

### `escrow_release`

Confirm delivery and release funds to the seller.

```
Parameters:
  escrow_id — The escrow ID to release
```

### `escrow_dispute`

Flag bad delivery. Locks funds for arbiter review.

```
Parameters:
  escrow_id — The escrow ID to dispute
  reason    — Description of the problem
```

### `escrow_status`

Check the current state of an escrow.

```
Parameters:
  escrow_id — The escrow ID to check
```

Returns: state (Funded/Released/Disputed/Resolved/Expired/Refunded), buyer, seller, amount, timestamps.

### `trust_score_query`

Look up any agent's trust score before transacting. Scores are 0-100 based on escrow history.

```
Parameters:
  address — Ethereum address to look up
```

Returns: score, success rate, recommendation (high_trust / moderate_trust / low_trust).

## How It Works

```
Agent (buyer) ──→ agora402 MCP Server ──→ Escrow Contract (Base L2)
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

## Chain

- **Testnet:** Base Sepolia
- **Token:** USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
- **Gas:** ~$0.005 per escrow cycle on Base L2

## Contract

Solidity smart contract with:
- OpenZeppelin ReentrancyGuard + Pausable
- Full state machine (7 states)
- Fuzz-tested (66 tests, 1000 fuzz runs)
- Emergency pause via owner multisig

Source: [contracts/src/Agora402Escrow.sol](https://github.com/TODO/agora402/blob/main/contracts/src/Agora402Escrow.sol)

## License

MIT
