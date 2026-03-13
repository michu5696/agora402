# paycrow

The trust layer for agent-to-agent commerce. Escrow protection with **real dispute resolution** for x402 payments on Base.

Agents pay for API calls with USDC via [x402](https://x402.org). But payments are final — no refunds, no disputes, no recourse. Every other escrow service says "no disputes, no chargebacks." **PayCrow is different**: funds are locked until delivery is verified, with on-chain dispute resolution if something goes wrong.

Install as an MCP server. Your agent gets trust-informed, escrow-protected payments.

## Quick Start

### 1. Generate a wallet

```bash
npx paycrow init
```

Creates a fresh wallet and prints your Claude Desktop config — copy-paste and go.

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

Restart Claude Desktop. Done.

### Trust-only mode (no wallet needed)

If you only want trust scoring without escrow, skip the wallet setup:

```json
{
  "mcpServers": {
    "paycrow": {
      "command": "npx",
      "args": ["paycrow"]
    }
  }
}
```

`trust_gate` and `trust_score_query` work without `PRIVATE_KEY`. Escrow/payment tools will prompt you to set one up.

### Any MCP Client

```bash
PRIVATE_KEY=0x... npx paycrow
```

Runs over stdio. Compatible with Claude Desktop, Claude Code, Cursor, Windsurf, OpenClaw, etc.

## Tools (9 total)

### `safe_pay` — Recommended

The smart way to pay an agent. Checks their trust score first, then auto-configures escrow protection based on risk.

```
Flow: Check trust → Set protection → Create escrow → Call API → Verify → Release or dispute

Protection levels (automatic):
  High trust agent   → 15min timelock, proceed normally
  Moderate trust     → 60min timelock, $25 cap
  Low trust          → 4hr timelock, $5 cap
  Unknown/caution    → BLOCKED — won't send funds

Parameters:
  url               — API endpoint to call
  seller_address    — Ethereum address of the agent
  amount_usdc       — Payment amount ($0.10 - $100)
  method            — GET, POST, PUT, DELETE (default: GET)
  headers           — HTTP headers (optional)
  body              — Request body (optional)
```

### `trust_gate` — Check Before You Pay

Should you pay this agent? Returns a go/no-go decision with recommended escrow parameters.

```
Parameters:
  address               — Ethereum address to check
  intended_amount_usdc  — How much you plan to pay (optional)

Returns:
  decision              — proceed / proceed_with_caution / do_not_proceed
  escrowParams          — recommended timelock and max amount
  trustScore            — 0-100 score
  warning               — if intended amount exceeds safe limit
```

### `trust_score_query` — Full Breakdown

Full trust score from 4 on-chain sources: PayCrow escrow history (40%), ERC-8004 identity (25%), Moltbook karma (15%), and Base chain activity (20%).

### `trust_onchain_quick` — Free Fast Check

PayCrow reputation only. No API keys needed. Free.

### `x402_protected_call` — Advanced

Manual escrow with full control over verification (JSON Schema or hash-lock) and timelock. Use when `safe_pay`'s automatic protection isn't enough.

### `escrow_create`

Create a USDC escrow with built-in dispute resolution.

### `escrow_release`

Confirm delivery and release funds to the seller.

### `escrow_dispute`

Flag bad delivery. Locks funds for arbiter review — **the only escrow on Base with real dispute resolution**.

### `escrow_status`

Check the current state of an escrow.

## How It Works

```
Agent (buyer) ──→ paycrow ──→ Check trust ──→ Create escrow ──→ Call API
                                                    │
                                              Verify response
                                                    │
                                     ┌──────────────┴──────────────┐
                                 Valid response              Bad response
                                     │                            │
                                Auto-release              Auto-dispute
                              (seller paid)           (arbiter reviews)
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

## Why PayCrow

| Feature | PayCrow | Others |
|---------|---------|--------|
| Escrow | Yes (Base, USDC) | Some |
| **Dispute resolution** | **Yes — on-chain arbiter** | **No — "no disputes, no chargebacks"** |
| Trust scoring | 4 on-chain sources | Limited or none |
| Trust-informed escrow | `safe_pay` auto-protects | Manual only |
| MCP server | 9 tools | 0-1 tools |
| Price | $0.001/trust query | $0.001-0.05 |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | For escrow tools | Wallet private key (hex, with 0x prefix) |
| `CHAIN` | No | `"base"` for mainnet, defaults to Base Sepolia |
| `BASESCAN_API_KEY` | No | For Base chain activity data (free at basescan.org) |
| `MOLTBOOK_APP_KEY` | No | For Moltbook social reputation |
| `BASE_RPC_URL` | No | Custom RPC URL for Base mainnet |

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
- Dispute resolution: arbiter can review and split funds
- OpenZeppelin ReentrancyGuard + Pausable
- 135 tests (unit + fuzz + invariant + integration)

Source: [github.com/michu5696/paycrow](https://github.com/michu5696/paycrow)

## License

MIT
