# Scheme: `dispute` on `EVM`

## Summary

The `dispute` EVM implementation uses two contracts deployed on Base (eip155:8453):

1. **PayCrowEscrow** — holds USDC in escrow with a state machine: `Funded → Released | Disputed → Resolved | Expired → Refunded`. Supports direct buyer funding and router-mediated funding (for transparent x402 integration).

2. **PayCrowReputation** — immutable on-chain ledger recording every escrow outcome per address. Emits `ReputationUpdated` events indexable by any trust scoring system.

The buyer agent signs a standard ERC-3009 `receiveWithAuthorization` to fund the escrow — the same signature primitive used by the `exact` scheme. An authorized **router contract** intercepts the x402 settlement, deposits USDC into escrow instead of directly paying the seller, and returns the escrow ID to the buyer.

## Contract Architecture

```
                                    ┌─────────────────────┐
                                    │   USDC (ERC-20)     │
                                    │ 0x8335...02913      │
                                    └────────┬────────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
           ┌────────▼──────────┐   ┌────────▼──────────┐   ┌────────▼──────────┐
           │ PayCrowEscrow    │   │ PayCrowRouter     │   │  x402 Facilitator │
           │ 0xDcA5...965aDe   │   │ (authorized)       │   │  (Coinbase CDP)   │
           │                   │◄──│                    │◄──│                   │
           │ • createAndFund() │   │ • settleToEscrow() │   │ • settle()        │
           │ • release()       │   └────────────────────┘   └───────────────────┘
           │ • dispute()       │
           │ • resolve()       │──────────┐
           │ • refund()        │          │
           └────────┬──────────┘          │
                    │                     ▼
           ┌────────▼──────────┐   ┌─────────────────────┐
           │ Protocol Treasury │   │ PayCrowReputation   │
           │ (fee receiver)    │   │ 0x9Ea8...11BCC      │
           └───────────────────┘   │                     │
                                   │ • getReputation()   │
                                   │ • getScore()        │
                                   └─────────────────────┘
```

## PaymentRequirements

When a resource server supports the `dispute` scheme, the `402` response includes:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "dispute",
      "network": "eip155:8453",
      "maxAmountRequired": "5000000",
      "resource": "https://api.example.com/agent/task",
      "description": "Research task with quality verification",
      "mimeType": "application/json",
      "payTo": "0xSellerAddress",
      "extra": {
        "escrowContract": "0xDcA5E5Dd1E969A4b824adDE41569a5d80A965aDe",
        "timelockDuration": 3600,
        "serviceHash": "0x...",
        "arbiter": "0xArbiterAddress",
        "reputationContract": "0x9Ea8c817bFDfb15FA50a30b08A186Cb213F11BCC"
      }
    }
  ]
}
```

### `extra` Fields

| Field | Required | Type | Description |
|---|---|---|---|
| `escrowContract` | MUST | `address` | Address of the PayCrowEscrow contract |
| `timelockDuration` | MUST | `uint256` | Seconds until the escrow expires (300–2592000) |
| `serviceHash` | MUST | `bytes32` | `keccak256` of the service URL or task identifier |
| `arbiter` | SHOULD | `address` | Current arbiter address for dispute resolution |
| `reputationContract` | SHOULD | `address` | Address of the reputation ledger |

## PaymentPayload

The buyer constructs a `PAYMENT-SIGNATURE` header containing:

```json
{
  "x402Version": 2,
  "scheme": "dispute",
  "network": "eip155:8453",
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0xBuyerAddress",
      "to": "0xDcA5E5Dd1E969A4b824adDE41569a5d80A965aDe",
      "value": "5000000",
      "validAfter": "0",
      "validBefore": "1710000000",
      "nonce": "0x..."
    },
    "escrowParams": {
      "seller": "0xSellerAddress",
      "timelockDuration": 3600,
      "serviceHash": "0x..."
    }
  }
}
```

The `authorization` fields match the ERC-3009 `receiveWithAuthorization` parameters. The `escrowParams` are additional fields needed by the escrow contract.

### Nonce Derivation

The nonce MUST be deterministic to prevent replay:

```
nonce = keccak256(abi.encodePacked(
    buyer,
    seller,
    amount,
    serviceHash,
    block.timestamp
))
```

## Verification Logic

The facilitator (or buyer-side middleware) MUST perform the following checks before funding the escrow:

1. **Validate `x402Version`** — MUST be `2`.
2. **Validate `scheme`** — MUST be `"dispute"`.
3. **Validate `network`** — MUST match `eip155:8453` (Base mainnet) or the target chain.
4. **Validate `escrowContract`** — the address MUST be a known, trusted PayCrowEscrow deployment. Clients SHOULD maintain an allowlist.
5. **Validate `amount`** — MUST be between `MIN_ESCROW_AMOUNT` (100,000 = $0.10) and `MAX_ESCROW_AMOUNT` (100,000,000 = $100).
6. **Validate `timelockDuration`** — MUST be between `MIN_TIMELOCK` (300 seconds) and `MAX_TIMELOCK` (2,592,000 seconds = 30 days).
7. **Validate `seller`** — MUST NOT be the zero address and MUST NOT equal the buyer address.
8. **Validate `serviceHash`** — MUST NOT be zero. SHOULD match `keccak256(resource_url)`.
9. **Check buyer USDC balance** — buyer MUST have sufficient USDC balance for the escrow amount.
10. **Check buyer USDC allowance** — buyer MUST have approved the escrow contract (or router) to spend the required amount.

### Optional: Reputation Pre-Check

Before funding, the buyer agent MAY query the seller's reputation:

```solidity
// On-chain (PayCrowReputation)
(uint64 completed, uint64 disputed, uint64 refunded, , , , , ) =
    reputation.getReputation(sellerAddress);
