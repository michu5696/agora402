FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Only include packages needed for the trust API server
RUN echo 'packages:\n  - "packages/core"\n  - "packages/trust"\n  - "packages/db"\n  - "packages/escrow-client"\n  - "packages/verification"\n  - "packages/x402-bridge"\n  - "packages/mcp-server"' > pnpm-workspace.yaml

COPY packages/core/package.json packages/core/
COPY packages/trust/package.json packages/trust/
COPY packages/db/package.json packages/db/
COPY packages/escrow-client/package.json packages/escrow-client/
COPY packages/verification/package.json packages/verification/
COPY packages/x402-bridge/package.json packages/x402-bridge/
COPY packages/mcp-server/package.json packages/mcp-server/tsup.config.ts packages/mcp-server/

RUN pnpm install --no-frozen-lockfile

COPY packages/ packages/
RUN pnpm run build

ENV NODE_ENV=production
ENV CHAIN=base
ENV PORT=4021

EXPOSE 4021

CMD ["node", "packages/mcp-server/dist/index.js", "serve"]
