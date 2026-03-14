import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createPublicClient, http, type Address } from "viem";
import {
  payCrowReputationAbi,
  formatUsdc,
  type OnChainReputation,
} from "@paycrow/core";
import {
  getChain,
  getRpcUrl,
  getChainName,
  getReputationAddress,
} from "../config.js";
import { computeTrustScore } from "@paycrow/trust";

const publicClient = createPublicClient({
  chain: getChain(),
  transport: http(getRpcUrl()),
});

async function queryOnChainReputation(
  address: Address
): Promise<{ score: number; reputation: OnChainReputation }> {
  const reputationAddress = getReputationAddress();

  const [score, repData] = await Promise.all([
    publicClient.readContract({
      address: reputationAddress,
      abi: payCrowReputationAbi,
      functionName: "getScore",
      args: [address],
    }),
    publicClient.readContract({
      address: reputationAddress,
      abi: payCrowReputationAbi,
      functionName: "getReputation",
      args: [address],
    }),
  ]);

  const [
    totalCompleted,
    totalDisputed,
    totalRefunded,
    totalAsProvider,
    totalAsClient,
    totalVolume,
    firstSeen,
    lastSeen,
  ] = repData;

  return {
    score: Number(score),
    reputation: {
      totalCompleted: Number(totalCompleted),
      totalDisputed: Number(totalDisputed),
      totalRefunded: Number(totalRefunded),
      totalAsProvider: Number(totalAsProvider),
      totalAsClient: Number(totalAsClient),
      totalVolume,
      firstSeen,
      lastSeen,
    },
  };
}

