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
import { type Address, type Hash, isAddress } from "viem";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { computeTrustScore, type CompositeTrustScore, type TrustEngineConfig } from "./engine.js";
import { ESCROW_ADDRESSES, USDC_ADDRESSES } from "@paycrow/core";
import { EscrowClient } from "@paycrow/escrow-client";
import { registerAllTools } from "./tools.js";
import { base, baseSepolia } from "viem/chains";
import { TtlCache } from "./utils/cache.js";
import { RateLimiter } from "./utils/rate-limit.js";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

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
  const usdcAddress = USDC_ADDRESSES[chainName === "base" ? base.id : baseSepolia.id];

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

  // Trust score cache — avoids re-querying 4 sources for same address within TTL
  const trustCache = new TtlCache<CompositeTrustScore>({
    ttlMs: 60_000,   // 1 minute TTL
    maxSize: 5000,
  });

  // Rate limiter — prevent DoS on /trust endpoint
  const rateLimiter = new RateLimiter({
    maxRequests: 100,  // 100 requests per minute per IP
    windowMs: 60_000,
  });

  function getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
    return req.socket.remoteAddress ?? "unknown";
  }

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

  // Build Bazaar discovery extension via @x402/extensions SDK
  const bazaarExtension = declareDiscoveryExtension({
    input: {
      address: "0x0000000000000000000000000000000000000001",
    },
    inputSchema: {
      properties: {
        address: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Ethereum address to check trust score for",
        },
      },
      required: ["address"],
    },
    output: {
      example: {
        score: 78,
        confidence: "high",
        confidencePercent: 83,
        recommendation: "high_trust",
        sourcesUsed: ["paycrow", "erc8004", "base-chain"],
      },
      schema: {
        type: "object",
        properties: {
          score: { type: "number" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          confidencePercent: { type: "number" },
          recommendation: { type: "string" },
          sourcesUsed: { type: "array", items: { type: "string" } },
        },
        required: ["score", "confidence", "recommendation"],
      },
    },
  });

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
      extensions: bazaarExtension,
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
    const mcp = new McpServer({ name: "paycrow", version: "1.2.0" });

    // Register all 10 tools from the shared registration module
    registerAllTools(mcp, {
      trustConfig: {
        chain: chainName as "base" | "base-sepolia",
        rpcUrl: config.rpcUrl,
        reputationAddress: config.reputationAddress,
        basescanApiKey: config.basescanApiKey,
        moltbookAppKey: config.moltbookAppKey,
      },
      getEscrowClient,
      chain: chainName === "base" ? base : baseSepolia,
      rpcUrl: config.rpcUrl ?? (chainName === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org"),
      reputationAddress: config.reputationAddress ?? (chainName === "base"
        ? "0x9Ea8c817bFDfb15FA50a30b08A186Cb213F11BCC" as Address
        : "0x2A216a829574e88dD632e7C95660d43bCE627CDf" as Address),
      chainName,
    });

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
          version: "1.2.0",
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
          version: "1.2.0",
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
          version: "1.2.0",
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
          instructions: "PayCrow — the trust and escrow protection layer for x402 agent payments. Vet counterparties before transacting. GET /trust/{address} for trust scores ($0.001 USDC). Full MCP server at /mcp with 9 tools: safe_pay, trust_gate, escrow_create, escrow_release, escrow_dispute, escrow_status, trust_score_query, trust_onchain_quick, x402_protected_call. npm install -g paycrow.",
          discovery: `${url.origin}/discovery/resources`,
          mcp: `${url.origin}/mcp`,
        });
        return;
      }

      // ── llms.txt (AI crawler discovery) ──
      if (req.method === "GET" && url.pathname === "/llms.txt") {
        res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        res.end(`# PayCrow — The Trust Layer for Agent Commerce
# PayPal for autonomous agents. Escrow + Trust + Dispute Resolution on Base.

> The only escrow service with real on-chain dispute resolution on Base/EVM.
> x402 handles payments. Bazaar handles discovery. PayCrow handles trust.

## What PayCrow Does
1. **Trust Scoring** — Vet agents before paying. 4 on-chain sources (PayCrow escrow history, ERC-8004 identity, Moltbook karma, Base chain activity). Score 0-100 with confidence.
2. **Smart Escrow** — USDC locked in smart contract until delivery confirmed. Auto-release on success, auto-dispute on failure.
3. **Dispute Resolution** — The only escrow on Base with real arbiter review. Competitors say "no disputes, no chargebacks." We solve that.

## How to Use
\`\`\`
# Install MCP server
npm install -g paycrow
npx paycrow

# Or connect via HTTP
POST ${url.origin}/mcp
\`\`\`

## 9 MCP Tools
- **safe_pay** — Smart payment: trust check → escrow → API call → auto-resolve. The recommended way to pay any agent.
- **trust_gate** — Go/no-go decision with recommended escrow params. Call BEFORE paying.
- **trust_score_query** — Full 4-source trust breakdown.
- **trust_onchain_quick** — Free on-chain-only reputation check.
- **escrow_create** — Create USDC escrow with dispute resolution.
- **escrow_release** — Confirm delivery, release funds to seller.
- **escrow_dispute** — Flag bad delivery, lock funds for arbiter.
- **escrow_status** — Check escrow state.
- **x402_protected_call** — Advanced escrow with custom verification (JSON Schema / hash-lock).

## API Endpoints
- GET /trust/{address} — Trust score query ($${Number(price) / 1e6} USDC via x402)
- GET /trust/{address} (no payment) — Free preview (score + recommendation, no source breakdown)
- POST /mcp — MCP-over-HTTP (Streamable HTTP)
- GET /discovery/resources — x402 Bazaar catalog
- GET /.well-known/agent.json — A2A agent card
- GET /.well-known/x402 — x402 manifest
- GET /health — Health check
- GET /stats — Usage stats

## Payment
Network: Base (${network})
Asset: USDC (${usdcAddress})
Amount: $${Number(price) / 1e6} per trust query
Facilitator: ${facilitatorUrl}

## Smart Contracts (Base Mainnet)
Escrow: ${ESCROW_ADDRESSES[8453] ?? "deployed"}
USDC: ${usdcAddress}
`);
        return;
      }

      // ── x402 Bazaar discovery ──
      // Full PayCrow service catalog for agent discovery.
      // Uses @x402/extensions SDK for proper DiscoveredHTTPResource format.
      if (req.method === "GET" && url.pathname === "/discovery/resources") {
        // Extract discoveryInfo from the SDK-generated extension
        const bazaarExt = bazaarExtension.bazaar as { info: unknown; schema: unknown };
        json(res, 200, {
          provider: {
            name: "PayCrow",
            description: "Escrow protection for autonomous agent payments. PayPal for AI agents. The trust and dispute resolution layer for x402.",
            url: url.origin,
            category: "trust-and-escrow",
          },
          resources: [
            {
              resourceUrl: `${url.origin}/trust/{address}`,
              method: "GET",
              description: "Vet an agent before sending funds. Returns 0-100 trust score from 4 on-chain sources (PayCrow escrow history, ERC-8004 identity, Moltbook karma, Base chain activity) with confidence level and go/no-go recommendation. Free preview included, full breakdown requires $0.001 USDC payment.",
              mimeType: "application/json",
              x402Version: 2,
              discoveryInfo: bazaarExt.info,
              scheme: "exact",
              network,
              maxAmountRequired: price,
              asset: usdcAddress,
              payTo: config.payTo,
              tags: ["trust", "reputation", "payment-protection", "escrow", "agent-vetting", "erc-8004", "moltbook", "risk-assessment"],
              rateLimit: { requests: 100, period: "minute" },
            },
          ],
          mcpServer: {
            description: "Full escrow + trust MCP server with 9 tools. Install via npm or connect over HTTP.",
            transport: "streamable-http",
            endpoint: `${url.origin}/mcp`,
            npmPackage: "paycrow",
            tools: [
              {
                name: "trust_gate",
                description: "Go/no-go decision before paying an agent. Returns recommended escrow parameters (timelock, max amount) based on trust level.",
                tags: ["trust", "pre-payment", "risk-assessment"],
              },
              {
                name: "safe_pay",
                description: "Trust-informed smart escrow. Auto-checks trust → creates escrow → calls API → auto-releases on success or auto-disputes on failure. The recommended way to pay any agent.",
                tags: ["payment", "escrow", "trust", "auto-protection"],
              },
              {
                name: "trust_score_query",
                description: "Full 4-source trust score breakdown with per-source details and confidence metrics.",
                tags: ["trust", "reputation", "analytics"],
              },
              {
                name: "escrow_create",
                description: "Create a USDC escrow with built-in dispute resolution on Base. Funds locked until delivery confirmed or disputed.",
                tags: ["escrow", "payment", "dispute-resolution"],
              },
              {
                name: "escrow_release",
                description: "Confirm delivery and release escrowed funds to seller.",
                tags: ["escrow", "payment"],
              },
              {
                name: "escrow_dispute",
                description: "Flag a problem — the only escrow with real on-chain dispute resolution on Base. Locks funds for arbiter review.",
                tags: ["escrow", "dispute", "buyer-protection"],
              },
              {
                name: "escrow_status",
                description: "Check current state of an escrow (funded, released, disputed, expired).",
                tags: ["escrow", "status"],
              },
              {
                name: "x402_protected_call",
                description: "Advanced escrow with manual verification (JSON Schema or hash-lock). Full control over protection parameters.",
                tags: ["escrow", "verification", "advanced"],
              },
              {
                name: "trust_onchain_quick",
                description: "Quick on-chain reputation check using PayCrow contract only. Free, no API keys needed.",
                tags: ["trust", "free", "on-chain"],
              },
            ],
          },
          contracts: {
            chain: chainName,
            network,
            escrow: ESCROW_ADDRESSES[chainName === "base" ? 8453 : 84532],
            usdc: usdcAddress,
          },
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

        // Rate limit check
        const clientIp = getClientIp(req);
        const rateCheck = rateLimiter.check(clientIp);
        if (!rateCheck.allowed) {
          json(res, 429, {
            error: "Too many requests",
            retryAfterSeconds: Math.ceil(rateCheck.retryAfterMs / 1000),
          }, {
            "Retry-After": String(Math.ceil(rateCheck.retryAfterMs / 1000)),
          });
          return;
        }

        // Check for x402 payment header
        const paymentSig = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;

        if (!paymentSig) {
          // Free preview: compute score but only return summary (no source breakdown)
          // Use cache to avoid repeated queries
          const cacheKey = queryAddress.toLowerCase();
          let preview = trustCache.get(cacheKey);
          if (!preview) {
            preview = await computeTrustScore(queryAddress, {
              chain: chainName,
              rpcUrl: config.rpcUrl,
              reputationAddress: config.reputationAddress,
              moltbookAppKey: config.moltbookAppKey,
              basescanApiKey: config.basescanApiKey,
            });
            trustCache.set(cacheKey, preview);
          }

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

        // Compute and return trust score (use cache)
        const cacheKey = queryAddress.toLowerCase();
        let trustScore = trustCache.get(cacheKey);
        if (!trustScore) {
          trustScore = await computeTrustScore(queryAddress, {
            chain: chainName,
            rpcUrl: config.rpcUrl,
            reputationAddress: config.reputationAddress,
            moltbookAppKey: config.moltbookAppKey,
            basescanApiKey: config.basescanApiKey,
          });
          trustCache.set(cacheKey, trustScore);
        }

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
