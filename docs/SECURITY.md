# Security hardening

## Secrets
- All secrets come from env via the validated `@whale/core` config — never
  hard-coded. `.env` is git-ignored; only `.env.example` is committed.
- Logger redacts `authorization`, tokens, passwords, and key paths.
- Rotate `TELEGRAM_BOT_TOKEN`, `API_KEYS`, DB password, and `INTERNAL_JWT_SECRET`
  on a schedule and on any suspected exposure.

## API surface
- Read endpoints are public but **rate-limited** (`@fastify/rate-limit`, 240/min
  per IP; `/health` and `/metrics` allow-listed).
- Mutating/sensitive endpoints use `requireApiKey` (Bearer token in `API_KEYS`).
  If `API_KEYS` is empty the guard is disabled — **set it in production**.
- CORS origin is restricted via `API_CORS_ORIGIN` (don't ship `*` in prod).
- Body size capped (1 MB) and `trustProxy` enabled for correct client IPs
  behind Traefik/Dokploy.
- `/metrics` exposes operational data — scope it to the internal network /
  Prometheus only; do not expose publicly.

## Telegram
- Optional `TELEGRAM_ADMIN_CHAT_IDS` allow-list for privileged commands.
- A Redis token bucket caps outbound messages (~20/s) under Telegram's limits.
- Bot uses long polling by default; for webhooks, terminate TLS at the proxy and
  validate Telegram's secret token header.

## Database
- Least-privilege DB role for the app (CRUD on app schema only; no superuser).
- Connection pool bounded via `connection_limit` in `DATABASE_URL`.
- Prisma parameterizes all queries (no string-built SQL).
- Enable TLS to Postgres in prod (`sslmode=require`).

## Containers / supply chain
- Multi-stage images, non-root recommended (add `USER node` in prod images).
- `pnpm install --prod` strips dev deps from the runtime layer.
- Pin base images by digest in prod; run `pnpm audit` / Trivy in CI.
- Lockfile committed; CI installs from it.

## Network
- Only `api` (4000), `web` (3000), and Grafana need ingress. Keep Postgres,
  Redis, Prometheus, and the `*/metrics` ports on the internal Docker network.
- Put the API and dashboard behind the reverse proxy with TLS + HSTS.

## Data & compliance
- This platform ingests **public** market data. Respect each venue's Terms of
  Service and rate limits; some prohibit scraping or automated access.
- Wallet addresses are public on-chain identifiers (Polymarket); treat any
  derived labels carefully and avoid doxxing. Output is intelligence, **not**
  financial advice — log that disclaimer where alerts are surfaced.

## Reporting
Report vulnerabilities privately to the maintainers before public disclosure.
