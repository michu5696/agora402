/**
 * Composite Trust Score Engine
 *
 * Aggregates trust signals from multiple on-chain and off-chain sources
 * into a single 0-100 score with full provenance.
 *
 * Sources and weights:
 *   1. PayCrow Reputation (35%) — our own escrow outcome history
 *   2. ERC-8004 Reputation  (25%) — cross-ecosystem agent identity + feedback
 *   3. Moltbook Social      (15%) — karma, account age, social standing
 *   4. Base Chain Activity   (15%) — wallet age, tx count, USDC volume
 *   5. (Reserved)            (10%) — future sources (ClawCredit, x402 settlements)
 *
 * Scoring principles:
 *   - No data → score null, confidence "none", recommendation "insufficient_data"
 *   - Confidence is weighted by source importance, not just source count
 *   - Disputes and refunds are negative signals that actively lower scores
 *   - Recommendation is capped by confidence (never "high_trust" with "low" confidence)
 */

import { createPublicClient, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { queryErc8004, type Erc8004Signal } from "./sources/erc8004.js";
import { queryMoltbook, type MoltbookSignal } from "./sources/moltbook.js";
import { queryBaseChain, type BaseChainSignal } from "./sources/base-chain.js";

/** ABI for PayCrowReputation contract — only what we need */
const reputationAbi = [
  {
    type: "function",
    name: "getReputation",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [
      { name: "totalCompleted", type: "uint64" },
      { name: "totalDisputed", type: "uint64" },
      { name: "totalRefunded", type: "uint64" },
      { name: "totalAsProvider", type: "uint64" },
      { name: "totalAsClient", type: "uint64" },
      { name: "totalVolume", type: "uint256" },
      { name: "firstSeen", type: "uint256" },
      { name: "lastSeen", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getScore",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "score", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface PayCrowSignal {
  score: number;
  totalCompleted: number;
  totalDisputed: number;
  totalRefunded: number;
  totalVolume: string;
  disputeRate: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface CompositeTrustScore {
  address: string;
  /** Final composite score 0-100, or null if no data available */
  score: number | null;
  /** Confidence level — weighted by source importance, not just count */
  confidence: "high" | "medium" | "low" | "none";
  /** Weighted confidence as a percentage (0-100) */
  confidencePercent: number;
  recommendation:
    | "high_trust"
    | "moderate_trust"
    | "low_trust"
    | "caution"
    | "insufficient_data";
  /** Per-source breakdown */
  sources: {
    paycrow: PayCrowSignal | null;
    erc8004: Erc8004Signal | null;
    moltbook: MoltbookSignal | null;
    baseChain: BaseChainSignal | null;
  };
  /** Which sources contributed to the score */
  sourcesUsed: string[];
  /** ISO timestamp */
  timestamp: string;
  chain: string;
}

export interface TrustEngineConfig {
  /** RPC URL for Base (defaults to public endpoint) */
  rpcUrl?: string;
  /** Chain: "base" or "base-sepolia" */
  chain?: "base" | "base-sepolia";
  /** PayCrow Reputation contract address */
  reputationAddress?: Address;
  /** Moltbook API app key (optional, for higher rate limits) */
  moltbookAppKey?: string;
  /** BaseScan API key (required for chain activity data) */
  basescanApiKey?: string;
}

const WEIGHTS = {
  paycrow: 0.35,
  erc8004: 0.25,
  moltbook: 0.15,
  baseChain: 0.15,
  // reserved: 0.10 — future sources
};

/** Sum of active weights (excluding reserved) */
const ACTIVE_WEIGHT_SUM = WEIGHTS.paycrow + WEIGHTS.erc8004 + WEIGHTS.moltbook + WEIGHTS.baseChain;

const DEFAULT_REPUTATION_ADDRESSES: Record<string, Address> = {
  base: "0x9Ea8c817bFDfb15FA50a30b08A186Cb213F11BCC",
  "base-sepolia": "0x2A216a829574e88dD632e7C95660d43bCE627CDf",
};

export async function computeTrustScore(
  address: Address,
  config: TrustEngineConfig = {}
): Promise<CompositeTrustScore> {
  const chainName = config.chain ?? "base";
  const chain = chainName === "base" ? base : baseSepolia;
  const rpcUrl = config.rpcUrl ?? (chainName === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org");
  const reputationAddr = config.reputationAddress ?? DEFAULT_REPUTATION_ADDRESSES[chainName];

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  // Query all sources in parallel — each handles its own errors
  const [paycrowResult, erc8004Result, moltbookResult, baseChainResult] = await Promise.allSettled([
    queryPayCrow(address, reputationAddr, publicClient),
    queryErc8004(address),
    queryMoltbook(address, config.moltbookAppKey),
    queryBaseChain(address, config.basescanApiKey),
  ]);

  const paycrow = paycrowResult.status === "fulfilled" ? paycrowResult.value : null;
  const erc8004 = erc8004Result.status === "fulfilled" ? erc8004Result.value : null;
  const moltbook = moltbookResult.status === "fulfilled" ? moltbookResult.value : null;
  const baseChain = baseChainResult.status === "fulfilled" ? baseChainResult.value : null;

  // Compute weighted composite score
  // Only count sources that actually returned meaningful data
  let weightedSum = 0;
  let usedWeight = 0;
  const sourcesUsed: string[] = [];

  // PayCrow: meaningful if address has any escrow history (completed, disputed, or refunded > 0)
  if (paycrow && (paycrow.totalCompleted > 0 || paycrow.totalDisputed > 0 || paycrow.totalRefunded > 0)) {
    weightedSum += paycrow.score * WEIGHTS.paycrow;
    usedWeight += WEIGHTS.paycrow;
    sourcesUsed.push("paycrow");
  }

  // ERC-8004: meaningful if registered
  if (erc8004 && erc8004.registered) {
    weightedSum += erc8004.score * WEIGHTS.erc8004;
    usedWeight += WEIGHTS.erc8004;
    sourcesUsed.push("erc8004");
  }

  // Moltbook: meaningful if found
  if (moltbook && moltbook.found) {
    weightedSum += moltbook.score * WEIGHTS.moltbook;
    usedWeight += WEIGHTS.moltbook;
    sourcesUsed.push("moltbook");
  }

  // Base chain: meaningful if has any transactions
  if (baseChain && baseChain.txCount > 0) {
    weightedSum += baseChain.score * WEIGHTS.baseChain;
    usedWeight += WEIGHTS.baseChain;
    sourcesUsed.push("base-chain");
  }

  // Score: null if no data, otherwise weighted average
  let score: number | null;
  if (usedWeight === 0) {
    score = null;
  } else {
    score = Math.round(weightedSum / usedWeight);
  }

  // Confidence: weighted by source importance (0-100%)
  const confidencePercent = Math.round((usedWeight / ACTIVE_WEIGHT_SUM) * 100);

  let confidence: "high" | "medium" | "low" | "none";
  if (confidencePercent >= 60) confidence = "high";
  else if (confidencePercent >= 35) confidence = "medium";
  else if (confidencePercent > 0) confidence = "low";
  else confidence = "none";

  // Recommendation: capped by confidence level
  let recommendation: CompositeTrustScore["recommendation"];
  if (confidence === "none" || score === null) {
    recommendation = "insufficient_data";
  } else if (paycrow && paycrow.disputeRate > 0.2) {
    // High dispute rate is an explicit red flag regardless of score
    recommendation = "caution";
  } else if (confidence === "low") {
    // Low confidence caps recommendation at moderate_trust
    if (score >= 45) recommendation = "moderate_trust";
    else recommendation = "low_trust";
  } else {
    // Medium or high confidence: full range
    if (score >= 75) recommendation = "high_trust";
    else if (score >= 45) recommendation = "moderate_trust";
    else if (score >= 20) recommendation = "low_trust";
    else recommendation = "caution";
  }

  return {
    address,
    score,
    confidence,
    confidencePercent,
    recommendation,
    sources: { paycrow, erc8004, moltbook, baseChain },
    sourcesUsed,
    timestamp: new Date().toISOString(),
    chain: chainName,
  };
}

async function queryPayCrow(
  address: Address,
  reputationAddr: Address,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any
): Promise<PayCrowSignal | null> {
  try {
    const [rawScore, repData] = await Promise.all([
      client.readContract({
        address: reputationAddr,
        abi: reputationAbi,
        functionName: "getScore",
        args: [address],
      }),
      client.readContract({
        address: reputationAddr,
        abi: reputationAbi,
        functionName: "getReputation",
        args: [address],
      }),
    ]);

    const [completed, disputed, refunded, , , totalVolume, firstSeen, lastSeen] = repData;

    const totalCompleted = Number(completed);
    const totalDisputed = Number(disputed);
    const totalRefunded = Number(refunded);
    const totalInteractions = totalCompleted + totalDisputed + totalRefunded;

    // If no interactions at all, return null (no data, not "unknown")
    // On-chain default score is 50 for addresses with no history
    if (totalInteractions === 0) {
      return null;
    }

    // Compute dispute rate as a negative signal
    const disputeRate = totalInteractions > 0
      ? totalDisputed / totalInteractions
      : 0;

    // Start from on-chain score, then apply dispute penalty
    let score = Number(rawScore);
    if (disputeRate > 0) {
      // Dispute penalty: 0-50 point penalty based on dispute rate
      // 10% dispute rate → -5 points, 50% → -25 points, 100% → -50 points
      score = Math.max(0, score - Math.round(disputeRate * 50));
    }

    return {
      score,
      totalCompleted,
      totalDisputed,
      totalRefunded,
      totalVolume: `$${(Number(totalVolume) / 1e6).toFixed(2)}`,
      disputeRate: Math.round(disputeRate * 100) / 100,
      firstSeen: firstSeen > 0n ? new Date(Number(firstSeen) * 1000).toISOString() : null,
      lastSeen: lastSeen > 0n ? new Date(Number(lastSeen) * 1000).toISOString() : null,
    };
  } catch {
    // Contract call failed — return null (no data), not a fake score
    return null;
  }
}
