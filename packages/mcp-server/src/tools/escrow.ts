import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatUsdc, parseUsdc } from "@paycrow/core";
import type { Address } from "viem";
import { keccak256, toBytes } from "viem";
import { getEscrowClient } from "../config.js";

export function registerEscrowTools(server: McpServer): void {
  server.tool(
    "escrow_create",
    "Create a USDC escrow to protect an agent-to-agent transaction. Funds are locked until you confirm delivery (release) or flag a problem (dispute).",
    {
      seller: z
        .string()
        .describe("Ethereum address of the seller/service provider"),
      amount_usdc: z
        .number()
        .min(0.1)
        .max(100)
        .describe("Amount in USDC (e.g., 5.00 for $5)"),
      timelock_minutes: z
        .number()
        .min(5)
        .max(43200)
        .default(30)
        .describe(
          "Minutes until escrow expires and auto-refunds (default: 30)"
        ),
      service_url: z
        .string()
        .describe(
          "URL or identifier of the service being purchased (used for tracking)"
        ),
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
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                escrowId: escrowId.toString(),
                amount: formatUsdc(amount),
                seller,
                serviceUrl: service_url,
                expiresInMinutes: timelock_minutes,
                txHash,
                message: `Escrow #${escrowId} created. ${formatUsdc(amount)} locked. Call escrow_release when delivery is confirmed, or escrow_dispute if there's a problem.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "escrow_release",
    "Confirm delivery and release escrowed USDC to the seller. Only call this when you've verified the service/product was delivered correctly.",
    {
      escrow_id: z.string().describe("The escrow ID to release"),
    },
    async ({ escrow_id }) => {
      const client = getEscrowClient();
      const escrowId = BigInt(escrow_id);

      const txHash = await client.release(escrowId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              escrowId: escrow_id,
              action: "released",
              txHash,
              message: `Escrow #${escrow_id} released. Funds sent to seller.`,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "escrow_dispute",
    "Flag a problem with delivery. Locks the escrowed funds for arbiter review. Use when the service was not delivered or quality was unacceptable.",
    {
      escrow_id: z.string().describe("The escrow ID to dispute"),
      reason: z
        .string()
        .describe("Brief description of the problem for the arbiter"),
    },
    async ({ escrow_id, reason }) => {
      const client = getEscrowClient();
      const escrowId = BigInt(escrow_id);

      const txHash = await client.dispute(escrowId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              escrowId: escrow_id,
              action: "disputed",
              reason,
              txHash,
              message: `Escrow #${escrow_id} disputed. Funds locked for arbiter review. Reason: ${reason}`,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "escrow_status",
    "Check the current state of an escrow (funded, released, disputed, expired, etc.)",
    {
      escrow_id: z.string().describe("The escrow ID to check"),
    },
    async ({ escrow_id }) => {
      const client = getEscrowClient();
      const escrowId = BigInt(escrow_id);

      const data = await client.getEscrow(escrowId);
      const expired = await client.isExpired(escrowId);

      const stateNames = [
        "Created",
        "Funded",
        "Released",
        "Disputed",
        "Resolved",
        "Expired",
        "Refunded",
      ];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                escrowId: escrow_id,
                state: stateNames[data.state] ?? "Unknown",
                buyer: data.buyer,
                seller: data.seller,
                amount: formatUsdc(data.amount),
                createdAt: new Date(
                  Number(data.createdAt) * 1000
                ).toISOString(),
                expiresAt: new Date(
                  Number(data.expiresAt) * 1000
                ).toISOString(),
                isExpired: expired,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
