# Next.js dashboard (standalone output).
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @whale/web build

FROM node:22-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# Next standalone preserves the monorepo path layout.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
