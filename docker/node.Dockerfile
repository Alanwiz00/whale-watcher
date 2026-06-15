# Single image for ALL long-running Node services (collectors / engine / api /
# bot). The service is chosen at RUNTIME via the APP env var — NOT a build arg —
# so platforms that only reliably set env vars (e.g. Dokploy) just work. The web
# dashboard has its own image (docker/web.Dockerfile).
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

# ── deps + build ────────────────────────────────────────────────────────────
FROM base AS build
ENV CI=true
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @whale/db generate
# Build every node service (web is built by docker/web.Dockerfile).
RUN pnpm --filter @whale/api --filter @whale/engine --filter @whale/collectors --filter @whale/bot build
# Drop dev dependencies for a smaller runtime layer.
RUN pnpm install --prod --no-frozen-lockfile

# ── runtime ──────────────────────────────────────────────────────────────────
# Named `production` so `--target production` (Dokploy) resolves; also the last
# stage, so plain builds (docker-compose, CI) without a target still build it.
FROM base AS production
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 4000 9100 9101
# APP (api|engine|collectors|bot) selects the service — set it in the runtime
# environment. RUN_MIGRATIONS=true (api only) applies pending Prisma migrations
# first; a failure aborts startup so we never boot against a bad schema. `exec`
# makes the service PID 1 for correct signal handling.
CMD ["sh", "-c", ": \"${APP:?set APP to api|engine|collectors|bot}\"; if [ \"$RUN_MIGRATIONS\" = \"true\" ]; then echo '-> prisma migrate deploy'; pnpm --filter @whale/db migrate:deploy; fi && exec node apps/$APP/dist/index.js"]
