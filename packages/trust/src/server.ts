/**
 * PayCrow — Escrow Protection for Autonomous Agent Payments
 *
 * PayPal for AI agents. USDC held in smart contract on Base until the
 * job is done — no scams, no rugs. Includes trust scoring from 4 on-chain
 * sources so agents can check counterparties before transacting.
 *
 * Endpoints:
 *   GET /trust/:address           — Returns 402 with payment requirements
 *   GET /trust/:address + payment — Returns composite trust score
 *   GET /discovery/resources      — x402 Bazaar catalog for agent discovery
 *   GET /health                   — Health check
 *   GET /stats                    — Request counts and revenue
 *
 * The 402 flow:
 *   1. Agent requests GET /trust/0x...
 *   2. Server returns 402 with PaymentRequirements (price: $0.001 USDC)
 *   3. Agent signs ERC-3009 authorization and retries with PAYMENT-SIGNATURE header
 *   4. Facilitator verifies + settles payment
 *   5. Server returns full composite trust score
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { type Address, type Hash, isAddress, keccak256, toBytes } from "viem";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { computeTrustScore, type TrustEngineConfig } from "./engine.js";
import { formatUsdc, parseUsdc, ESCROW_ADDRESSES, type VerificationStrategy } from "@paycrow/core";
import { EscrowClient } from "@paycrow/escrow-client";
import { verify } from "@paycrow/verification";
import { base, baseSepolia } from "viem/chains";

export interface TrustServerConfig extends TrustEngineConfig {
  /** Port to listen on (default: 4021) */
  port?: number;
  /** USDC price per trust check in base units (default: 1000 = $0.001) */
  priceUsdc?: string;
  /** Address to receive payments */
  payTo: Address;
  /** x402 facilitator URL (default: https://x402.org/facilitator) */
  facilitatorUrl?: string;
}

