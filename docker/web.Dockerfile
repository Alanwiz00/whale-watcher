# Next.js dashboard (standalone output).
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* are inlined at build time, so they must be present here (not just
# at runtime). Pass via docker-compose build args. NEXT_PUBLIC_API_KEY is the
# token the dashboard sends to the now key-gated API.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_WS_URL=ws://localhost:4000/ws
ARG NEXT_PUBLIC_API_KEY=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_API_KEY=$NEXT_PUBLIC_API_KEY
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @whale/web build

# Named `production` so `--target production` (Dokploy) resolves; also the last
# stage, so plain builds (docker-compose, CI) without a target still build it.
FROM node:22-slim AS production
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Next standalone preserves the monorepo path layout.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
