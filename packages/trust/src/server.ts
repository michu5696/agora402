/**
 * x402-Gated Trust Score API Server
 *
 * Serves trust scores behind an x402 paywall so autonomous agents
 * can discover and pay for trust checks without human intervention.
 *
 * Endpoints:
 *   GET /trust/:address           — Returns 402 with payment requirements
 *   GET /trust/:address + payment — Returns composite trust score
 *   GET /discovery/resources      — x402 Bazaar catalog for agent discovery
 *   GET /health                   — Health check
 *
 * The 402 flow:
 *   1. Agent requests GET /trust/0x...
 *   2. Server returns 402 with PaymentRequirements (price: $0.001 USDC)
 *   3. Agent signs ERC-3009 authorization and retries with PAYMENT-SIGNATURE header
 *   4. Facilitator verifies + settles payment
 *   5. Server returns full composite trust score
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type Address, isAddress } from "viem";
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
        description: "Composite agent trust score from 4 on-chain sources (Agora402 Reputation, ERC-8004, Moltbook, Base chain activity). Returns score 0-100 with confidence level, recommendation, and per-source breakdown.",
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
                sourcesUsed: ["agora402", "erc8004", "base-chain"],
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

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
      });
      res.end();
      return;
    }

    const host = req.headers.host ?? `localhost:${port}`;
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    const url = new URL(req.url ?? "/", `${proto}://${host}`);

    try {
      // ── Health check ──
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          name: "agora402-trust-api",
          version: "1.0.0",
          description: "x402-gated agent trust scoring API. Pay $0.001 USDC per query.",
          chain: chainName,
          price: `$${Number(price) / 1e6} USDC`,
          sources: ["agora402-reputation", "erc-8004", "moltbook", "base-chain-activity"],
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
          instructions: "Composite trust scores for autonomous agents. GET /trust/{address} to query. Price: $0.001 USDC on Base via x402.",
        });
        return;
      }

      // ── llms.txt (AI crawler discovery) ──
      if (req.method === "GET" && url.pathname === "/llms.txt") {
        res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end(`# Agora402 Trust Score API
# x402-gated agent trust scoring service

> Composite trust scores for Ethereum addresses on Base.
> Aggregates Agora402 escrow reputation, ERC-8004 identity, Moltbook social, and Base chain activity.
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
npm install -g agora402
npx agora402
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
              description: "Composite agent trust score aggregating 4 on-chain sources: Agora402 escrow reputation, ERC-8004 agent identity & feedback, Moltbook social karma, and Base chain activity. Returns score 0-100 with confidence level and per-source breakdown.",
              scheme: "exact",
              network,
              maxAmountRequired: price,
              asset: usdcAddress,
              mimeType: "application/json",
              tags: ["trust", "reputation", "agent", "escrow", "erc-8004", "moltbook"],
              rateLimit: { requests: 100, period: "minute" },
              example: {
                request: "GET /trust/0x1234...abcd",
                response: {
                  score: 78,
                  confidence: "high",
                  recommendation: "high_trust",
                  sourcesUsed: ["agora402", "erc8004", "base-chain"],
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

        if (!isAddress(queryAddress)) {
          json(res, 400, { error: "Invalid Ethereum address" });
          return;
        }

        // Check for x402 payment header
        const paymentSig = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;

        if (!paymentSig) {
          // Return 402 Payment Required with x402 v2 header
          const resource = `${url.origin}/trust/${queryAddress}`;
          const requirements = paymentRequirements(resource);
          const encoded = Buffer.from(JSON.stringify(requirements)).toString("base64");
          json(res, 402, requirements, {
            "PAYMENT-REQUIRED": encoded,
          });
          return;
        }

        // Verify and settle payment
        const resource = `${url.origin}/trust/${queryAddress}`;
        const payment = await verifyAndSettlePayment(paymentSig, resource);

        if (!payment.success) {
          json(res, 402, {
            error: "Payment verification failed",
            detail: payment.error,
            ...paymentRequirements(resource),
          });
          return;
        }

        // Payment succeeded — compute and return trust score
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
    console.log(`\nAgora402 Trust Score API running at http://localhost:${port}`);
    console.log(`  GET /trust/{address}        — Query trust score ($${Number(price) / 1e6} USDC per check)`);
    console.log(`  GET /discovery/resources     — x402 Bazaar catalog`);
    console.log(`  GET /health                  — Health check`);
    console.log(`\nChain: ${chainName} | Price: $${Number(price) / 1e6} USDC | PayTo: ${config.payTo}`);
    console.log(`Facilitator: ${facilitatorUrl}\n`);
  });

  return server;
}
