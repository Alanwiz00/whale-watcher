# Generic build image for the Node services (collectors / engine / api / bot).
# Pass the target with `--build-arg APP=<name>`.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

# ── deps + build ────────────────────────────────────────────────────────────
FROM base AS build
ARG APP
COPY pnpm-workspace.yaml package.json .npmrc ./
COPY pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @whale/db generate
RUN pnpm --filter @whale/${APP} build
# Drop dev dependencies for a smaller runtime layer.
RUN pnpm install --prod --no-frozen-lockfile

# ── runtime ──────────────────────────────────────────────────────────────────
# Stage is named `production` so builders that pass `--target production`
# (e.g. Dokploy) resolve it. It's also the last stage, so plain builds
# (docker-compose, CI) that don't pass a target still build it.
FROM base AS production
ARG APP
ENV NODE_ENV=production
ENV APP=${APP}
COPY --from=build /app /app
EXPOSE 4000 9100 9101
# APP is fixed at build time. When RUN_MIGRATIONS=true (set it on the api service
# only), apply pending Prisma migrations before starting — a migration failure
# aborts startup so we never boot against a bad schema. `exec` makes the service
# PID 1 for correct signal handling.
CMD ["sh", "-c", "if [ \"$RUN_MIGRATIONS\" = \"true\" ]; then echo '→ prisma migrate deploy'; pnpm --filter @whale/db migrate:deploy; fi && exec node apps/$APP/dist/index.js"]
