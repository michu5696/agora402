import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { verify } from "@paycrow/verification";
import {
  formatUsdc,
  parseUsdc,
  type VerificationStrategy,
} from "@paycrow/core";
import { computeTrustScore } from "@paycrow/trust";
import type { Address } from "viem";
import { keccak256, toBytes } from "viem";
import { getEscrowClient, getChainName, getRpcUrl, getReputationAddress } from "../config.js";

export function registerX402Tools(server: McpServer): void {
  // ── safe_pay — Trust-informed smart escrow ──
  // The killer feature: checks trust THEN auto-configures escrow protection.
  // Nobody else has this. Reduces x402_protected_call from 9 params to 4.
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
      seller_address: z
        .string()
        .describe("Ethereum address of the agent you're paying"),
      amount_usdc: z
        .number()
        .min(0.1)
        .max(100)
        .describe("Amount to pay in USDC"),
      method: z
        .enum(["GET", "POST", "PUT", "DELETE"])
        .default("GET")
        .describe("HTTP method (default: GET)"),
      headers: z
        .record(z.string())
        .optional()
        .describe("HTTP headers to include"),
      body: z.string().optional().describe("Request body (for POST/PUT)"),
    },
    async ({ url, seller_address, amount_usdc, method, headers, body }) => {
      // Step 1: Check trust
      const chainName = getChainName();
      let trustScore;
      try {
        trustScore = await computeTrustScore(seller_address as Address, {
          chain: chainName as "base" | "base-sepolia",
          rpcUrl: getRpcUrl(),
          reputationAddress: getReputationAddress(),
          basescanApiKey: process.env.BASESCAN_API_KEY,
          moltbookAppKey: process.env.MOLTBOOK_APP_KEY,
        });
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                step: "trust_check",
                error:
                  "Could not verify seller trust. Refusing to send funds to unverified agent.",
                recommendation:
                  "Use trust_gate to manually check the agent, or use x402_protected_call with explicit parameters.",
              }),
            },
          ],
        };
      }

      // Step 2: Determine protection level
      let timelockMinutes: number;
      let maxAmount: number;

      if (
        trustScore.recommendation === "high_trust" &&
        trustScore.confidence !== "low"
      ) {
        timelockMinutes = 15;
        maxAmount = 100;
      } else if (
        trustScore.recommendation === "moderate_trust" ||
        (trustScore.recommendation === "high_trust" &&
          trustScore.confidence === "low")
      ) {
        timelockMinutes = 60;
        maxAmount = 25;
      } else if (trustScore.recommendation === "low_trust") {
        timelockMinutes = 240;
        maxAmount = 5;
      } else {
        // caution or insufficient_data — BLOCK
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  step: "trust_check",
                  blocked: true,
                  seller: seller_address,
                  trustScore: trustScore.score,
                  confidence: trustScore.confidence,
                  recommendation: trustScore.recommendation,
                  sourcesUsed: trustScore.sourcesUsed,
                  reason:
                    trustScore.recommendation === "caution"
                      ? "Agent has a high dispute rate. PayCrow blocked this payment to protect your funds."
                      : "Agent has no verifiable on-chain history. PayCrow blocked this payment. Use trust_gate for details.",
                  message: `Payment to ${seller_address} BLOCKED. Trust: ${trustScore.recommendation}. Do not send funds to this agent.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 3: Cap amount
      if (amount_usdc > maxAmount) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  step: "amount_check",
                  seller: seller_address,
                  requestedAmount: amount_usdc,
                  maxAllowed: maxAmount,
                  trustScore: trustScore.score,
                  recommendation: trustScore.recommendation,
                  reason: `Trust level "${trustScore.recommendation}" limits payments to $${maxAmount}. Requested: $${amount_usdc}. Reduce the amount or use x402_protected_call to override.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 4: Create escrow + call API
      const client = getEscrowClient();
      const amount = parseUsdc(amount_usdc);
      const timelockDuration = BigInt(timelockMinutes * 60);
      const serviceHash = keccak256(toBytes(url));

      const { escrowId, txHash: createTx } = await client.createAndFund({
        seller: seller_address as Address,
        amount,
        timelockDuration,
        serviceHash,
      });

      // Step 5: Make the API call
      let apiResponse: Response;
      let responseBody: string;
      try {
        apiResponse = await fetch(url, {
          method,
          headers: headers as HeadersInit | undefined,
          body: method === "GET" || method === "DELETE" ? undefined : body,
        });
        responseBody = await apiResponse.text();
      } catch (error) {
        const disputeTx = await client.dispute(escrowId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  escrowId: escrowId.toString(),
                  step: "api_call",
                  error: `API call failed: ${error instanceof Error ? error.message : String(error)}`,
                  action: "auto_disputed",
                  trustScore: trustScore.score,
                  createTx,
                  disputeTx,
                  message: `Escrow #${escrowId} auto-disputed. API to ${url} failed. Funds protected by PayCrow dispute resolution.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 6: Verify response (auto: valid JSON + 2xx status = release)
      let parsedResponse: unknown;
      try {
        parsedResponse = JSON.parse(responseBody);
      } catch {
        parsedResponse = responseBody;
      }

      const isSuccess = apiResponse.status >= 200 && apiResponse.status < 300;
      const isJsonResponse = parsedResponse !== responseBody;

      if (isSuccess && isJsonResponse) {
        // Valid JSON response with 2xx status → auto-release
        const releaseTx = await client.release(escrowId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  escrowId: escrowId.toString(),
                  amount: formatUsdc(amount),
                  seller: seller_address,
                  url,
                  httpStatus: apiResponse.status,
                  trustScore: trustScore.score,
                  trustRecommendation: trustScore.recommendation,
                  timelockUsed: `${timelockMinutes}min`,
                  action: "auto_released",
                  createTx,
                  releaseTx,
                  response: parsedResponse,
                  message: `Payment of ${formatUsdc(amount)} released to ${seller_address}. Trust-verified and response confirmed.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } else {
        // Bad response → auto-dispute. Funds locked for arbiter.
        const disputeTx = await client.dispute(escrowId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  escrowId: escrowId.toString(),
                  amount: formatUsdc(amount),
                  seller: seller_address,
                  url,
                  httpStatus: apiResponse.status,
                  trustScore: trustScore.score,
                  action: "auto_disputed",
                  disputeReason: !isSuccess
                    ? `HTTP ${apiResponse.status} error response`
                    : "Response is not valid JSON",
                  createTx,
                  disputeTx,
                  response: parsedResponse,
                  message: `Escrow #${escrowId} auto-disputed. ${!isSuccess ? `HTTP ${apiResponse.status}` : "Invalid response format"}. Funds protected by PayCrow dispute resolution.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ── x402_protected_call — Advanced escrow with manual control ──
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
      method: z
        .enum(["GET", "POST", "PUT", "DELETE"])
        .default("GET")
        .describe("HTTP method"),
      headers: z
        .record(z.string())
        .optional()
        .describe("HTTP headers to include"),
      body: z.string().optional().describe("Request body (for POST/PUT)"),
      seller_address: z
        .string()
        .describe(
          "Ethereum address of the API provider (seller) who will receive payment"
        ),
      amount_usdc: z
        .number()
        .min(0.1)
        .max(100)
        .describe("Amount to pay in USDC"),
      timelock_minutes: z
        .number()
        .min(5)
        .max(43200)
        .default(30)
        .describe("Minutes until escrow expires"),
      verification_strategy: z
        .enum(["schema", "hash-lock"])
        .default("schema")
        .describe(
          "How to verify the response: 'schema' (JSON Schema) or 'hash-lock' (exact hash match)"
        ),
      verification_data: z
        .string()
        .describe(
          "Verification data: JSON Schema string (for schema strategy) or expected hash (for hash-lock)"
        ),
    },
    async ({
      url,
      method,
      headers,
      body,
      seller_address,
      amount_usdc,
      timelock_minutes,
      verification_strategy,
      verification_data,
    }) => {
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
          body: method === "GET" || method === "DELETE" ? undefined : body,
        });
        responseBody = await apiResponse.text();
      } catch (error) {
        // API call failed — auto-dispute
        const disputeTx = await client.dispute(escrowId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  escrowId: escrowId.toString(),
                  step: "api_call",
                  error: `API call failed: ${error instanceof Error ? error.message : String(error)}`,
                  action: "auto_disputed",
                  createTx,
                  disputeTx,
                  message: `Escrow #${escrowId} auto-disputed. API call to ${url} failed.`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Step 3: Verify response
      let parsedResponse: unknown;
      try {
        parsedResponse = JSON.parse(responseBody);
      } catch {
        parsedResponse = responseBody;
      }

      let expectedData: unknown;
      try {
        expectedData = JSON.parse(verification_data);
      } catch {
        expectedData = verification_data;
      }

      const result = verify(
        verification_strategy as VerificationStrategy,
        parsedResponse,
        expectedData
      );

      // Step 4: Auto-release or auto-dispute based on verification
      if (result.valid) {
        const releaseTx = await client.release(escrowId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  escrowId: escrowId.toString(),
                  amount: formatUsdc(amount),
                  seller: seller_address,
                  url,
                  httpStatus: apiResponse.status,
                  verification: {
                    strategy: verification_strategy,
                    valid: true,
                    details: result.details,
                  },
                  action: "auto_released",
                  createTx,
                  releaseTx,
                  response: parsedResponse,
                  message: `Payment of ${formatUsdc(amount)} released to ${seller_address}. Response verified successfully.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } else {
        const disputeTx = await client.dispute(escrowId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  escrowId: escrowId.toString(),
                  amount: formatUsdc(amount),
                  seller: seller_address,
                  url,
                  httpStatus: apiResponse.status,
                  verification: {
                    strategy: verification_strategy,
                    valid: false,
                    details: result.details,
                  },
                  action: "auto_disputed",
                  createTx,
                  disputeTx,
                  response: parsedResponse,
                  message: `Escrow #${escrowId} auto-disputed. Response failed verification: ${result.details}`,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}
