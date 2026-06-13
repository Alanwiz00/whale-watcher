# Deployment

## Local / single host (Docker Compose)

```bash
cp .env.example .env          # set secrets (DB password, TELEGRAM_BOT_TOKEN, API_KEYS…)
docker compose up -d --build  # postgres, redis, migrate, collectors, engine, api, bot, web, prometheus, grafana
docker compose logs -f engine
```

The `migrate` service runs `prisma migrate deploy` once before the app services
start (compose `depends_on … service_completed_successfully`). On first boot you
need a migration committed — generate it locally:

```bash
docker compose up -d postgres
pnpm db:migrate            # creates packages/db/prisma/migrations/*
```

Endpoints once up:

| URL                          | What                         |
| ---------------------------- | ---------------------------- |
| http://localhost:4000        | API (`/health`, `/api/*`)    |
| ws://localhost:4000/ws       | realtime feed                |
| http://localhost:3000        | dashboard                    |
| http://localhost:9090        | Prometheus                   |
| http://localhost:3001        | Grafana (admin / `$GRAFANA_ADMIN_PASSWORD`) |

## Dokploy

WhaleWatcher is a standard Compose app, so it drops straight into Dokploy:

1. **Create project → Compose service**, point it at this repo (or a registry).
2. Set the **Environment** from `.env.example` (Dokploy injects them; compose
   reads `env_file: .env` + the `x-service-env` overrides for in-cluster DNS).
3. Add a **persistent volume** mapping for `pgdata`, `redisdata`, `grafanadata`.
4. Configure **domains**: route `api.<host>` → `api:4000`, `<host>` → `web:3000`,
   `grafana.<host>` → `grafana:3000`. Enable Dokploy's Traefik TLS.
5. Set **health checks** to the API `/health` (already declared in compose).
6. Deploy. The `migrate` one-shot runs automatically on each release.

Scaling on Dokploy: bump `engine` replicas (stateless workers) freely; keep
`collectors` at 1 replica per platform to avoid duplicate polling, or shard the
tracked-market set by platform across replicas.

## Database operations

```bash
pnpm db:migrate        # dev: create + apply a migration
pnpm db:studio         # inspect data
pnpm db:seed           # reference markets for an empty DB
# prod: prisma migrate deploy (run by the `migrate` container)
```

### TimescaleDB (optional, recommended >100k trades/day)

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
SELECT create_hypertable('trades', 'timestamp', migrate_data => true);
SELECT create_hypertable('order_books', 'timestamp', migrate_data => true);
SELECT create_hypertable('market_snapshots', 'timestamp', migrate_data => true);
-- retention: keep raw order books 30d, trades 1y
SELECT add_retention_policy('order_books', INTERVAL '30 days');
```

## Tuning knobs (env)

| Var                    | Effect                                             |
| ---------------------- | -------------------------------------------------- |
| `WHALE_THRESHOLD_USD`  | single-trade whale trigger (default 300000)        |
| `SPLIT_WINDOW_MS` / `SPLIT_THRESHOLD_USD` | accumulation window + aggregate |
| `STEAM_MOVE_PCT` / `STEAM_WINDOW_MS`      | steam sensitivity              |
| `ARB_MIN_EDGE`         | minimum net edge to flag arbitrage                 |
| `*_INTERVAL_MS`        | discovery / trades / orderbook poll cadence        |

Lower poll intervals = fresher data + more API calls. Mind venue rate limits
(especially The Odds API quota — it's discovery-only by design).