export function startTrustServer(config: TrustServerConfig) {
  const port = config.port ?? 4021;
  const price = config.priceUsdc ?? "1000"; // $0.001 USDC
  const facilitatorUrl = config.facilitatorUrl ?? "https://facilitator.xpay.sh";
  const chainName = config.chain ?? "base";
  const network = chainName === "base" ? "eip155:8453" : "eip155:84532";
  const usdcAddress = chainName === "base"
    ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  // In-memory stats (resets on deploy — good enough for now)
  const startedAt = new Date().toISOString();
  const stats = {
    requests: 0,         // total hits to /trust/:address
    paymentsAttempted: 0,
    paymentsSettled: 0,
    paymentsFailed: 0,
    revenueUsdc: 0,      // in base units
    uniqueAddresses: new Set<string>(),
    uniquePayers: new Set<string>(),
    lastPayment: null as string | null,
  };

  function json(res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>): void {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
      ...headers,
    };
    res.writeHead(status, h);
    res.end(JSON.stringify(data, null, 2));
  }

  function paymentRequirements(resource: string) {
    return {
      x402Version: 2,
      resource: {
        url: resource,
        description: "Escrow-protected trust check. Vet an agent before sending funds to escrow. Returns 0-100 score from 4 on-chain sources with confidence level, recommendation, and per-source breakdown.",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network,
          amount: price,
          maxTimeoutSeconds: 30,
          payTo: config.payTo,
          asset: usdcAddress,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
      extensions: {
        bazaar: {
          info: {
            input: {
              type: "http",
              method: "GET",
              pathParams: { address: "0x0000000000000000000000000000000000000001" },
            },
            output: {
              type: "json",
              example: {
                score: 78,
                confidence: "high",
                confidencePercent: 83,
                recommendation: "high_trust",
                sourcesUsed: ["paycrow", "erc8004", "base-chain"],
              },
            },
          },
          schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              input: {
                type: "object",
                properties: {
                  type: { type: "string", const: "http" },
                  method: { type: "string", enum: ["GET"] },
                  pathParams: {
                    type: "object",
                    properties: {
                      address: {
                        type: "string",
                        pattern: "^0x[a-fA-F0-9]{40}$",
                        description: "Ethereum address to check trust score for",
                      },
                    },
                    required: ["address"],
                  },
                },
                required: ["type", "method"],
                additionalProperties: false,
              },
              output: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  example: { type: "object" },
                },
                required: ["type"],
              },
            },
            required: ["input"],
          },
        },
      },
      facilitatorUrl,
    };
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
  }

  /**
   * Verify payment with the x402 facilitator.
   * In production, this calls the facilitator's /verify and /settle endpoints.
   * Returns true if payment was successfully settled.
   */
  async function verifyAndSettlePayment(
    paymentSignature: string,
    resource: string
  ): Promise<{ success: boolean; payer?: string; error?: string }> {
    try {
      const payload = JSON.parse(
        Buffer.from(paymentSignature, "base64").toString("utf-8")
      );

      const requirements = paymentRequirements(resource).accepts[0];
      const version = payload.x402Version ?? 2;

      // Verify with facilitator (matches x402 SDK HTTPFacilitatorClient format)
      const verifyBody = JSON.stringify({
        x402Version: version,
        paymentPayload: payload,
        paymentRequirements: requirements,
      });

      console.log(`[x402] Verifying payment with ${facilitatorUrl}/verify`);
      const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: verifyBody,
        signal: AbortSignal.timeout(10000),
      });

      const verifyData = await verifyRes.json() as Record<string, unknown>;
      console.log(`[x402] Verify response (${verifyRes.status}):`, JSON.stringify(verifyData));

      if (!verifyRes.ok || !verifyData.isValid) {
        return {
          success: false,
          error: `Verify failed: ${verifyData.invalidReason ?? verifyData.error ?? verifyRes.status}`,
        };
      }

      // Settle with facilitator
      const settleBody = JSON.stringify({
        x402Version: version,
        paymentPayload: payload,
        paymentRequirements: requirements,
      });

      console.log(`[x402] Settling payment with ${facilitatorUrl}/settle`);
      const settleRes = await fetch(`${facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: settleBody,
        signal: AbortSignal.timeout(30000),
      });

      const settleData = await settleRes.json() as Record<string, unknown>;
      console.log(`[x402] Settle response (${settleRes.status}):`, JSON.stringify(settleData));

      if (!settleRes.ok || !settleData.success) {
        return {
          success: false,
          error: `Settle failed: ${settleData.errorReason ?? settleData.error ?? settleRes.status}`,
        };
      }

      return {
        success: true,
        payer: (settleData.payer ?? verifyData.payer) as string | undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[x402] Payment error:`, msg);
      return { success: false, error: msg };
    }
  }

  // ── MCP-over-HTTP (Streamable HTTP transport) ──
  // Stateful sessions: map sessionId → transport
  const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

  // Lazy escrow client — only created when escrow tools are called
  function getEscrowClient(): EscrowClient {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        "PRIVATE_KEY not set. Escrow tools require a wallet. Set PRIVATE_KEY on the server or use the stdio transport (npx paycrow) for local operation."
      );
    }
    const chain = chainName === "base" ? base : baseSepolia;
    const escrowAddr = ESCROW_ADDRESSES[chain.id];
    if (!escrowAddr) throw new Error(`No escrow contract on ${chainName}`);
    return new EscrowClient({
      privateKey: privateKey as Hash,
      escrowAddress: escrowAddr,
      rpcUrl: config.rpcUrl ?? (chainName === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org"),
      chain,
    });
  }

  function createMcpServer(): McpServer {
    const mcp = new McpServer({ name: "paycrow", version: "1.0.0" });

    const trustConfig = {
      chain: chainName as "base" | "base-sepolia",
      rpcUrl: config.rpcUrl,
      reputationAddress: config.reputationAddress,
      basescanApiKey: config.basescanApiKey,
      moltbookAppKey: config.moltbookAppKey,
    };

    // ── Trust gate — go/no-go decision ──

    mcp.tool(
      "trust_gate",
      `Should you pay this agent? Check before sending money. Returns a go/no-go decision with recommended escrow protection parameters.

Unlike other trust services, PayCrow ties trust directly to escrow protection:
- High trust → shorter timelock, proceed with confidence
- Low trust → longer timelock, smaller amounts recommended
- Caution → don't proceed, or use maximum protection`,
      {
        address: z.string().describe("Ethereum address of the agent you're about to pay"),
        intended_amount_usdc: z.number().min(0.01).max(100).optional().describe("How much you plan to pay"),
      },
      async ({ address: addr, intended_amount_usdc }) => {
        const trustScore = await computeTrustScore(addr as Address, trustConfig);

        let decision: string;
        let recommendedTimelockMinutes: number;
        let maxRecommendedUsdc: number;
        let reasoning: string;

        if (trustScore.recommendation === "high_trust" && trustScore.confidence !== "low") {
          decision = "proceed"; recommendedTimelockMinutes = 15; maxRecommendedUsdc = 100;
          reasoning = "Strong trust signal from multiple sources. Standard escrow protection is sufficient.";
        } else if (trustScore.recommendation === "moderate_trust" || (trustScore.recommendation === "high_trust" && trustScore.confidence === "low")) {
          decision = "proceed_with_caution"; recommendedTimelockMinutes = 60; maxRecommendedUsdc = 25;
          reasoning = "Moderate trust or limited data. Use longer timelock and smaller amounts.";
        } else if (trustScore.recommendation === "low_trust") {
          decision = "proceed_with_caution"; recommendedTimelockMinutes = 240; maxRecommendedUsdc = 5;
          reasoning = "Low trust score. Use maximum escrow protection.";
        } else {
          decision = "do_not_proceed"; recommendedTimelockMinutes = 0; maxRecommendedUsdc = 0;
          reasoning = trustScore.recommendation === "caution"
            ? "High dispute rate detected. Do not send funds."
            : "Insufficient data. No on-chain history found.";
        }

        let amountWarning: string | undefined;
        if (intended_amount_usdc && intended_amount_usdc > maxRecommendedUsdc && decision !== "proceed") {
          amountWarning = `Intended $${intended_amount_usdc} exceeds recommended max of $${maxRecommendedUsdc} for this trust level.`;
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          address: addr, decision, reasoning,
          trustScore: trustScore.score, confidence: trustScore.confidence,
          recommendation: trustScore.recommendation, sourcesUsed: trustScore.sourcesUsed,
          escrowParams: { recommendedTimelockMinutes, maxRecommendedUsdc, ...(intended_amount_usdc ? { intendedAmount: intended_amount_usdc } : {}) },
          ...(amountWarning ? { warning: amountWarning } : {}),
          nextStep: decision === "do_not_proceed" ? "Do not proceed." : `Use safe_pay or escrow_create with timelock_minutes=${recommendedTimelockMinutes}.`,
        }, null, 2) }] };
      }
    );

    // ── Trust score query ──

    mcp.tool(
      "trust_score_query",
      "Full trust score breakdown for an agent address. Aggregates 4 on-chain sources: PayCrow escrow history, ERC-8004 identity, Moltbook karma, and Base chain activity. For a quick go/no-go decision, use trust_gate instead.",
      { address: z.string().describe("Ethereum address to check") },
      async ({ address: addr }) => {
        const score = await computeTrustScore(addr as Address, trustConfig);
        return { content: [{ type: "text" as const, text: JSON.stringify(score, null, 2) }] };
      }
    );

    // ── Escrow tools ──

    mcp.tool(
      "escrow_create",
      "Create a USDC escrow with built-in dispute resolution. Funds are locked on-chain until delivery is confirmed (release) or a problem is flagged (dispute). The only escrow service with real dispute resolution on Base.",
      {
        seller: z.string().describe("Ethereum address of the seller/service provider"),
        amount_usdc: z.number().min(0.1).max(100).describe("Amount in USDC (e.g., 5.00 for $5)"),
        timelock_minutes: z.number().min(5).max(43200).default(30).describe("Minutes until escrow expires and auto-refunds (default: 30)"),
        service_url: z.string().describe("URL or identifier of the service being purchased (used for tracking)"),
      },
      async ({ seller, amount_usdc, timelock_minutes, service_url }) => {
        const client = getEscrowClient();
        const amount = parseUsdc(amount_usdc);
        const timelockDuration = BigInt(timelock_minutes * 60);
        const serviceHash = keccak256(toBytes(service_url));

        const { escrowId, txHash } = await client.createAndFund({
          seller: seller as Address,
          amount,
          timelockDuration,
          serviceHash,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              escrowId: escrowId.toString(),
              amount: formatUsdc(amount),
              seller,
              serviceUrl: service_url,
              expiresInMinutes: timelock_minutes,
              txHash,
              message: `Escrow #${escrowId} created. ${formatUsdc(amount)} locked. Call escrow_release when delivery is confirmed, or escrow_dispute if there's a problem.`,
            }, null, 2),
          }],
        };
      }
    );

    mcp.tool(
      "escrow_release",
      "Confirm delivery and release escrowed USDC to the seller. Only call this when you've verified the service/product was delivered correctly.",
      { escrow_id: z.string().describe("The escrow ID to release") },
      async ({ escrow_id }) => {
        const client = getEscrowClient();
        const txHash = await client.release(BigInt(escrow_id));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true, escrowId: escrow_id, action: "released", txHash,
              message: `Escrow #${escrow_id} released. Funds sent to seller.`,
            }),
          }],
        };
      }
    );

    mcp.tool(
      "escrow_dispute",
      "Flag a problem with delivery — PayCrow's key differentiator. Locks escrowed funds and triggers arbiter review. Unlike other escrow services that say 'no disputes, no chargebacks', PayCrow has real on-chain dispute resolution.",
      {
        escrow_id: z.string().describe("The escrow ID to dispute"),
        reason: z.string().describe("Brief description of the problem for the arbiter"),
      },
      async ({ escrow_id, reason }) => {
        const client = getEscrowClient();
        const txHash = await client.dispute(BigInt(escrow_id));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true, escrowId: escrow_id, action: "disputed", reason, txHash,
              message: `Escrow #${escrow_id} disputed. Funds locked for arbiter review. Reason: ${reason}`,
            }),
          }],
        };
      }
    );

    mcp.tool(
      "escrow_status",
      "Check the current state of an escrow (funded, released, disputed, expired, etc.)",
      { escrow_id: z.string().describe("The escrow ID to check") },
      async ({ escrow_id }) => {
        const client = getEscrowClient();
        const escrowId = BigInt(escrow_id);
        const data = await client.getEscrow(escrowId);
        const expired = await client.isExpired(escrowId);
        const stateNames = ["Created", "Funded", "Released", "Disputed", "Resolved", "Expired", "Refunded"];
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              escrowId: escrow_id,
              state: stateNames[data.state] ?? "Unknown",
              buyer: data.buyer,
              seller: data.seller,
              amount: formatUsdc(data.amount),
              createdAt: new Date(Number(data.createdAt) * 1000).toISOString(),
              expiresAt: new Date(Number(data.expiresAt) * 1000).toISOString(),
              isExpired: expired,
            }, null, 2),
          }],
        };
      }
    );

    // ── safe_pay — Trust-informed smart escrow ──

    mcp.tool(
      "safe_pay",
      `The smart way to pay an agent. Checks trust first, then auto-configures escrow protection based on risk.

Flow: Check trust → Set protection → Create escrow → Call API → Verify → Auto-release or auto-dispute.

Protection: High trust=15min, Moderate=60min, Low=4hr, Unknown=BLOCKED.
This is the recommended tool for paying any agent.`,
      {
        url: z.string().url().describe("The API endpoint URL to call"),
        seller_address: z.string().describe("Ethereum address of the agent you're paying"),
        amount_usdc: z.number().min(0.1).max(100).describe("Amount to pay in USDC"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET").describe("HTTP method"),
        headers: z.record(z.string()).optional().describe("HTTP headers"),
        body: z.string().optional().describe("Request body (for POST/PUT)"),
      },
      async ({ url, seller_address, amount_usdc, method, headers, body: reqBody }) => {
        // Step 1: Check trust
        let trustScore;
        try {
          trustScore = await computeTrustScore(seller_address as Address, trustConfig);
        } catch {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            success: false, step: "trust_check",
            error: "Could not verify seller trust. Refusing to send funds to unverified agent.",
          }) }] };
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
          return { content: [{ type: "text" as const, text: JSON.stringify({
            success: false, step: "trust_check", blocked: true, seller: seller_address,
            trustScore: trustScore.score, recommendation: trustScore.recommendation,
            reason: trustScore.recommendation === "caution"
              ? "Agent has high dispute rate. Payment blocked."
              : "Agent has no verifiable history. Payment blocked.",
          }, null, 2) }] };
        }

        if (amount_usdc > maxAmount) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            success: false, step: "amount_check", requestedAmount: amount_usdc, maxAllowed: maxAmount,
            trustScore: trustScore.score, recommendation: trustScore.recommendation,
            reason: `Trust level limits payments to $${maxAmount}. Use x402_protected_call to override.`,
          }, null, 2) }] };
        }

        // Step 3: Create escrow + call API
        const client = getEscrowClient();
        const amount = parseUsdc(amount_usdc);
        const timelockDuration = BigInt(timelockMinutes * 60);
        const serviceHash = keccak256(toBytes(url));

        const { escrowId, txHash: createTx } = await client.createAndFund({
          seller: seller_address as Address, amount, timelockDuration, serviceHash,
        });

        let apiResponse: Response;
        let responseBody: string;
        try {
          apiResponse = await fetch(url, {
            method, headers: headers as HeadersInit | undefined,
            body: method === "GET" || method === "DELETE" ? undefined : reqBody,
          });
          responseBody = await apiResponse.text();
        } catch (error) {
          const disputeTx = await client.dispute(escrowId);
          return { content: [{ type: "text" as const, text: JSON.stringify({
            success: false, escrowId: escrowId.toString(), step: "api_call",
            error: `API call failed: ${error instanceof Error ? error.message : String(error)}`,
            action: "auto_disputed", createTx, disputeTx,
          }, null, 2) }] };
        }

        let parsedResponse: unknown;
        try { parsedResponse = JSON.parse(responseBody); } catch { parsedResponse = responseBody; }

        const isSuccess = apiResponse.status >= 200 && apiResponse.status < 300;
        const isJsonResponse = parsedResponse !== responseBody;

        if (isSuccess && isJsonResponse) {
          const releaseTx = await client.release(escrowId);
          return { content: [{ type: "text" as const, text: JSON.stringify({
            success: true, escrowId: escrowId.toString(), amount: formatUsdc(amount),
            seller: seller_address, url, httpStatus: apiResponse.status,
            trustScore: trustScore.score, trustRecommendation: trustScore.recommendation,
            timelockUsed: `${timelockMinutes}min`, action: "auto_released", createTx, releaseTx,
            response: parsedResponse,
          }, null, 2) }] };
        } else {
          const disputeTx = await client.dispute(escrowId);
          return { content: [{ type: "text" as const, text: JSON.stringify({
            success: false, escrowId: escrowId.toString(), amount: formatUsdc(amount),
            seller: seller_address, url, httpStatus: apiResponse.status,
            action: "auto_disputed", disputeReason: !isSuccess ? `HTTP ${apiResponse.status}` : "Not valid JSON",
            createTx, disputeTx, response: parsedResponse,
          }, null, 2) }] };
        }
      }
    );

    // ── x402 Protected Call (advanced, manual control) ──

    mcp.tool(
      "x402_protected_call",
      `Make an HTTP API call with manual escrow protection. Full control over verification and timelock.

For most payments, use safe_pay instead — it auto-configures protection based on seller trust.
Use this when you need custom JSON Schema verification, hash-lock verification, or to override trust-based limits.`,
      {
        url: z.string().url().describe("The API endpoint URL to call"),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET").describe("HTTP method"),
        headers: z.record(z.string()).optional().describe("HTTP headers to include"),
        body: z.string().optional().describe("Request body (for POST/PUT)"),
        seller_address: z.string().describe("Ethereum address of the API provider (seller)"),
        amount_usdc: z.number().min(0.1).max(100).describe("Amount to pay in USDC"),
        timelock_minutes: z.number().min(5).max(43200).default(30).describe("Minutes until escrow expires"),
        verification_strategy: z.enum(["schema", "hash-lock"]).default("schema").describe("How to verify the response: 'schema' (JSON Schema) or 'hash-lock' (exact hash match)"),
        verification_data: z.string().describe("Verification data: JSON Schema string (for schema strategy) or expected hash (for hash-lock)"),
      },
      async ({ url, method, headers, body: reqBody, seller_address, amount_usdc, timelock_minutes, verification_strategy, verification_data }) => {
        const client = getEscrowClient();
        const amount = parseUsdc(amount_usdc);
        const timelockDuration = BigInt(timelock_minutes * 60);
        const serviceHash = keccak256(toBytes(url));

        // Step 1: Create escrow
        const { escrowId, txHash: createTx } = await client.createAndFund({
          seller: seller_address as Address,
          amount,
          timelockDuration,
          serviceHash,
        });

        // Step 2: Make the API call
        let apiResponse: Response;
        let responseBody: string;
        try {
          apiResponse = await fetch(url, {
            method,
            headers: headers as HeadersInit | undefined,
            body: method === "GET" || method === "DELETE" ? undefined : reqBody,
          });
          responseBody = await apiResponse.text();
        } catch (error) {
          const disputeTx = await client.dispute(escrowId);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false, escrowId: escrowId.toString(), step: "api_call",
                error: `API call failed: ${error instanceof Error ? error.message : String(error)}`,
                action: "auto_disputed", createTx, disputeTx,
                message: `Escrow #${escrowId} auto-disputed. API call to ${url} failed.`,
              }, null, 2),
            }],
          };
        }

        // Step 3: Verify response
        let parsedResponse: unknown;
        try { parsedResponse = JSON.parse(responseBody); } catch { parsedResponse = responseBody; }
        let expectedData: unknown;
        try { expectedData = JSON.parse(verification_data); } catch { expectedData = verification_data; }

        const result = verify(verification_strategy as VerificationStrategy, parsedResponse, expectedData);

        // Step 4: Auto-release or auto-dispute
        if (result.valid) {
          const releaseTx = await client.release(escrowId);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true, escrowId: escrowId.toString(), amount: formatUsdc(amount),
                seller: seller_address, url, httpStatus: apiResponse.status,
                verification: { strategy: verification_strategy, valid: true, details: result.details },
                action: "auto_released", createTx, releaseTx, response: parsedResponse,
                message: `Payment of ${formatUsdc(amount)} released to ${seller_address}. Response verified successfully.`,
              }, null, 2),
            }],
          };
        } else {
          const disputeTx = await client.dispute(escrowId);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false, escrowId: escrowId.toString(), amount: formatUsdc(amount),
                seller: seller_address, url, httpStatus: apiResponse.status,
                verification: { strategy: verification_strategy, valid: false, details: result.details },
                action: "auto_disputed", createTx, disputeTx, response: parsedResponse,
                message: `Escrow #${escrowId} auto-disputed. Response failed verification: ${result.details}`,
              }, null, 2),
            }],
          };
        }
      }
    );

    return mcp;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      // Parse body
      const body = JSON.parse(await readBody(req));

      let transport: StreamableHTTPServerTransport;
      if (sessionId && mcpTransports.has(sessionId)) {
        transport = mcpTransports.get(sessionId)!;
      } else {
        // New session
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { mcpTransports.set(sid, transport); },
        });
        transport.onclose = () => {
          const sid = [...mcpTransports.entries()].find(([, t]) => t === transport)?.[0];
          if (sid) mcpTransports.delete(sid);
        };
        const mcp = createMcpServer();
        await mcp.connect(transport);
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET") {
      if (!sessionId || !mcpTransports.has(sessionId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No active session. Send a POST first." }));
        return;
      }
      await mcpTransports.get(sessionId)!.handleRequest(req, res);
      return;
    }

    if (req.method === "DELETE") {
      if (sessionId && mcpTransports.has(sessionId)) {
        await mcpTransports.get(sessionId)!.handleRequest(req, res);
        mcpTransports.delete(sessionId);
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, PAYMENT-SIGNATURE, X-PAYMENT",
        "Access-Control-Expose-Headers": "Mcp-Session-Id, PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
      });
      res.end();
      return;
    }

    const host = req.headers.host ?? `localhost:${port}`;
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const url = new URL(req.url ?? "/", `${proto}://${host}`);

    try {
      // ── MCP-over-HTTP endpoint ──
      if (url.pathname === "/mcp") {
        await handleMcp(req, res);
        return;
      }

      // ── Health check ──
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          name: "paycrow",
          version: "1.0.0",
          description: "Escrow protection for autonomous agent payments. USDC held in smart contract on Base until the job is done. Includes trust scoring from 4 on-chain sources.",
          chain: chainName,
          price: `$${Number(price) / 1e6} USDC`,
          sources: ["paycrow-reputation", "erc-8004", "moltbook", "base-chain-activity"],
        });
        return;
      }

      // ── Stats dashboard ──
      if (req.method === "GET" && url.pathname === "/stats") {
        json(res, 200, {
          upSince: startedAt,
          requests: stats.requests,
          paymentsAttempted: stats.paymentsAttempted,
          paymentsSettled: stats.paymentsSettled,
          paymentsFailed: stats.paymentsFailed,
          revenueUsdc: `$${(stats.revenueUsdc / 1e6).toFixed(6)}`,
          uniqueAddresses: stats.uniqueAddresses.size,
          uniquePayers: stats.uniquePayers.size,
          lastPayment: stats.lastPayment,
        });
        return;
      }

      // ── .well-known/agent.json & agent-card.json (A2A discovery) ──
      if (req.method === "GET" && (url.pathname === "/.well-known/agent.json" || url.pathname === "/.well-known/agent-card.json")) {
        json(res, 200, {
          name: "PayCrow",
          description: "Escrow protection for autonomous agent payments on Base. USDC held in smart contract until the job is done — no scams, no rugs. Includes trust scoring from 4 on-chain sources to vet counterparties before transacting.",
          version: "1.0.0",
          url: `${url.origin}/`,
          protocolVersion: "0.3.0",
          provider: {
            organization: "PayCrow",
            url: `${url.origin}`,
          },
          documentationUrl: `${url.origin}/llms.txt`,
          capabilities: {
            streaming: true,
            pushNotifications: false,
            stateTransitionHistory: false,
            extensions: [
              {
                uri: "https://x402.org/protocol",
                description: "x402 payment protocol. Escrow-protected queries cost $0.001 USDC on Base via ERC-3009.",
                required: true,
                params: {
                  network,
                  asset: usdcAddress,
                  assetName: "USDC",
                  pricePerQuery: price,
                  priceHuman: `$${Number(price) / 1e6} USDC`,
                  facilitatorUrl,
                  paymentScheme: "exact",
                },
              },
            ],
          },
          securitySchemes: {
            x402: {
              type: "http",
              scheme: "X-PAYMENT",
              description: "x402 payment header. Base64-encoded ERC-3009 authorization payload.",
            },
          },
          security: [{ x402: [] }],
          defaultInputModes: ["text"],
          defaultOutputModes: ["application/json"],
          skills: [
            {
              id: "trust_gate",
              name: "Trust Gate",
              description: "Should you pay this agent? Go/no-go decision with recommended escrow protection. Checks trust then tells you how to protect your funds.",
              tags: ["trust", "reputation", "payment-protection", "escrow", "risk"],
              examples: [
                "Should I pay 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045?",
                "Is this agent safe to send $5 to?",
              ],
              inputModes: ["text"],
              outputModes: ["application/json"],
            },
            {
              id: "safe_pay",
              name: "Safe Pay",
              description: "The smart way to pay an agent. Checks trust, auto-configures escrow protection, calls the API, and auto-releases or auto-disputes.",
              tags: ["payment", "escrow", "trust", "dispute-resolution", "x402"],
              examples: [
                "Pay 0x1234...abcd $1 for their API at https://api.example.com/data",
              ],
              inputModes: ["text"],
              outputModes: ["application/json"],
            },
            {
              id: "trust_score_query",
              name: "Trust Score Query",
              description: "Full trust score breakdown from 4 on-chain sources: escrow history, ERC-8004 identity, Moltbook karma, and Base chain activity.",
              tags: ["trust", "reputation", "erc-8004", "moltbook", "base"],
              examples: [
                "Get full trust breakdown for 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
              ],
              inputModes: ["text"],
              outputModes: ["application/json"],
            },
          ],
          supportsAuthenticatedExtendedCard: false,
        });
        return;
      }

      // ── .well-known/mcp/server-card.json (Smithery / MCP discovery) ──
      if (req.method === "GET" && url.pathname === "/.well-known/mcp/server-card.json") {
        json(res, 200, {
          name: "paycrow",
          description: "Escrow protection for autonomous agent payments on Base. USDC held in smart contract until the job is done. Includes trust scoring from 4 on-chain sources.",
          version: "1.0.0",
          capabilities: {
            tools: true,
            prompts: false,
            resources: false,
          },
          tools: [
            {
              name: "trust_gate",
              description: "Should you pay this agent? Go/no-go decision with recommended escrow protection.",
              inputSchema: {
                type: "object",
                properties: {
                  address: { type: "string", description: "Ethereum address to check" },
                  intended_amount_usdc: { type: "number", description: "How much you plan to pay" },
                },
                required: ["address"],
              },
            },
            {
              name: "safe_pay",
              description: "Trust-informed smart escrow. Checks trust, creates escrow, calls API, auto-releases or disputes.",
              inputSchema: {
                type: "object",
                properties: {
                  url: { type: "string", description: "API endpoint URL" },
                  seller_address: { type: "string", description: "Agent's Ethereum address" },
                  amount_usdc: { type: "number", description: "Amount in USDC" },
                },
                required: ["url", "seller_address", "amount_usdc"],
              },
            },
            {
              name: "trust_score_query",
              description: "Full trust score breakdown from 4 on-chain sources.",
              inputSchema: {
                type: "object",
                properties: {
                  address: { type: "string", description: "Ethereum address to check" },
                },
                required: ["address"],
              },
            },
          ],
          transport: {
            type: "streamable-http",
            url: `${url.origin}/mcp`,
          },
        });
        return;
      }

      // ── .well-known/x402 manifest (x402scan discovery format) ──
      if (req.method === "GET" && url.pathname === "/.well-known/x402") {
        json(res, 200, {
          version: 1,
          resources: [
            `${url.origin}/trust/0x0000000000000000000000000000000000000001`,
          ],
          ownershipProofs: [config.payTo],
          instructions: "Escrow-protected agent payments on Base. Check counterparty trust scores before transacting. GET /trust/{address} to query. Price: $0.001 USDC via x402.",
        });
        return;
      }

      // ── llms.txt (AI crawler discovery) ──
      if (req.method === "GET" && url.pathname === "/llms.txt") {
        res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end(`# PayCrow — Escrow Protection for Agent Payments
# PayPal for autonomous agents

> Escrow protection for autonomous agent payments on Base.
> USDC held in smart contract until the job is done — no scams, no rugs.
> Check counterparty trust scores before transacting (4 on-chain sources).
> Price: $${Number(price) / 1e6} USDC per query via x402 protocol.

## Endpoints
- GET /trust/{address} — Query trust score (requires x402 payment)
- GET /discovery/resources — x402 Bazaar catalog
- GET /.well-known/x402 — x402 manifest
- GET /health — Health check

## Payment
Network: Base (eip155:8453)
Asset: USDC (${usdcAddress})
Amount: ${price} base units ($${Number(price) / 1e6})
Facilitator: ${facilitatorUrl}

## MCP Server
npm install -g paycrow
npx paycrow
`);
        return;
      }

      // ── x402 Bazaar discovery ──
      if (req.method === "GET" && url.pathname === "/discovery/resources") {
        json(res, 200, {
          resources: [
            {
              resource: `/trust/{address}`,
              method: "GET",
              description: "Check if an agent is safe to transact with before sending funds to escrow. Returns 0-100 trust score from 4 on-chain sources: escrow history, ERC-8004 identity, Moltbook karma, and Base chain activity. Part of PayCrow's escrow protection layer.",
              scheme: "exact",
              network,
              maxAmountRequired: price,
              asset: usdcAddress,
              mimeType: "application/json",
              tags: ["escrow", "payment-protection", "trust", "reputation", "agent", "erc-8004", "moltbook"],
              rateLimit: { requests: 100, period: "minute" },
              example: {
                request: "GET /trust/0x1234...abcd",
                response: {
                  score: 78,
                  confidence: "high",
                  recommendation: "high_trust",
                  sourcesUsed: ["paycrow", "erc8004", "base-chain"],
                },
              },
            },
          ],
        });
        return;
      }

      // ── Trust score query ──
      const trustMatch = url.pathname.match(/^\/trust\/(0x[a-fA-F0-9]{40})$/);
      if (req.method === "GET" && trustMatch) {
        const queryAddress = trustMatch[1] as Address;
        stats.requests++;
        stats.uniqueAddresses.add(queryAddress.toLowerCase());

        if (!isAddress(queryAddress)) {
          json(res, 400, { error: "Invalid Ethereum address" });
          return;
        }

        // Check for x402 payment header
        const paymentSig = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;

        if (!paymentSig) {
          // Free preview: compute score but only return summary (no source breakdown)
          // This lets agents evaluate the service before paying
          const preview = await computeTrustScore(queryAddress, {
            chain: chainName,
            rpcUrl: config.rpcUrl,
            reputationAddress: config.reputationAddress,
            moltbookAppKey: config.moltbookAppKey,
            basescanApiKey: config.basescanApiKey,
          });

          const resource = `${url.origin}/trust/${queryAddress}`;
          const requirements = paymentRequirements(resource);
          const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
          json(res, 402, {
            // Free preview — enough to decide if the full report is worth $0.001
            preview: {
              address: queryAddress,
              score: preview.score,
              confidence: preview.confidence,
              recommendation: preview.recommendation,
              sourcesUsed: preview.sourcesUsed,
            },
            // Pay for full breakdown with per-source details
            ...requirements,
          }, {
            "PAYMENT-REQUIRED": encoded,
          });
          return;
        }

        // Verify and settle payment
        stats.paymentsAttempted++;
        const resource = `${url.origin}/trust/${queryAddress}`;
        const payment = await verifyAndSettlePayment(paymentSig, resource);

        if (!payment.success) {
          stats.paymentsFailed++;
          json(res, 402, {
            error: "Payment verification failed",
            detail: payment.error,
            ...paymentRequirements(resource),
          });
          return;
        }

        // Payment succeeded
        stats.paymentsSettled++;
        stats.revenueUsdc += Number(price);
        stats.lastPayment = new Date().toISOString();
        if (payment.payer) stats.uniquePayers.add(payment.payer.toLowerCase());

        // Compute and return trust score
        const trustScore = await computeTrustScore(queryAddress, {
          chain: chainName,
          rpcUrl: config.rpcUrl,
          reputationAddress: config.reputationAddress,
          moltbookAppKey: config.moltbookAppKey,
          basescanApiKey: config.basescanApiKey,
        });

        json(res, 200, {
          ...trustScore,
          payment: {
            settled: true,
            payer: payment.payer,
            amount: `$${Number(price) / 1e6} USDC`,
          },
        });
        return;
      }

      json(res, 404, { error: "Not found. Try GET /trust/{address} or GET /discovery/resources" });
    } catch (error) {
      json(res, 500, {
        error: error instanceof Error ? error.message : "Internal error",
      });
    }
  });

  server.listen(port, () => {
    console.log(`\nPayCrow — Escrow Protection for Agent Payments — http://localhost:${port}`);
    console.log(`  GET /trust/{address}        — Query trust score ($${Number(price) / 1e6} USDC per check)`);
    console.log(`  POST /mcp                    — MCP-over-HTTP (Streamable HTTP)`);
    console.log(`  GET /discovery/resources     — x402 Bazaar catalog`);
    console.log(`  GET /health                  — Health check`);
    console.log(`\nChain: ${chainName} | Price: $${Number(price) / 1e6} USDC | PayTo: ${config.payTo}`);
    console.log(`Facilitator: ${facilitatorUrl}\n`);
  });

  return server;
}
