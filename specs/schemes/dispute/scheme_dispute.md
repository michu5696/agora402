# Scheme: `dispute`

## Summary

The `dispute` scheme extends x402 with **post-settlement buyer protection** for agent-to-agent commerce. It enables a buyer agent to escrow funds, verify delivery quality, and initiate dispute resolution when service quality is unsatisfactory — without requiring any changes to the seller's x402 implementation.

While the `exact` scheme settles payments atomically and irreversibly, and the proposed `escrow` scheme holds funds pending usage metering, the `dispute` scheme addresses a different gap: **what happens when an agent pays for a task and the result is wrong, incomplete, or never delivered?**

The scheme introduces three concepts absent from existing x402 schemes:

1. **Delivery verification window** — a configurable period after settlement during which the buyer MAY inspect the result and raise a dispute
2. **Arbiter-mediated resolution** — a designated on-chain arbiter (human, DAO, or automated verifier) that rules on disputes and splits escrowed funds
3. **On-chain reputation** — escrow outcomes (completed, disputed, refunded) are recorded to a reputation registry, creating a persistent trust signal for future transactions

The `dispute` scheme is designed as a **buyer-side overlay**: the seller serves resources via standard x402 (`exact` or `escrow`), while the buyer's agent or facilitator wraps the payment through a dispute-capable escrow contract. This means **zero seller-side changes** are required for adoption.

## Example Use Cases

- **Task completion verification** — an agent hires another agent for a 30-minute research task costing $50 USDC. Funds are escrowed. The buyer agent verifies the output meets quality criteria before releasing payment. If the output is garbage, the buyer disputes.

- **Multi-step workflow protection** — an orchestrator agent pays for a chain of services (transcription → translation → summarization). If any step produces unusable output, the orchestrator disputes that step's escrow rather than losing the entire payment.

- **High-value API calls with quality guarantees** — an agent calls an LLM inference endpoint at $2/request. For a batch of 100 requests, total cost is $200. The agent escrows the full amount and releases incrementally as results pass validation checks.

- **Cross-agent service marketplaces** — a marketplace MCP server routes agent requests to service providers. The marketplace uses the `dispute` scheme to protect buyers, charging a protocol fee on successful resolutions.

## Lifecycle

### Happy Path (no dispute)

```
Buyer Agent                    Escrow Contract               Seller Agent
     │                              │                              │
     │  1. createAndFund()          │                              │
     │  (USDC transferred)          │                              │
     │─────────────────────────────>│                              │
     │                              │                              │
     │  2. Standard x402 request    │                              │
     │─────────────────────────────────────────────────────────────>│
     │                              │                              │
     │  3. x402 response (200 + result)                            │
     │<─────────────────────────────────────────────────────────────│
     │                              │                              │
     │  4. Verify result quality    │                              │
     │  (off-chain)                 │                              │
     │                              │                              │
     │  5. release()                │                              │
     │─────────────────────────────>│  6. Transfer USDC to seller  │
     │                              │─────────────────────────────>│
     │                              │                              │
     │                              │  7. Record reputation        │
     │                              │  (Completed)                 │
```

### Dispute Path

```
Buyer Agent                    Escrow Contract               Arbiter
     │                              │                              │
     │  1-3. (same as happy path)   │                              │
     │                              │                              │
     │  4. Result fails validation  │                              │
     │                              │                              │
     │  5. dispute()                │                              │
     │─────────────────────────────>│  6. Notify arbiter           │
     │                              │─────────────────────────────>│
     │                              │                              │
     │                              │  7. resolve(buyerAmt,        │
     │                              │     sellerAmt)               │
     │                              │<─────────────────────────────│
     │                              │                              │
     │  8. Receive refund portion   │  9. Record reputation        │
     │<─────────────────────────────│  (Disputed)                  │
```

### Expiry Path (seller never delivers)

```
Buyer Agent                    Escrow Contract
     │                              │
     │  1. createAndFund()          │
     │─────────────────────────────>│
     │                              │
     │  ... timelock expires ...    │
     │                              │
     │  2. markExpired()            │
     │─────────────────────────────>│
     │                              │
     │  3. refund()                 │
     │─────────────────────────────>│
     │                              │
     │  4. Full USDC refund         │  5. Record reputation
     │<─────────────────────────────│  (Refunded, no fee)
```

## Relationship to Other Schemes

