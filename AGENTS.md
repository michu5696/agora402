# PayCrow — Trust Scoring for Autonomous Agents

## What This Service Does

PayCrow provides composite trust scores for Ethereum addresses on Base. Before transacting with another agent, query their trust score to assess risk. The score aggregates 4 independent on-chain and off-chain sources into a single 0-100 rating with confidence levels and per-source breakdown.

## API Endpoint

```
GET https://paycrow.fly.dev/trust/{address}
```

**Payment**: $0.001 USDC on Base (via x402 protocol)
**Network**: `eip155:8453` (Base mainnet)
**Facilitator**: `https://facilitator.xpay.sh`

## x402 Payment Flow

1. `GET /trust/0x...` → Returns `402` with `PAYMENT-REQUIRED` header
2. Sign ERC-3009 USDC authorization using `@x402/fetch` or any x402 client
3. Retry with `PAYMENT-SIGNATURE` header → Returns trust score

## Discovery

```
GET https://paycrow.fly.dev/discovery/resources
```

Returns x402 Bazaar-compatible resource catalog with pricing, schema, and examples.

## Response Format

```json
{
  "address": "0x...",
  "score": 78,
  "confidence": "high",
  "confidencePercent": 83,
  "recommendation": "high_trust",
  "sources": {
    "paycrow": { "score": 85, "totalCompleted": 12, "totalDisputed": 0, "disputeRate": 0 },
    "erc8004": { "registered": true, "feedbackCount": 5, "score": 70 },
    "moltbook": { "found": true, "karma": 450, "score": 62 },
    "baseChain": { "txCount": 89, "walletAgeDays": 145, "score": 71 }
  },
  "sourcesUsed": ["paycrow", "erc8004", "moltbook", "base-chain"]
}
```

When no data is available: `"score": null, "recommendation": "insufficient_data"`.

## Trust Sources

| Source | Weight | What It Measures |
|--------|--------|-----------------|
| PayCrow Reputation | 35% | Escrow completion/dispute history on our contracts |
| ERC-8004 Identity | 25% | Cross-ecosystem agent NFT + feedback |
| Moltbook Social | 15% | Karma, followers, account age on agent social network |
| Base Chain Activity | 15% | Wallet age, tx count, USDC volume, counterparty diversity |

## MCP Integration

Install as an MCP server for direct tool access (no x402 payment required):

```bash
npx paycrow
```

Provides tools: `trust_score_query`, `escrow_create`, `escrow_release`, `escrow_dispute`, `x402_protected_call`.

## Health Check

```
GET https://paycrow.fly.dev/health
```

## Contact

- GitHub: https://github.com/mcastellano/paycrow
- npm: https://www.npmjs.com/package/paycrow
