import type { Address, Hash } from "viem";

export enum EscrowState {
  Created = 0,
  Funded = 1,
  Released = 2,
  Disputed = 3,
  Resolved = 4,
  Expired = 5,
  Refunded = 6,
}

export interface EscrowData {
  buyer: Address;
  seller: Address;
  amount: bigint;
  createdAt: bigint;
  expiresAt: bigint;
  state: EscrowState;
  serviceHash: Hash;
}

export interface CreateEscrowParams {
  seller: Address;
  amount: bigint;
  timelockDuration: bigint;
  serviceHash: Hash;
}

export interface ResolveParams {
  escrowId: bigint;
  buyerAmount: bigint;
  sellerAmount: bigint;
}

export interface EscrowEvent {
  escrowId: bigint;
  buyer: Address;
  seller: Address;
  amount: bigint;
  expiresAt: bigint;
  serviceHash: Hash;
}

export type VerificationStrategy = "hash-lock" | "schema";

export interface VerificationResult {
  valid: boolean;
  strategy: VerificationStrategy;
  details?: string;
}

export interface TrustScore {
  address: Address;
  score: number; // 0-100
  totalEscrows: number;
  successfulEscrows: number;
  disputedEscrows: number;
  lastUpdated: Date;
}

export interface SlaDefinition {
  serviceUrl: string;
  responseSchema?: Record<string, unknown>;
  maxLatencyMs?: number;
  expectedHash?: Hash;
}

// ── Protocol fee types ──────────────────────────────────────────────

/** Constructor / deployment parameters for the Agora402Escrow contract. */
export interface DeployParams {
  usdc: Address;
  arbiter: Address;
  treasury: Address;
  feeBps: bigint;
}

/** On-chain fee configuration snapshot. */
export interface FeeConfig {
  treasury: Address;
  feeBps: bigint;
  totalFeesCollected: bigint;
}

/** Emitted when a protocol fee is collected on release or resolve. */
export interface FeeCollectedEvent {
  escrowId: bigint;
  amount: bigint;
  treasury: Address;
}

/** Emitted when the fee basis points are changed. */
export interface FeeUpdatedEvent {
  oldFeeBps: bigint;
  newFeeBps: bigint;
}

/** Emitted when the treasury address is changed. */
export interface TreasuryUpdatedEvent {
  oldTreasury: Address;
  newTreasury: Address;
}