uint256 score = reputation.getScore(sellerAddress);

// Buyer agent decides: if score < threshold, skip this seller
```

The buyer MAY also query external reputation sources:
- ERC-8004 ReputationRegistry at `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` on Base
- Moltbook API for karma scores
- x402 settlement history via `AuthorizationUsed` events on USDC

## Settlement Logic

### Phase 1: Escrow Creation

The buyer (or an authorized router acting on the buyer's behalf) calls `createAndFund()` or `createAndFundFor()`:

1. The escrow contract validates all parameters (amount bounds, timelock bounds, addresses).
2. USDC is transferred from the caller to the escrow contract via `safeTransferFrom`.
3. An `EscrowCreated` event is emitted with the `escrowId`, buyer, seller, amount, expiry, and serviceHash.
4. An `EscrowFunded` event is emitted.
5. The `escrowId` is returned to the caller.

### Phase 2: Service Delivery

The buyer agent makes the actual x402 request to the seller's resource endpoint. The seller processes the request and returns the result. This phase is **identical to the `exact` scheme** from the seller's perspective — the seller does not need to know the buyer is using escrow.

### Phase 3a: Release (happy path)

If the buyer is satisfied with the result:

1. Buyer calls `release(escrowId)`.
2. Protocol fee is calculated: `fee = amount * feeBps / 10000` (default 2% = 200 bps).
3. Fee is transferred to the protocol treasury.
4. Remaining amount (`amount - fee`) is transferred to the seller.
5. Reputation is recorded as `Completed` for both buyer and seller.
6. `EscrowReleased` event is emitted.

### Phase 3b: Dispute

If the buyer is unsatisfied:

1. Buyer calls `dispute(escrowId)`.
2. Escrow state transitions to `Disputed`.
3. `EscrowDisputed` event is emitted.
4. Funds remain locked in the contract.

### Phase 3c: Resolution

The designated arbiter reviews the dispute:

1. Arbiter calls `resolve(escrowId, buyerAmount, sellerAmount)`.
2. Contract validates: `buyerAmount + sellerAmount == amount - fee`.
3. Protocol fee is transferred to treasury.
4. `buyerAmount` is refunded to the buyer.
5. `sellerAmount` is released to the seller.
6. Reputation is recorded as `Disputed` for both parties.
7. `EscrowResolved` event is emitted.

### Phase 3d: Expiry

If the timelock passes without release or dispute:

1. Anyone calls `markExpired(escrowId)` (permissionless after `expiresAt`).
2. Anyone calls `refund(escrowId)`.
3. Full escrow amount is returned to the buyer (**no fee charged**).
4. Reputation is recorded as `Refunded`.
5. `EscrowRefunded` event is emitted.

## Router Integration

For seamless x402 integration, an authorized **router contract** can intercept standard x402 facilitator settlements and redirect them into escrow:

```
x402 Facilitator → settles USDC → Router → createAndFundFor(buyer, seller, ...) → Escrow
```

The router:
1. Receives USDC from the facilitator's settlement
2. Approves the escrow contract to spend the amount
3. Calls `createAndFundFor()` with the original buyer's address
4. Returns the `escrowId` to the buyer

This allows the buyer agent to use standard x402 `PAYMENT-SIGNATURE` headers while transparently routing payment through escrow.

## Fee System

| Event | Fee | Recipient |
|---|---|---|
| `release()` | `feeBps` (default 200 = 2%) | Protocol treasury |
| `resolve()` | `feeBps` (default 200 = 2%) | Protocol treasury |
| `refund()` | 0% | N/A (buyer gets full refund) |

- Fee is capped at `MAX_FEE_BPS` (500 = 5%) and configurable by the contract owner.
- Fee is deducted before the buyer/seller split in `resolve()`.
- Total fees collected are tracked on-chain via `totalFeesCollected`.

## Appendix

### Escrow State Machine

```solidity
enum EscrowState {
    Created,   // 0 — escrow created, awaiting funding
    Funded,    // 1 — USDC deposited, awaiting delivery
    Released,  // 2 — delivery confirmed, funds sent to seller
    Disputed,  // 3 — buyer flagged bad delivery, awaiting arbiter
    Resolved,  // 4 — arbiter ruled on dispute
    Expired,   // 5 — timelock passed without release or dispute
    Refunded   // 6 — funds returned to buyer
}
```

Valid transitions:
- `Created → Funded` (on `createAndFund` / `createAndFundFor`)
- `Funded → Released` (on `release`)
- `Funded → Disputed` (on `dispute`)
- `Funded → Expired` (on `markExpired`, after timelock)
- `Disputed → Resolved` (on `resolve`)
- `Expired → Refunded` (on `refund`)

### Escrow Struct

```solidity
struct Escrow {
    address buyer;       // Agent that funded the escrow
    address seller;      // Agent that provides the service
    uint256 amount;      // USDC amount (6 decimals)
    uint256 createdAt;   // Block timestamp of creation
    uint256 expiresAt;   // Block timestamp of expiry
    EscrowState state;   // Current state
    bytes32 serviceHash; // keccak256 of service URL/identifier
}
```

### Reputation Struct

```solidity
struct Reputation {
    uint64 totalCompleted;   // Escrows successfully released
    uint64 totalDisputed;    // Escrows where this address was disputed
    uint64 totalRefunded;    // Escrows that expired and were refunded
    uint64 totalAsProvider;  // Times this address was the seller
    uint64 totalAsClient;    // Times this address was the buyer
    uint256 totalVolume;     // Total USDC volume (6 decimals)
    uint256 firstSeen;       // Timestamp of first involvement
    uint256 lastSeen;        // Timestamp of most recent involvement
}
```

### Deployed Contracts (Base Mainnet — eip155:8453)

| Contract | Address |
|---|---|
| PayCrowEscrow | `0xDcA5E5Dd1E969A4b824adDE41569a5d80A965aDe` |
| PayCrowReputation | `0x9Ea8c817bFDfb15FA50a30b08A186Cb213F11BCC` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

### Events Reference

```solidity
// Escrow lifecycle
event EscrowCreated(uint256 indexed escrowId, address indexed buyer, address indexed seller,
    uint256 amount, uint256 expiresAt, bytes32 serviceHash);
event EscrowFunded(uint256 indexed escrowId, uint256 amount);
event EscrowReleased(uint256 indexed escrowId, uint256 amount);
event EscrowDisputed(uint256 indexed escrowId, address indexed disputedBy);
event EscrowResolved(uint256 indexed escrowId, uint256 buyerAmount, uint256 sellerAmount);
event EscrowExpired(uint256 indexed escrowId);
event EscrowRefunded(uint256 indexed escrowId, uint256 amount);

// Fees
event FeeCollected(uint256 indexed escrowId, uint256 feeAmount);

// Reputation
event ReputationUpdated(address indexed agent, Outcome indexed outcome,
    uint256 amount, uint256 escrowId, bool isProvider);
```

### References

- [EIP-3009: Transfer With Authorization](https://eips.ethereum.org/EIPS/eip-3009)
- [ERC-8004: Trustless Agent Identity](https://eips.ethereum.org/EIPS/eip-8004)
- [x402 Specification v2](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
- [x402 Exact Scheme](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact.md)
- [Base Commerce Payments Protocol](https://github.com/base/commerce-payments)
