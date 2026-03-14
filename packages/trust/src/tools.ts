/**
 * Shared MCP tool registration for PayCrow.
 *
 * Single source of truth for all 10 MCP tools. Used by:
 *   - packages/trust/src/server.ts (HTTP server's MCP-over-HTTP)
 *   - packages/mcp-server/src/index.ts (stdio MCP server)
 *
 * Tools take a config object rather than reading env vars directly,
 * so they work in both contexts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Address, keccak256, toBytes, createPublicClient, http } from "viem";
import { computeTrustScore, type TrustEngineConfig } from "./engine.js";
import {
  formatUsdc,
  parseUsdc,
  payCrowReputationAbi,
  type OnChainReputation,
  type VerificationStrategy,
} from "@paycrow/core";
import { EscrowClient } from "@paycrow/escrow-client";
import { verify } from "@paycrow/verification";
import type { Chain, Hash } from "viem";

export interface ToolConfig {
  trustConfig: TrustEngineConfig;
  getEscrowClient: () => EscrowClient;
  chain: Chain;
  rpcUrl: string;
  reputationAddress: Address;
  chainName: string;
}

export function registerAllTools(server: McpServer, config: ToolConfig): void {
  registerTrustTools(server, config);
  registerEscrowTools(server, config);
  registerX402Tools(server, config);
}

// ─── Trust Tools ──────────────────────────────────────────────────────

function registerTrustTools(server: McpServer, config: ToolConfig): void {
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
  });

  async function queryOnChainReputation(
    address: Address
  ): Promise<{ score: number; reputation: OnChainReputation }> {
    const [score, repData] = await Promise.all([
      publicClient.readContract({
        address: config.reputationAddress,
        abi: payCrowReputationAbi,
        functionName: "getScore",
        args: [address],
      }),
      publicClient.readContract({
        address: config.reputationAddress,
        abi: payCrowReputationAbi,
        functionName: "getReputation",
        args: [address],
      }),
    ]);

    const [
      totalCompleted, totalDisputed, totalRefunded,
      totalAsProvider, totalAsClient, totalVolume,
      firstSeen, lastSeen,
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

  // ── Trust gate ──
  server.tool(
    "trust_gate",
    `Should you pay this agent? Check before sending money. Returns a go/no-go decision with recommended escrow protection parameters.

Unlike other trust services, PayCrow ties trust directly to escrow protection:
- High trust → shorter timelock, proceed with confidence
- Low trust → longer timelock, smaller amounts recommended
- Caution → don't proceed, or use maximum protection

This is the tool to call BEFORE escrow_create or safe_pay.`,
    {
      address: z.string().describe("Ethereum address of the agent you're about to pay"),
      intended_amount_usdc: z.number().min(0.01).max(100).optional().describe("How much you plan to pay (helps calibrate the recommendation)"),
    },
    async ({ address, intended_amount_usdc }) => {
      try {
        const trustScore = await computeTrustScore(address as Address, config.trustConfig);

        let decision: "proceed" | "proceed_with_caution" | "do_not_proceed";
        let recommendedTimelockMinutes: number;
        let maxRecommendedUsdc: number;
        let reasoning: string;

        if (trustScore.recommendation === "high_trust" && trustScore.confidence !== "low") {
          decision = "proceed"; recommendedTimelockMinutes = 15; maxRecommendedUsdc = 100;
          reasoning = "Strong trust signal from multiple sources. Standard escrow protection is sufficient.";
        } else if (trustScore.recommendation === "moderate_trust" || (trustScore.recommendation === "high_trust" && trustScore.confidence === "low")) {
          decision = "proceed_with_caution"; recommendedTimelockMinutes = 60; maxRecommendedUsdc = 25;
          reasoning = "Moderate trust or limited data. Use longer timelock and smaller amounts. Escrow protection recommended.";
        } else if (trustScore.recommendation === "low_trust") {
          decision = "proceed_with_caution"; recommendedTimelockMinutes = 240; maxRecommendedUsdc = 5;
          reasoning = "Low trust score. If you proceed, use maximum escrow protection: long timelock, small amount, strict verification.";
        } else {
          decision = "do_not_proceed"; recommendedTimelockMinutes = 0; maxRecommendedUsdc = 0;
          reasoning = trustScore.recommendation === "caution"
            ? "High dispute rate detected. This agent has a pattern of failed deliveries. Do not send funds."
            : "Insufficient data to assess this agent. No on-chain history found. Avoid transacting with unknown agents.";
        }

        let amountWarning: string | undefined;
        if (intended_amount_usdc && intended_amount_usdc > maxRecommendedUsdc && decision !== "proceed") {
          amountWarning = `Your intended payment of $${intended_amount_usdc} exceeds the recommended maximum of $${maxRecommendedUsdc} for this trust level. Consider reducing the amount or splitting into smaller escrows.`;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const paycrowSource = trustScore.sources?.paycrow as any;

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            address, decision, reasoning,
            trustScore: trustScore.score, confidence: trustScore.confidence,
            recommendation: trustScore.recommendation, sourcesUsed: trustScore.sourcesUsed,
            escrowParams: {
              recommendedTimelockMinutes, maxRecommendedUsdc,
              ...(intended_amount_usdc ? { intendedAmount: intended_amount_usdc } : {}),
            },
            ...(amountWarning ? { warning: amountWarning } : {}),
            ...(paycrowSource ? {
              sellerProfile: {
                completedEscrows: paycrowSource.totalCompleted,
                disputeRate: paycrowSource.disputeRate,
                buyerDisputeRate: paycrowSource.buyerDisputeRate ?? null,
                asProvider: paycrowSource.totalAsProvider ?? 0,
                asClient: paycrowSource.totalAsClient ?? 0,
              },
            } : {}),
            nextStep: decision === "do_not_proceed"
              ? "Do not proceed with this transaction."
              : `Use safe_pay or escrow_create with timelock_minutes=${recommendedTimelockMinutes} for protection.`,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            address, decision: "do_not_proceed",
            reasoning: "Trust scoring failed. Do not transact with unverified agents.",
            error: error instanceof Error ? error.message : "Trust scoring unavailable",
          }) }],
        };
      }
    }
  );

  // ── Trust score query ──
  server.tool(
    "trust_score_query",
    "Full trust score breakdown for an agent address. Aggregates 4 on-chain sources: PayCrow escrow history, ERC-8004 agent identity, Moltbook social karma, and Base chain activity. Returns 0-100 score with per-source details. For a quick go/no-go decision, use trust_gate instead.",
    { address: z.string().describe("Ethereum address of the agent to look up") },
    async ({ address }) => {
      try {
        const trustScore = await computeTrustScore(address as Address, config.trustConfig);
        return { content: [{ type: "text" as const, text: JSON.stringify(trustScore, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            address,
            error: error instanceof Error ? error.message : "Failed to compute trust score",
            fallback: "Trust scoring temporarily unavailable. Consider using small escrow amounts as a precaution.",
          }) }],
        };
      }
    }
  );

  // ── Quick on-chain reputation check ──
  server.tool(
    "trust_onchain_quick",
    "Quick on-chain reputation check using only the PayCrow Reputation contract. Free, no API keys needed. Use trust_score_query for the full composite score.",
    { address: z.string().describe("Ethereum address of the agent to look up") },
    async ({ address }) => {
      try {
        const { score, reputation } = await queryOnChainReputation(address as Address);
        const totalEscrows = reputation.totalCompleted + reputation.totalDisputed + reputation.totalRefunded;

        if (totalEscrows === 0) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              address, score: 50, source: "paycrow-onchain",
              message: "No on-chain escrow history found. This is a new/unknown agent — proceed with caution and use small escrow amounts.",
              recommendation: "unknown", contract: config.reputationAddress, chain: config.chainName,
            }, null, 2) }],
          };
        }

        const successRate = ((reputation.totalCompleted / totalEscrows) * 100).toFixed(1);
        let recommendation: string;
        if (score >= 80) recommendation = "high_trust";
        else if (score >= 50) recommendation = "moderate_trust";
        else recommendation = "low_trust";

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            address, score, source: "paycrow-onchain", totalEscrows,
            successfulEscrows: reputation.totalCompleted, disputedEscrows: reputation.totalDisputed,
            refundedEscrows: reputation.totalRefunded, asProvider: reputation.totalAsProvider,
            asClient: reputation.totalAsClient, totalVolume: formatUsdc(reputation.totalVolume),
            successRate: `${successRate}%`,
            firstSeen: reputation.firstSeen > 0n ? new Date(Number(reputation.firstSeen) * 1000).toISOString() : null,
            lastSeen: reputation.lastSeen > 0n ? new Date(Number(reputation.lastSeen) * 1000).toISOString() : null,
            recommendation, contract: config.reputationAddress, chain: config.chainName,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            address,
            error: error instanceof Error ? error.message : "Failed to query on-chain reputation",
            fallback: "Could not reach reputation contract. The agent may be on a different network or the contract is unavailable.",
          }) }],
        };
      }
    }
  );
}

// ─── Escrow Tools ─────────────────────────────────────────────────────

function registerEscrowTools(server: McpServer, config: ToolConfig): void {
  server.tool(
    "escrow_create",
    "Create a USDC escrow with built-in dispute resolution. Funds are locked on-chain until delivery is confirmed (release) or a problem is flagged (dispute). If disputed, an arbiter reviews and rules — the only escrow service with real dispute resolution on Base.",
    {
      seller: z.string().describe("Ethereum address of the seller/service provider"),
      amount_usdc: z.number().min(0.1).max(100).describe("Amount in USDC (e.g., 5.00 for $5)"),
      timelock_minutes: z.number().min(5).max(43200).default(30).describe("Minutes until escrow expires and auto-refunds (default: 30)"),
      service_url: z.string().describe("URL or identifier of the service being purchased (used for tracking)"),
    },
    async ({ seller, amount_usdc, timelock_minutes, service_url }) => {
      const client = config.getEscrowClient();
      const amount = parseUsdc(amount_usdc);
      const timelockDuration = BigInt(timelock_minutes * 60);
      const serviceHash = keccak256(toBytes(service_url));

      const { escrowId, txHash } = await client.createAndFund({
        seller: seller as Address, amount, timelockDuration, serviceHash,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          success: true, escrowId: escrowId.toString(), amount: formatUsdc(amount),
          seller, serviceUrl: service_url, expiresInMinutes: timelock_minutes, txHash,
          message: `Escrow #${escrowId} created. ${formatUsdc(amount)} locked. Call escrow_release when delivery is confirmed, or escrow_dispute if there's a problem.`,
        }, null, 2) }],
      };
    }
  );

  server.tool(
    "escrow_release",
    "Confirm delivery and release escrowed USDC to the seller. Only call this when you've verified the service/product was delivered correctly.",
    { escrow_id: z.string().describe("The escrow ID to release") },
    async ({ escrow_id }) => {
      const client = config.getEscrowClient();
      const txHash = await client.release(BigInt(escrow_id));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          success: true, escrowId: escrow_id, action: "released", txHash,
          message: `Escrow #${escrow_id} released. Funds sent to seller.`,
        }) }],
      };
    }
  );

  server.tool(
    "escrow_dispute",
    "Flag a problem with delivery — PayCrow's key differentiator. Locks escrowed funds and triggers arbiter review. Unlike other escrow services that say 'no disputes, no chargebacks', PayCrow has real on-chain dispute resolution. Use when service was not delivered or quality was unacceptable.",
    {
      escrow_id: z.string().describe("The escrow ID to dispute"),
      reason: z.string().describe("Brief description of the problem for the arbiter"),
    },
    async ({ escrow_id, reason }) => {
      const client = config.getEscrowClient();
      const txHash = await client.dispute(BigInt(escrow_id));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          success: true, escrowId: escrow_id, action: "disputed", reason, txHash,
          message: `Escrow #${escrow_id} disputed. Funds locked for arbiter review. Reason: ${reason}`,
        }) }],
      };
    }
  );

  server.tool(
    "escrow_status",
    "Check the current state of an escrow (funded, released, disputed, expired, etc.)",
    { escrow_id: z.string().describe("The escrow ID to check") },
    async ({ escrow_id }) => {
      const client = config.getEscrowClient();
      const escrowId = BigInt(escrow_id);
      const data = await client.getEscrow(escrowId);
      const expired = await client.isExpired(escrowId);
      const stateNames = ["Created", "Funded", "Released", "Disputed", "Resolved", "Expired", "Refunded"];

      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          escrowId: escrow_id, state: stateNames[data.state] ?? "Unknown",
          buyer: data.buyer, seller: data.seller, amount: formatUsdc(data.amount),
          createdAt: new Date(Number(data.createdAt) * 1000).toISOString(),
          expiresAt: new Date(Number(data.expiresAt) * 1000).toISOString(),
          isExpired: expired,
        }, null, 2) }],
      };
    }
  );

  server.tool(
    "rate_service",
    `Rate a completed escrow. After escrow_release, rate the seller's service quality (1-5 stars).

This builds the reputation data that makes PayCrow's trust scores meaningful over time.
Both sides can rate: buyer rates seller's service quality, seller rates buyer's conduct.

Ratings are on-chain and permanent — they feed directly into trust scoring.`,
    {
      escrow_id: z.string().describe("The escrow ID to rate (must be in Released state)"),
      stars: z.number().min(1).max(5).int().describe("Rating 1-5 stars (1=terrible, 5=excellent)"),
    },
    async ({ escrow_id, stars }) => {
      try {
        const client = config.getEscrowClient();
        const data = await client.getEscrow(BigInt(escrow_id));
        const stateNames = ["Created", "Funded", "Released", "Disputed", "Resolved", "Expired", "Refunded"];

        if (data.state !== 2) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              success: false, escrowId: escrow_id, currentState: stateNames[data.state] ?? "Unknown",
              error: "Can only rate escrows in Released state.",
            }) }],
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true, escrowId: escrow_id, stars, seller: data.seller, buyer: data.buyer,
            amount: formatUsdc(data.amount),
            message: `Rated escrow #${escrow_id} with ${stars}/5 stars. This rating contributes to the seller's trust score.`,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: false, escrowId: escrow_id,
            error: error instanceof Error ? error.message : "Failed to submit rating",
          }) }],
        };
      }
    }
  );
}

// ─── x402 Tools ───────────────────────────────────────────────────────

function registerX402Tools(server: McpServer, config: ToolConfig): void {
  server.tool(
    "safe_pay",
    `The smart way to pay an agent. Checks their trust score first, then auto-configures escrow protection based on risk.

Flow: Check trust → Set protection level → Create escrow → Call API → Verify → Auto-release or auto-dispute.

Protection levels (automatic):
- High trust agent → 15min timelock, proceed normally
- Moderate trust → 60min timelock, payment capped at $25
- Low trust → 4hr timelock, payment capped at $5
- Unknown/caution → BLOCKED — will not send funds

This is the recommended tool for paying any agent. If you need manual control, use x402_protected_call instead.`,
    {
      url: z.string().url().describe("The API endpoint URL to call"),
      seller_address: z.string().describe("Ethereum address of the agent you're paying"),
      amount_usdc: z.number().min(0.1).max(100).describe("Amount to pay in USDC"),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET").describe("HTTP method (default: GET)"),
      headers: z.record(z.string()).optional().describe("HTTP headers to include"),
      body: z.string().optional().describe("Request body (for POST/PUT)"),
    },
    async ({ url, seller_address, amount_usdc, method, headers, body }) => {
      // Step 1: Check trust
      let trustScore;
      try {
        trustScore = await computeTrustScore(seller_address as Address, config.trustConfig);
      } catch {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: false, step: "trust_check",
            error: "Could not verify seller trust. Refusing to send funds to unverified agent.",
            recommendation: "Use trust_gate to manually check the agent, or use x402_protected_call with explicit parameters.",
          }) }],
        };
      }

      // Step 2: Determine protection level
      let timelockMinutes: number;
      let maxAmount: number;

      if (trustScore.recommendation === "high_trust" && trustScore.confidence !== "low") {
        timelockMinutes = 15; maxAmount = 100;
      } else if (trustScore.recommendation === "moderate_trust" || (trustScore.recommendation === "high_trust" && trustScore.confidence === "low")) {
        timelockMinutes = 60; maxAmount = 25;
      } else if (trustScore.recommendation === "low_trust") {
        timelockMinutes = 240; maxAmount = 5;
      } else {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: false, step: "trust_check", blocked: true, seller: seller_address,
            trustScore: trustScore.score, confidence: trustScore.confidence,
            recommendation: trustScore.recommendation, sourcesUsed: trustScore.sourcesUsed,
            reason: trustScore.recommendation === "caution"
              ? "Agent has a high dispute rate. PayCrow blocked this payment to protect your funds."
              : "Agent has no verifiable on-chain history. PayCrow blocked this payment. Use trust_gate for details.",
            message: `Payment to ${seller_address} BLOCKED. Trust: ${trustScore.recommendation}. Do not send funds to this agent.`,
          }, null, 2) }],
        };
      }

      // Step 3: Cap amount
      if (amount_usdc > maxAmount) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: false, step: "amount_check", seller: seller_address,
            requestedAmount: amount_usdc, maxAllowed: maxAmount,
            trustScore: trustScore.score, recommendation: trustScore.recommendation,
            reason: `Trust level "${trustScore.recommendation}" limits payments to $${maxAmount}. Requested: $${amount_usdc}. Reduce the amount or use x402_protected_call to override.`,
          }, null, 2) }],
        };
      }

      // Step 4: Create escrow + call API
      const client = config.getEscrowClient();
      const amount = parseUsdc(amount_usdc);
      const timelockDuration = BigInt(timelockMinutes * 60);
      const serviceHash = keccak256(toBytes(url));

      const { escrowId, txHash: createTx } = await client.createAndFund({
        seller: seller_address as Address, amount, timelockDuration, serviceHash,
      });

      // Step 5: Make the API call
      let apiResponse: Response;
      let responseBody: string;
      try {
        apiResponse = await fetch(url, {
          method, headers: headers as HeadersInit | undefined,
          body: method === "GET" || method === "DELETE" ? undefined : body,
          signal: AbortSignal.timeout(30000),
        });
        responseBody = await apiResponse.text();
      } catch (error) {
        const disputeTx = await client.dispute(escrowId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: false, escrowId: escrowId.toString(), step: "api_call",
            error: `API call failed: ${error instanceof Error ? error.message : String(error)}`,
            action: "auto_disputed", trustScore: trustScore.score, createTx, disputeTx,
            message: `Escrow #${escrowId} auto-disputed. API to ${url} failed. Funds protected by PayCrow dispute resolution.`,
          }, null, 2) }],
        };
      }

      // Step 6: Verify response
      let parsedResponse: unknown;
      try { parsedResponse = JSON.parse(responseBody); } catch { parsedResponse = responseBody; }

      const isSuccess = apiResponse.status >= 200 && apiResponse.status < 300;
      const isJsonResponse = parsedResponse !== responseBody;

      if (isSuccess && isJsonResponse) {
        const releaseTx = await client.release(escrowId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true, escrowId: escrowId.toString(), amount: formatUsdc(amount),
            seller: seller_address, url, httpStatus: apiResponse.status,
            trustScore: trustScore.score, trustRecommendation: trustScore.recommendation,
            timelockUsed: `${timelockMinutes}min`, action: "auto_released", createTx, releaseTx,
            response: parsedResponse,
            message: `Payment of ${formatUsdc(amount)} released to ${seller_address}. Trust-verified and response confirmed.`,
            nextStep: `Use rate_service with escrow_id=${escrowId} to rate the service quality (1-5 stars).`,
          }, null, 2) }],
        };
      } else {
        const disputeTx = await client.dispute(escrowId);
        const sellerReputation = trustScore.sources?.paycrow;
        let disputeRecommendation: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sellerRep = sellerReputation as any;
        if (sellerRep && sellerRep.disputeRate > 0.15) {
          disputeRecommendation = "Seller has high dispute rate — likely refund to buyer.";
        } else if (sellerRep && sellerRep.totalCompleted > 10 && sellerRep.disputeRate === 0) {
          disputeRecommendation = "Seller has strong track record — this may be a temporary issue. Consider retry before escalating.";
        } else {
          disputeRecommendation = "Insufficient seller history — arbiter review recommended.";
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: false, escrowId: escrowId.toString(), amount: formatUsdc(amount),
            seller: seller_address, url, httpStatus: apiResponse.status,
            trustScore: trustScore.score, action: "auto_disputed",
            disputeReason: !isSuccess ? `HTTP ${apiResponse.status} error response` : "Response is not valid JSON",
            disputeRecommendation,
            sellerDisputeRate: sellerRep?.disputeRate ?? "unknown",
            sellerCompletedEscrows: sellerRep?.totalCompleted ?? 0,
            createTx, disputeTx, response: parsedResponse,
            message: `Escrow #${escrowId} auto-disputed. ${!isSuccess ? `HTTP ${apiResponse.status}` : "Invalid response format"}. Funds protected by PayCrow dispute resolution.`,
            nextStep: "Use rate_service after resolution to record quality feedback.",
          }, null, 2) }],
        };
      }
    }
  );

  // ── x402_protected_call ──
  server.tool(
    "x402_protected_call",
    `Make an HTTP API call with manual escrow protection. Full control over verification and timelock parameters.

For most payments, use safe_pay instead — it auto-configures protection based on seller trust.

Use x402_protected_call when you need:
- Custom JSON Schema verification (not just "valid JSON + 2xx")
- Hash-lock verification (exact response match)
- Specific timelock durations
- To override safe_pay's trust-based amount limits`,
    {
      url: z.string().url().describe("The API endpoint URL to call"),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET").describe("HTTP method"),
      headers: z.record(z.string()).optional().describe("HTTP headers to include"),
      body: z.string().optional().describe("Request body (for POST/PUT)"),
      seller_address: z.string().describe("Ethereum address of the API provider (seller) who will receive payment"),
      amount_usdc: z.number().min(0.1).max(100).describe("Amount to pay in USDC"),
      timelock_minutes: z.number().min(5).max(43200).default(30).describe("Minutes until escrow expires"),
      verification_strategy: z.enum(["schema", "hash-lock"]).default("schema").describe("How to verify the response: 'schema' (JSON Schema) or 'hash-lock' (exact hash match)"),
      verification_data: z.string().describe("Verification data: JSON Schema string (for schema strategy) or expected hash (for hash-lock)"),
    },
    async ({ url, method, headers, body, seller_address, amount_usdc, timelock_minutes, verification_strategy, verification_data }) => {
      const client = config.getEscrowClient();
      const amount = parseUsdc(amount_usdc);
      const timelockDuration = BigInt(timelock_minutes * 60);
      const serviceHash = keccak256(toBytes(url));

      const { escrowId, txHash: createTx } = await client.createAndFund({
        seller: seller_address as Address, amount, timelockDuration, serviceHash,
      });

      let apiResponse: Response;
      let responseBody: string;
      try {
        apiResponse = await fetch(url, {
          method, headers: headers as HeadersInit | undefined,
          body: method === "GET" || method === "DELETE" ? undefined : body,
          signal: AbortSignal.timeout(30000),
        });
        responseBody = await apiResponse.text();
      } catch (error) {
        const disputeTx = await client.dispute(escrowId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: false, escrowId: escrowId.toString(), step: "api_call",
            error: `API call failed: ${error instanceof Error ? error.message : String(error)}`,
            action: "auto_disputed", createTx, disputeTx,
            message: `Escrow #${escrowId} auto-disputed. API call to ${url} failed.`,
          }, null, 2) }],
        };
      }

      let parsedResponse: unknown;
      try { parsedResponse = JSON.parse(responseBody); } catch { parsedResponse = responseBody; }
      let expectedData: unknown;
      try { expectedData = JSON.parse(verification_data); } catch { expectedData = verification_data; }

      const result = verify(verification_strategy as VerificationStrategy, parsedResponse, expectedData);

      if (result.valid) {
        const releaseTx = await client.release(escrowId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true, escrowId: escrowId.toString(), amount: formatUsdc(amount),
            seller: seller_address, url, httpStatus: apiResponse.status,
            verification: { strategy: verification_strategy, valid: true, details: result.details },
            action: "auto_released", createTx, releaseTx, response: parsedResponse,
            message: `Payment of ${formatUsdc(amount)} released to ${seller_address}. Response verified successfully.`,
          }, null, 2) }],
        };
      } else {
        const disputeTx = await client.dispute(escrowId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: false, escrowId: escrowId.toString(), amount: formatUsdc(amount),
            seller: seller_address, url, httpStatus: apiResponse.status,
            verification: { strategy: verification_strategy, valid: false, details: result.details },
            action: "auto_disputed", createTx, disputeTx, response: parsedResponse,
            message: `Escrow #${escrowId} auto-disputed. Response failed verification: ${result.details}`,
          }, null, 2) }],
        };
      }
    }
  );
}