export function registerTrustTools(server: McpServer): void {
  // ── Trust gate — go/no-go decision with recommended escrow params ──
  server.tool(
    "trust_gate",
    `Should you pay this agent? Check before sending money. Returns a go/no-go decision with recommended escrow protection parameters.

Unlike other trust services, PayCrow ties trust directly to escrow protection:
- High trust → shorter timelock, proceed with confidence
- Low trust → longer timelock, smaller amounts recommended
- Caution → don't proceed, or use maximum protection

This is the tool to call BEFORE escrow_create or safe_pay.`,
    {
      address: z
        .string()
        .describe("Ethereum address of the agent you're about to pay"),
      intended_amount_usdc: z
        .number()
        .min(0.01)
        .max(100)
        .optional()
        .describe(
          "How much you plan to pay (helps calibrate the recommendation)"
        ),
    },
    async ({ address, intended_amount_usdc }) => {
      try {
        const chainName = getChainName();
        const trustScore = await computeTrustScore(address as Address, {
          chain: chainName as "base" | "base-sepolia",
          rpcUrl: getRpcUrl(),
          reputationAddress: getReputationAddress(),
          basescanApiKey: process.env.BASESCAN_API_KEY,
          moltbookAppKey: process.env.MOLTBOOK_APP_KEY,
        });

        // Map trust to escrow protection parameters
        let decision: "proceed" | "proceed_with_caution" | "do_not_proceed";
        let recommendedTimelockMinutes: number;
        let maxRecommendedUsdc: number;
        let reasoning: string;

        if (
          trustScore.recommendation === "high_trust" &&
          trustScore.confidence !== "low"
        ) {
          decision = "proceed";
          recommendedTimelockMinutes = 15;
          maxRecommendedUsdc = 100;
          reasoning =
            "Strong trust signal from multiple sources. Standard escrow protection is sufficient.";
        } else if (
          trustScore.recommendation === "moderate_trust" ||
          (trustScore.recommendation === "high_trust" &&
            trustScore.confidence === "low")
        ) {
          decision = "proceed_with_caution";
          recommendedTimelockMinutes = 60;
          maxRecommendedUsdc = 25;
          reasoning =
            "Moderate trust or limited data. Use longer timelock and smaller amounts. Escrow protection recommended.";
        } else if (trustScore.recommendation === "low_trust") {
          decision = "proceed_with_caution";
          recommendedTimelockMinutes = 240;
          maxRecommendedUsdc = 5;
          reasoning =
            "Low trust score. If you proceed, use maximum escrow protection: long timelock, small amount, strict verification.";
        } else {
          decision = "do_not_proceed";
          recommendedTimelockMinutes = 0;
          maxRecommendedUsdc = 0;
          reasoning =
            trustScore.recommendation === "caution"
              ? "High dispute rate detected. This agent has a pattern of failed deliveries. Do not send funds."
              : "Insufficient data to assess this agent. No on-chain history found. Avoid transacting with unknown agents.";
        }

        // Warn if intended amount exceeds recommendation
        let amountWarning: string | undefined;
        if (
          intended_amount_usdc &&
          intended_amount_usdc > maxRecommendedUsdc &&
          decision !== "proceed"
        ) {
          amountWarning = `Your intended payment of $${intended_amount_usdc} exceeds the recommended maximum of $${maxRecommendedUsdc} for this trust level. Consider reducing the amount or splitting into smaller escrows.`;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  address,
                  decision,
                  reasoning,
                  trustScore: trustScore.score,
                  confidence: trustScore.confidence,
                  recommendation: trustScore.recommendation,
                  sourcesUsed: trustScore.sourcesUsed,
                  escrowParams: {
                    recommendedTimelockMinutes,
                    maxRecommendedUsdc,
                    ...(intended_amount_usdc
                      ? { intendedAmount: intended_amount_usdc }
                      : {}),
                  },
                  ...(amountWarning ? { warning: amountWarning } : {}),
                  // Bilateral reputation context
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ...(trustScore.sources?.paycrow ? (() => { const p = trustScore.sources.paycrow as any; return {
                    sellerProfile: {
                      completedEscrows: p.totalCompleted,
                      disputeRate: p.disputeRate,
                      buyerDisputeRate: p.buyerDisputeRate ?? null,
                      asProvider: p.totalAsProvider ?? 0,
                      asClient: p.totalAsClient ?? 0,
                    },
                  }; })() : {}),
                  nextStep:
                    decision === "do_not_proceed"
                      ? "Do not proceed with this transaction."
                      : `Use safe_pay or escrow_create with timelock_minutes=${recommendedTimelockMinutes} for protection.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                address,
                decision: "do_not_proceed",
                reasoning:
                  "Trust scoring failed. Do not transact with unverified agents.",
                error:
                  error instanceof Error
                    ? error.message
                    : "Trust scoring unavailable",
              }),
            },
          ],
        };
      }
    }
  );

  // ── Composite trust score (multi-source) ──
  server.tool(
    "trust_score_query",
    "Full trust score breakdown for an agent address. Aggregates 4 on-chain sources: PayCrow escrow history, ERC-8004 agent identity, Moltbook social karma, and Base chain activity. Returns 0-100 score with per-source details. For a quick go/no-go decision, use trust_gate instead.",
    {
      address: z
        .string()
        .describe("Ethereum address of the agent to look up"),
    },
    async ({ address }) => {
      try {
        const chainName = getChainName();
        const trustScore = await computeTrustScore(address as Address, {
          chain: chainName as "base" | "base-sepolia",
          rpcUrl: getRpcUrl(),
          reputationAddress: getReputationAddress(),
          basescanApiKey: process.env.BASESCAN_API_KEY,
          moltbookAppKey: process.env.MOLTBOOK_APP_KEY,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(trustScore, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                address,
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to compute trust score",
                fallback:
                  "Trust scoring temporarily unavailable. Consider using small escrow amounts as a precaution.",
              }),
            },
          ],
        };
      }
    }
  );

  // ── Quick on-chain-only reputation check (free, no API keys needed) ──
  server.tool(
    "trust_onchain_quick",
    "Quick on-chain reputation check using only the PayCrow Reputation contract. Free, no API keys needed. Use trust_score_query for the full composite score.",
    {
      address: z
        .string()
        .describe("Ethereum address of the agent to look up"),
    },
    async ({ address }) => {
      const reputationAddress = getReputationAddress();

      try {
        const { score, reputation } = await queryOnChainReputation(
          address as Address
        );

        const totalEscrows =
          reputation.totalCompleted +
          reputation.totalDisputed +
          reputation.totalRefunded;

        if (totalEscrows === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    address,
                    score: 50,
                    source: "paycrow-onchain",
                    message:
                      "No on-chain escrow history found. This is a new/unknown agent — proceed with caution and use small escrow amounts.",
                    recommendation: "unknown",
                    contract: reputationAddress,
                    chain: getChainName(),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const successRate =
          totalEscrows > 0
            ? ((reputation.totalCompleted / totalEscrows) * 100).toFixed(1)
            : "0";

        let recommendation: string;
        if (score >= 80) recommendation = "high_trust";
        else if (score >= 50) recommendation = "moderate_trust";
        else recommendation = "low_trust";

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  address,
                  score,
                  source: "paycrow-onchain",
                  totalEscrows,
                  successfulEscrows: reputation.totalCompleted,
                  disputedEscrows: reputation.totalDisputed,
                  refundedEscrows: reputation.totalRefunded,
                  asProvider: reputation.totalAsProvider,
                  asClient: reputation.totalAsClient,
                  totalVolume: formatUsdc(reputation.totalVolume),
                  successRate: `${successRate}%`,
                  firstSeen:
                    reputation.firstSeen > 0n
                      ? new Date(
                          Number(reputation.firstSeen) * 1000
                        ).toISOString()
                      : null,
                  lastSeen:
                    reputation.lastSeen > 0n
                      ? new Date(
                          Number(reputation.lastSeen) * 1000
                        ).toISOString()
                      : null,
                  recommendation,
                  contract: reputationAddress,
                  chain: getChainName(),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                address,
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to query on-chain reputation",
                fallback:
                  "Could not reach reputation contract. The agent may be on a different network or the contract is unavailable.",
              }),
            },
          ],
        };
      }
    }
  );
}
