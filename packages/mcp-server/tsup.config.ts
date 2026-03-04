import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  // Bundle workspace packages inline so npm package is self-contained
  noExternal: [
    "@paycrow/core",
    "@paycrow/escrow-client",
    "@paycrow/trust",
    "@paycrow/verification",
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
