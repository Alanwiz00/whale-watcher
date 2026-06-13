# 🐋 WhaleWatcher

**World Cup 2026 prediction-market whale & smart-money intelligence platform.**

WhaleWatcher discovers FIFA World Cup 2026 markets across prediction markets and
sportsbooks, ingests raw trades and order books, and runs a detection + scoring
pipeline that surfaces large bets ($300k+), smart/sharp-money movement, steam
moves, market-impact events and cross-platform arbitrage — then ships actionable
alerts to Telegram and a realtime API/dashboard.

```text
Collectors → Normalizer → Market DB → Detection → Whale Scoring → Alert Engine → Telegram / API / WS
```

---

## ⚠️ Read this first — what is real vs. interface

Honesty about data access matters in this domain:

| Platform     | Trade-level data | Identifiable wallets | Adapter status                              |
| ------------ | ---------------- | -------------------- | ------------------------------------------- |
| Polymarket   | ✅ public CLOB + Gamma + on-chain | ✅ on-chain addresses | **Implemented** (richest source)            |
| Kalshi       | ✅ public REST    | ⚠️ anonymized        | **Implemented**                             |
| Manifold     | ✅ public REST    | ✅ user ids (play $)  | **Implemented**                             |
| PredictIt    | ⚠️ aggregate only | ❌                   | Best-effort (rarely has WC markets)         |
| Betfair      | ⚠️ needs cert+funded acct | ❌            | Interface + stub (`ODDS_API` odds fallback) |
| Pinnacle     | ❌ no open API    | ❌                   | Interface + stub (`ODDS_API` odds fallback) |
| Stake / DK / FanDuel | ❌ no open trade API | ❌            | Interface + stub (odds-only via aggregator) |

Sportsbooks expose **odds**, not identifiable bettor wallets. WhaleWatcher treats
them as price feeds for arbitrage/steam detection, while genuine wallet-level
whale tracking comes from the on-chain / exchange-style venues (Polymarket,
Kalshi, Manifold). New venues plug in by implementing the `Collector` interface
in `apps/collectors/src/collectors/base.ts`.

---

## Stack

Node 22 · TypeScript · Fastify · Prisma · PostgreSQL 18 · Redis · BullMQ ·
WebSockets · Vitest · Telegram (telegraf) · Prometheus + Grafana · Docker Compose
· Dokploy.

## Monorepo layout

```text
whale-watcher/
├─ packages/
│  ├─ core/          shared types, config, logger, quant math, whale scoring
│  └─ db/            Prisma schema + client
├─ apps/
│  ├─ collectors/    discovery / trade / orderbook collectors + BullMQ producers
│  ├─ engine/        normalizer + detection + scoring + impact + arb + steam + alerts (workers)
│  ├─ api/           Fastify REST + WebSocket realtime feed + /metrics
│  ├─ bot/           Telegram bot (/whales /topwallets /markets /arbitrage /live …)
│  └─ web/           Next.js analytics dashboard
├─ monitoring/       Prometheus config + Grafana provisioning
├─ docker/           per-service Dockerfiles
├─ docs/             ARCHITECTURE.md · DEPLOYMENT.md · SECURITY.md
└─ docker-compose.yml
```

## Quick start (local)

```bash
# 0. Prereqs: Docker + corepack (ships with Node ≥16.9)
corepack enable && corepack prepare pnpm@9.12.0 --activate

# 1. Env
cp .env.example .env            # then edit secrets

# 2. Infra (Postgres 18 + Redis + Prometheus + Grafana)
docker compose up -d postgres redis

# 3. Install + generate Prisma client + migrate
pnpm install
pnpm db:generate
pnpm db:migrate

# 4. Run the pipeline (each in its own terminal, or `pnpm dev`)
pnpm dev:collectors    # ingests markets/trades/orderbooks → BullMQ
pnpm dev:engine        # consumes queues → detection/scoring/alerts
pnpm dev:api           # http://localhost:4000  (+ ws://localhost:4000/ws)
pnpm dev:bot           # Telegram bot (needs TELEGRAM_BOT_TOKEN)
pnpm dev:web           # http://localhost:3000  dashboard
```

Or run the whole stack in containers:

```bash
docker compose up -d --build
```

## Tests

```bash
pnpm test            # Vitest — scoring + detection math
pnpm test:coverage
```

## Key endpoints

| Method | Path                  | Description                          |
| ------ | --------------------- | ------------------------------------ |
| GET    | `/health`             | liveness/readiness                   |
| GET    | `/metrics`            | Prometheus metrics                   |
| GET    | `/api/whales`         | recent whale detections              |
| GET    | `/api/wallets/top`    | wallet leaderboard (ROI / volume)    |
| GET    | `/api/markets`        | tracked World Cup markets            |
| GET    | `/api/arbitrage`      | live cross-platform opportunities    |
| GET    | `/api/alerts`         | alert history                        |
| WS     | `/ws`                 | realtime whale/alert feed            |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md),
and [docs/SECURITY.md](docs/SECURITY.md).

## License

MIT — for research/educational use. Respect each venue's Terms of Service and
rate limits; you are responsible for your own compliance and any trading
decisions. This is intelligence tooling, not financial advice.