| Property | `exact` | `escrow` (proposed) | `dispute` |
|---|---|---|---|
| **Settlement** | Immediate, irreversible | Deferred, usage-based | Deferred, quality-gated |
| **Buyer protection** | None | Partial (cap on spend) | Full (dispute + refund) |
| **Dispute resolution** | None | None | Arbiter-mediated split |
| **Reputation tracking** | None | None | On-chain per-outcome |
| **Seller changes required** | N/A (baseline) | Facilitator changes | None (buyer-side overlay) |
| **Fee model** | Facilitator-set | Contract-set | Protocol fee on release/resolve (0% on refund) |
| **Best for** | Instant API calls | Metered/session usage | Tasks, quality-sensitive work |

## Arbiter Model

The `dispute` scheme is **arbiter-agnostic**. The escrow contract designates an arbiter address that MAY be:

- **A human operator** — for high-value disputes requiring judgment
- **A DAO or multisig** — for decentralized governance
- **An automated verifier contract** — for programmatic quality checks (e.g., comparing output hashes, running validation logic on-chain or via oracle)
- **An AI mediator service** — such as the Mediator-Canonizer pattern (see x402 issue #1310)

The arbiter calls `resolve(escrowId, buyerAmount, sellerAmount)` to split the escrowed funds. The split MAY be:
- Full refund to buyer: `resolve(id, amount - fee, 0)`
- Full release to seller: `resolve(id, 0, amount - fee)`
- Partial split: `resolve(id, X, Y)` where `X + Y = amount - fee`

## Reputation System

Every escrow outcome is recorded to an on-chain reputation registry:

| Outcome | Meaning | Fee charged |
|---|---|---|
| `Completed` | Buyer released funds (satisfied) | Yes (protocol fee) |
| `Disputed` | Arbiter resolved a dispute | Yes (protocol fee) |
| `Refunded` | Escrow expired, buyer got refund | No |

Reputation records are queryable per-agent and composable with other trust signals:
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Reputation Registry (`getSummary()`)
- Moltbook karma scores
- x402 settlement history on Base

## Security Considerations

### Fund Safety

- Escrowed USDC is held by the contract, not by any party. Neither buyer, seller, nor arbiter can unilaterally drain funds.
- The contract enforces minimum and maximum escrow amounts ($0.10 – $100 in v1) to prevent dust attacks and limit exposure.
- The arbiter's `resolve()` function enforces that `buyerAmount + sellerAmount = escrowAmount - fee`, preventing over-distribution.

### Replay Prevention

- Each escrow has a unique monotonically increasing `escrowId`.
- State transitions are enforced: `Funded → Released | Disputed`, `Disputed → Resolved`, `Funded → Expired → Refunded`. No state can be revisited.

### Timelock Enforcement

- Escrows MUST specify a timelock duration between 5 minutes and 30 days.
- After expiry, funds can only flow back to the buyer (no fee charged).
- The `markExpired()` function is permissionless — anyone can trigger it after the timelock.

### Arbiter Trust

- The arbiter is a trusted role. In v1, it is set by the contract owner.
- The arbiter cannot access funds from non-disputed escrows.
- Future versions MAY support per-escrow arbiter selection, arbiter staking, or decentralized arbitration pools.

### Buyer-Side Overlay Risk

- Because the `dispute` scheme wraps standard x402 payments, the seller receives payment from the escrow contract (or router), not directly from the buyer. Sellers SHOULD verify that the payment source is a known escrow contract if they wish to enforce delivery-before-release semantics.

## Appendix

### Related Issues and Proposals

- [#839](https://github.com/coinbase/x402/issues/839) — Original escrow scheme proposal
- [#1247](https://github.com/coinbase/x402/issues/1247) — Task delivery escrow for agents (identifies the quality verification gap)
- [#1310](https://github.com/coinbase/x402/issues/1310) — Mediator-Canonizer for canonical dispute resolution
- [#873](https://github.com/coinbase/x402/pull/873) — Escrow scheme for usage-based payments (session model)
- [#1425](https://github.com/coinbase/x402/pull/1425) — Escrow scheme built on Commerce Payments Protocol

### Reference Implementation

- **Escrow contract**: [Agora402Escrow.sol](https://github.com/mcastellano/agora402/blob/main/contracts/src/Agora402Escrow.sol) — deployed on Base mainnet at `0xDcA5E5Dd1E969A4b824adDE41569a5d80A965aDe`
- **Reputation contract**: [Agora402Reputation.sol](https://github.com/mcastellano/agora402/blob/main/contracts/src/Agora402Reputation.sol) — deployed on Base mainnet at `0x9Ea8c817bFDfb15FA50a30b08A186Cb213F11BCC`
- **MCP server**: [agora402](https://www.npmjs.com/package/agora402) — 5 tools for escrow management and trust scoring
- **Test suite**: 66 tests including fuzz testing for state machine transitions and fee calculations
