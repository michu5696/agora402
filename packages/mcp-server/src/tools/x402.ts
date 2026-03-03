import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EscrowClient } from "@agora402/escrow-client";
import { verify } from "@agora402/verification";
import { updateTrustScore } from "./trust.js";
import {
  formatUsdc,
  parseUsdc,
  type VerificationStrategy,
} from "@agora402/core";
import type { Hash, Address } from "viem";
import { keccak256, toBytes } from "viem";

function getClient(): EscrowClient {
  const privateKey = process.env.PRIVATE_KEY;
  const escrowAddress = process.env.ESCROW_CONTRACT_ADDRESS;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;

  if (!privateKey || !escrowAddress) {
    throw new Error(
      "PRIVATE_KEY and ESCROW_CONTRACT_ADDRESS must be set in environment"
    );
  }

  return new EscrowClient({
    privateKey: privateKey as Hash,
    escrowAddress: escrowAddress as Address,
    rpcUrl,
  });
}

export function registerX402Tools(server: McpServer): void {
  server.tool(
    "x402_protected_call",
    `Make an HTTP API call with automatic escrow protection. This is the flagship Agora402 tool.

Flow: Create escrow → Call API → Verify response → Auto-release or auto-dispute.

Use this instead of direct x402 payments to get buyer protection. If the API returns bad data, your funds are automatically disputed and locked for arbiter review.`,
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
      const client = getClient();
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
        updateTrustScore(seller_address, "disputed");

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
        updateTrustScore(seller_address, "released");

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
        updateTrustScore(seller_address, "disputed");

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
