# Shared dev image for server / web / agent / migrate services.
# Runs TypeScript directly via tsx / vite (no separate build step in dev).
FROM node:22-alpine

RUN corepack enable
WORKDIR /app

# Install deps first (better layer caching). Copy only manifests + lockfile.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY packages/agent/package.json packages/agent/package.json

# esbuild's native binary is allow-listed via root package.json pnpm.onlyBuiltDependencies.
RUN pnpm install --frozen-lockfile

# Fallback copy of sources (runtime bind-mount usually shadows this in dev).
COPY . .

EXPOSE 4000 5173
CMD ["node", "-e", "console.log('set a command in docker-compose.yml')"]
