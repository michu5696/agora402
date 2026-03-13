// ── CLI: `npx paycrow serve` — Start x402-gated Trust Score API ────
if (process.argv[2] === "serve") {
  const { startTrustServer } = await import("@paycrow/trust");
  const { getChainName, getRpcUrl, getReputationAddress } = await import(
    "./config.js"
  );

  const payTo = process.env.PAY_TO;
  if (!payTo) {
    console.error(`
  PayCrow Trust API — Missing Configuration
  ───────────────────────────────────────────

  PAY_TO is required: your wallet address to receive USDC payments.

  Usage:
    PAY_TO=0xYourAddress CHAIN=base npx paycrow serve

  Required env vars:
    PAY_TO              Your wallet address for receiving USDC
    CHAIN               "base" (mainnet) or "base-sepolia" (testnet)

  Optional env vars:
    PORT                HTTP port (default: 4021)
    PRICE_USDC          Price per query in USDC base units (default: 1000 = $0.001)
    BASESCAN_API_KEY    For Base chain activity data (free at basescan.org)
    MOLTBOOK_APP_KEY    For Moltbook social reputation (optional)
    FACILITATOR_URL     x402 facilitator (default: https://facilitator.xpay.sh)
    BASE_RPC_URL        Custom RPC for Base mainnet
`);
    process.exit(1);
  }

  const port = process.env.PORT ? parseInt(process.env.PORT) : 4021;
  const chainName = getChainName() as "base" | "base-sepolia";

  startTrustServer({
    port,
    payTo: payTo as `0x${string}`,
    chain: chainName,
    rpcUrl: getRpcUrl(),
    reputationAddress: getReputationAddress(),
    priceUsdc: process.env.PRICE_USDC ?? "1000",
    facilitatorUrl:
      process.env.FACILITATOR_URL ?? "https://facilitator.xpay.sh",
    basescanApiKey: process.env.BASESCAN_API_KEY,
    moltbookAppKey: process.env.MOLTBOOK_APP_KEY,
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  await new Promise(() => {});
}

// ── CLI: `npx paycrow init` ────────────────────────────────────────
if (process.argv[2] === "init") {
  const { generatePrivateKey, privateKeyToAccount } = await import(
    "viem/accounts"
  );

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  console.log(`
  PayCrow — Agent Wallet Setup
  ─────────────────────────────

  Your new agent wallet:
    Address:     ${account.address}
    Private Key: ${privateKey}

  SAVE THE PRIVATE KEY — it cannot be recovered.

  Next steps:
    1. Fund the wallet with ETH (for gas) + USDC on Base
       Send to: ${account.address}

    2. Add to Claude Desktop config (~/.claude/claude_desktop_config.json):

       {
         "mcpServers": {
           "paycrow": {
             "command": "npx",
             "args": ["paycrow"],
             "env": {
               "PRIVATE_KEY": "${privateKey}"
             }
           }
         }
       }

    3. Restart Claude Desktop — your agent now has escrow protection.

  That's it. Your agent can now use:
    - x402_protected_call  — pay for APIs with escrow protection
    - escrow_create         — lock USDC in escrow
    - trust_score_query     — check any agent's reputation
`);

  process.exit(0);
}

// ── MCP Server (lazy imports — only loaded when actually serving) ────
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await import(
  "@modelcontextprotocol/sdk/server/stdio.js"
);
const { registerEscrowTools } = await import("./tools/escrow.js");
const { registerTrustTools } = await import("./tools/trust.js");
const { registerX402Tools } = await import("./tools/x402.js");

const server = new McpServer({
  name: "paycrow",
  version: "1.0.0",
});

// Trust tools always work (read-only, no wallet needed)
registerTrustTools(server);

// Escrow + payment tools need PRIVATE_KEY — register them but they'll
// return helpful errors if no wallet is configured
registerEscrowTools(server);
registerX402Tools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
