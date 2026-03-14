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

// ── On-chain reputation types ─────────────────────────────────────

export interface OnChainReputation {
  totalCompleted: number;
  totalDisputed: number;
  totalRefunded: number;
  totalAsProvider: number;
  totalAsClient: number;
  totalVolume: bigint;
  firstSeen: bigint;
  lastSeen: bigint;
}

