import type { Address } from "viem";
import { baseSepolia } from "viem/chains";

export const USDC_DECIMALS = 6;

export const USDC_ADDRESSES: Record<number, Address> = {
  [baseSepolia.id]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const SUPPORTED_CHAINS = [baseSepolia] as const;

export const DEFAULT_TIMELOCK_SECONDS = {
  apiCall: 30 * 60, // 30 minutes
  longTask: 24 * 60 * 60, // 24 hours
} as const;

export const ESCROW_LIMITS = {
  minAmount: 100_000n, // $0.10 USDC
  maxAmount: 100_000_000n, // $100 USDC
  minTimelock: 5n * 60n, // 5 minutes
  maxTimelock: 30n * 24n * 60n * 60n, // 30 days
} as const;

export function parseUsdc(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
}

export function formatUsdc(amount: bigint): string {
  const num = Number(amount) / 10 ** USDC_DECIMALS;
  return `$${num.toFixed(2)}`;
}

// ── Protocol fee constants ──────────────────────────────────────────

/** Maximum fee the contract allows, in basis points (5%). */
export const MAX_FEE_BPS = 500n;

/** Basis-point denominator used by the contract (10 000 = 100%). */
export const BPS_DENOMINATOR = 10_000n;

/** Default protocol fee in basis points (2%). */
export const DEFAULT_FEE_BPS = 200n;

/**
 * Calculate the protocol fee for a given amount.
 *
 * fee = amount * feeBps / BPS_DENOMINATOR
 *
 * This mirrors the on-chain calculation applied during `release` and `resolve`.
 * No fee is charged on `refund` (expired escrows).
 */
export function calculateFee(amount: bigint, feeBps: bigint = DEFAULT_FEE_BPS): bigint {
  return (amount * feeBps) / BPS_DENOMINATOR;
}

/**
 * Return the seller payout after the protocol fee is deducted.
 */
export function amountAfterFee(amount: bigint, feeBps: bigint = DEFAULT_FEE_BPS): bigint {
  return amount - calculateFee(amount, feeBps);
}

/**
 * Convert basis points to a human-readable percentage string.
 * e.g. 200n => "2.00%"
 */
export function formatBps(bps: bigint): string {
  const pct = Number(bps) / 100;
  return `${pct.toFixed(2)}%`;
}
