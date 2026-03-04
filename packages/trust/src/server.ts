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
import { type Address, isAddress } from "viem";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { computeTrustScore, type TrustEngineConfig } from "./engine.js";

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

  function createMcpServer(): McpServer {
    const mcp = new McpServer({ name: "paycrow", version: "1.0.0" });

    mcp.tool(
      "trust_score_query",
      "Check if an agent is safe to transact with before sending funds to escrow. Scores 0-100 from 4 on-chain sources: escrow history, ERC-8004 identity, Moltbook karma, and Base chain activity. Part of PayCrow's payment protection layer.",
      { address: z.string().describe("Ethereum address to check") },
      async ({ address: addr }) => {
        const score = await computeTrustScore(addr as Address, {
          chain: chainName as "base" | "base-sepolia",
          rpcUrl: config.rpcUrl,
          reputationAddress: config.reputationAddress,
          basescanApiKey: config.basescanApiKey,
          moltbookAppKey: config.moltbookAppKey,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(score, null, 2) }] };
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
              id: "trust_score_query",
              name: "Trust Score Query",
              description: "Check if an agent is safe to transact with before sending funds to escrow. Scores 0-100 from 4 on-chain sources: escrow history, ERC-8004 identity, Moltbook karma, and Base chain activity.",
              tags: ["escrow", "trust", "reputation", "agent", "payment-protection", "erc-8004", "moltbook", "base"],
              examples: [
                "Is this agent safe to transact with? Check 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
                "Vet this counterparty before I send funds to escrow",
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
              name: "trust_score_query",
              description: "Check if an agent is safe to transact with before sending funds to escrow. Scores 0-100 from 4 on-chain sources: escrow history, ERC-8004 identity, Moltbook karma, and Base chain activity.",
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
