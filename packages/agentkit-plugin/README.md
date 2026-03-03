# agora402-agentkit

Escrow protection plugin for [Coinbase AgentKit](https://github.com/coinbase/agentkit). Adds on-chain USDC escrow, trust scores, and dispute resolution to any AgentKit agent.

## Install

```bash
npm install agora402-agentkit @coinbase/agentkit
```

## Usage

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { agora402ActionProvider } from "agora402-agentkit";

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    // ... your other providers
    agora402ActionProvider(),
  ],
});
```

That's it. Your agent now has 6 new actions:

| Action | Description |
|--------|-------------|
| `protected_api_call` | **Flagship** — escrow + API call + verify + auto-release/dispute |
| `create_escrow` | Lock USDC in escrow for a transaction |
| `release_escrow` | Confirm delivery, release funds to seller |
| `dispute_escrow` | Flag bad delivery, lock for arbitration |
| `check_escrow` | Check escrow state |
| `check_trust_score` | On-chain trust score lookup (0-100) |

## How it works

AgentKit's built-in x402 provider handles direct payments — but payments are final, with no recourse. This plugin adds the missing protection layer:

```
Agent → agora402 plugin → Escrow Contract (Base L2)
              │                      │
        Verify response        USDC held until
        (JSON Schema)          delivery confirmed
              │                      │
         Auto-release ←── Verification passes
         Auto-dispute ←── Verification fails
```

- 2% protocol fee on release/resolve. Zero fee on refund.
- $0.10 minimum, $100 maximum per escrow.
- On-chain reputation auto-recorded for every outcome.

## Networks

Supports Base Sepolia (default) and Base mainnet. The plugin auto-detects the network from your wallet provider.

## Custom contract addresses

```typescript
agora402ActionProvider({
  escrowAddress: "0x...",
  reputationAddress: "0x...",
  usdcAddress: "0x...",
});
```

## License

MIT
