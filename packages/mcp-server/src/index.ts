#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerEscrowTools } from "./tools/escrow.js";
import { registerTrustTools } from "./tools/trust.js";
import { registerX402Tools } from "./tools/x402.js";

const server = new McpServer({
  name: "agora402",
  version: "0.1.0",
});

// Register all tool groups
registerEscrowTools(server);
registerTrustTools(server);
registerX402Tools(server);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
