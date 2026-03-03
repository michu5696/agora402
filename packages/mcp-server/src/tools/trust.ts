import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// In-memory trust store for v1 (PostgreSQL in v2)
const trustStore = new Map<
  string,
  {
    score: number;
    totalEscrows: number;
    successfulEscrows: number;
    disputedEscrows: number;
    lastUpdated: string;
  }
>();

export function updateTrustScore(
  address: string,
  outcome: "released" | "disputed" | "refunded"
): void {
  const existing = trustStore.get(address.toLowerCase()) ?? {
    score: 50,
    totalEscrows: 0,
    successfulEscrows: 0,
    disputedEscrows: 0,
    lastUpdated: new Date().toISOString(),
  };

  existing.totalEscrows++;

  if (outcome === "released") {
    existing.successfulEscrows++;
    // Score increases on successful delivery, diminishing returns
    existing.score = Math.min(
      100,
      existing.score + Math.max(1, 10 - existing.totalEscrows * 0.1)
    );
  } else if (outcome === "disputed") {
    existing.disputedEscrows++;
    // Score drops more steeply on disputes
    existing.score = Math.max(0, existing.score - 15);
  }
  // Refunded (expired) has no score impact — it's neutral

  existing.lastUpdated = new Date().toISOString();
  trustStore.set(address.toLowerCase(), existing);
}

export function registerTrustTools(server: McpServer): void {
  server.tool(
    "trust_score_query",
    "Look up the trust score of an agent address before transacting. Score is 0-100 based on escrow history.",
    {
      address: z
        .string()
        .describe("Ethereum address of the agent to look up"),
    },
    async ({ address }) => {
      const data = trustStore.get(address.toLowerCase());

      if (!data) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                address,
                score: null,
                message:
                  "No escrow history found for this address. This is a new/unknown agent — proceed with caution and use small escrow amounts.",
                recommendation: "low_trust",
              }),
            },
          ],
        };
      }

      const successRate =
        data.totalEscrows > 0
          ? ((data.successfulEscrows / data.totalEscrows) * 100).toFixed(1)
          : "0";

      let recommendation: string;
      if (data.score >= 80) recommendation = "high_trust";
      else if (data.score >= 50) recommendation = "moderate_trust";
      else recommendation = "low_trust";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                score: data.score,
                totalEscrows: data.totalEscrows,
                successfulEscrows: data.successfulEscrows,
                disputedEscrows: data.disputedEscrows,
                successRate: `${successRate}%`,
                lastUpdated: data.lastUpdated,
                recommendation,
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
