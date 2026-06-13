# Architecture

```text
                 ┌──────────────┐
   venue APIs →  │  Collectors  │  discover markets · poll trades · poll books
                 └──────┬───────┘
                        │ BullMQ (q:markets / q:trades / q:orderbooks)
                 ┌──────▼───────┐
                 │    Engine    │  normalize → persist → detect → score → alert
                 └──────┬───────┘
        ┌───────────────┼────────────────┐
        │ Postgres      │ Redis pub/sub   │ Redis (BullMQ + cache + split sets)
        ▼               ▼                 ▼
   ┌─────────┐    ┌───────────┐     ┌──────────┐
   │   API   │◄───┤  Channels │────►│   Bot     │
   │ Fastify │    │ ww:whales │     │ Telegram  │
   │  + WS   │    │ ww:alerts │     └──────────┘
   └────┬────┘    └───────────┘
        ▼
   ┌─────────┐
   │   Web   │  Next.js dashboard (Overview/Wallets/Markets/Arbitrage/Live)
   └─────────┘
```

## Services

| Service        | Package            | Role                                                                 |
| -------------- | ------------------ | -------------------------------------------------------------------- |
| **collectors** | `@whale/collectors`| Discover markets, poll trades & order books, push normalized jobs.   |
| **engine**     | `@whale/engine`    | Consume jobs; normalize, persist, detect, score, alert; run scans.   |
| **api**        | `@whale/api`       | Fastify REST + WebSocket relay + Prometheus metrics.                 |
| **bot**        | `@whale/bot`       | Telegram commands + alert delivery.                                  |
| **web**        | `@whale/web`       | Next.js analytics dashboard.                                         |
| **core**       | `@whale/core`      | Shared types, config, logger, quant math, scoring, queue contracts.  |
| **db**         | `@whale/db`        | Prisma schema + client.                                              |

## Data flow & idempotency

Collectors hold an in-memory **tracked-market registry** (no DB dependency) so
they own their poll cursors. They emit `NormalizedMarket | NormalizedTrade |
NormalizedOrderBook` onto BullMQ. The engine is the only writer to Postgres.
Every external entity is keyed by `(platform, externalId)`, so re-ingesting the
same trade is a no-op — detection only runs on genuinely new rows.

## Detection modules (Modules 4–9)

- **Whale** (`detection/whale.ts`) — fires at `sizeUsd ≥ WHALE_THRESHOLD_USD`,
  scores with size + wallet ROI + market impact + timing, persists a
  `WhaleSignal`, emits a severity-graded alert.
- **Split accumulation** (`detection/split.ts`) — Redis sorted set per
  (wallet, market, outcome, side); fires when the windowed sum crosses the
  threshold across ≥2 legs. Wallet-native venues only.
- **Market impact** (`detection/impact.ts`) — signed Δ implied-prob around a
  trade using snapshots before/after (falls back to executed price).
- **Steam** (`detection/steam.ts`) — large odds move with no qualifying whale
  trade in the window ⇒ probable syndicate action.
- **Arbitrage** (`arbitrage.ts`) — groups markets by `canonicalKey`, builds a
  synthetic book from best per-outcome prices across venues; flags Σbestprob<1
  (riskless) and large per-outcome spreads (mispricing).

## Scoring (Module 6)

`computeWhaleScore` (in `@whale/core/scoring`) is a pure, weighted, normalized
composite → 0–100 → tier. Weights are configurable; all sub-scores are
saturating/logistic maps into [0,1] so the blend is interpretable and bounded.
Wallet ROI is shrunk toward neutral when the resolved-position sample is small.

## Wallet performance (Module 5)

`wallet-stats.ts` nets buys/sells per (market, outcome) into a cost-basis
position, marks open shares to the latest snapshot (or 0/1 for resolved
markets), then derives ROI / win-rate / EV / Sharpe via `@whale/core/quant`.
Pre-resolution numbers are mark-to-market estimates that converge to realized
PnL as the tournament settles.

## AI layer

`anomaly.ts` ships a real **Isolation Forest** and **DBSCAN** in pure TS, used by
`scans.ts` for wallet-behavior and volume anomalies (the latter via robust
median/MAD z-scores). **XGBoost is intentionally not reimplemented in TS** — for
supervised "sharp wallet" scoring, export features to a Python sidecar
(scikit-learn/xgboost) and serve via ONNX Runtime; `xgbPredict()` is the
integration seam.

## Scaling notes

- Time-series tables (`trades`, `order_books`, `market_snapshots`) are the hot
  path. For 100k+ trades/day they're fine on vanilla Postgres 18 with the
  provided composite indexes; beyond that, convert them to **TimescaleDB
  hypertables** and add retention/continuous-aggregate policies.
- All workers are horizontally scalable — run N engine replicas; BullMQ
  distributes jobs. Collectors should stay single-instance per platform (or
  shard markets) to avoid duplicate polling.
- Wallet leaderboard ranks are recomputed on a timer; move to a materialized
  view refreshed concurrently at very large wallet counts.
