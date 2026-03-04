import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  PayCrowFacilitator,
  type PayCrowFacilitatorConfig,
  type PaymentPayload,
  type PaymentRequirements,
} from "./facilitator.js";

/**
 * Start an HTTP server that implements the x402 Facilitator API.
 *
 * Endpoints:
 *   POST /verify     — Verify a payment payload
 *   POST /settle     — Settle a payment through PayCrow escrow
 *   GET  /supported  — Return supported schemes and networks
 *
 * Resource servers point their facilitator URL here:
 *   facilitatorUrl: "http://localhost:4020"
 *
 * This replaces https://x402.org/facilitator with escrow-protected settlement.
 */
export function startFacilitatorServer(
  config: PayCrowFacilitatorConfig & { port?: number }
): ReturnType<typeof createServer> {
  const facilitator = new PayCrowFacilitator(config);
  const port = config.port ?? 4020;

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  function json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  const server = createServer(async (req, res) => {
    // CORS headers (allow any origin for dev, restrict in production)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    try {
      // GET /supported
      if (req.method === "GET" && url.pathname === "/supported") {
        json(res, 200, facilitator.getSupported());
        return;
      }

      // POST /verify
      if (req.method === "POST" && url.pathname === "/verify") {
        const body = JSON.parse(await readBody(req)) as {
          paymentPayload: PaymentPayload;
          paymentRequirements: PaymentRequirements;
        };
        const result = await facilitator.verify(
          body.paymentPayload,
          body.paymentRequirements
        );
        json(res, 200, result);
        return;
      }

      // POST /settle
      if (req.method === "POST" && url.pathname === "/settle") {
        const body = JSON.parse(await readBody(req)) as {
          paymentPayload: PaymentPayload;
          paymentRequirements: PaymentRequirements;
        };
        const result = await facilitator.settle(
          body.paymentPayload,
          body.paymentRequirements
        );
        json(res, result.success ? 200 : 500, result);
        return;
      }

      // GET / — health check
      if (req.method === "GET" && url.pathname === "/") {
        json(res, 200, {
          name: "paycrow-facilitator",
          version: "0.1.0",
          description:
            "x402 facilitator with PayCrow escrow protection. Drop-in replacement for x402.org/facilitator.",
          endpoints: ["/verify", "/settle", "/supported"],
        });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 500, {
        error: error instanceof Error ? error.message : "Internal error",
      });
    }
  });

  server.listen(port, () => {
    console.log(`PayCrow facilitator running at http://localhost:${port}`);
    console.log(`  POST /verify     — Verify payment`);
    console.log(`  POST /settle     — Settle through escrow`);
    console.log(`  GET  /supported  — Supported schemes`);
    console.log("");
    console.log(
      `Resource servers: set facilitatorUrl to http://localhost:${port}`
    );
  });

  return server;
}
