import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  // Bundle workspace packages inline so npm package is self-contained
  noExternal: [
    "@agora402/core",
    "@agora402/escrow-client",
    "@agora402/trust",
    "@agora402/verification",
  ],
  // Keep npm-published deps as external (users install them)
  external: [
    "@modelcontextprotocol/sdk",
    "viem",
    "zod",
  ],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
