# Deploying WhaleWatcher on Dokploy (separate apps)

The single Docker Compose stack builds **all images on the host at once** — the
Next.js build alone is RAM-heavy, so concurrent builds OOM and crash a small VPS.
This guide splits the stack into independent Dokploy resources that build and
deploy **one at a time**.

> **Strategy: build on the Dokploy host.** Each app builds from its Dockerfile.
> If the host can't handle the web build even alone, add swap (below) or switch
> to the registry path in [the last section](#when-the-host-still-cant-build).

## Topology

| Resource | Type | Dockerfile | Build arg | Public domain | Port |
|---|---|---|---|---|---|
| Postgres 18 | Dokploy **Database** | — | — | no | 5432 (internal) |
| Redis | Dokploy **Database** | — | — | no | 6379 (internal) |
| `api` | **Application** | `docker/node.Dockerfile` | `APP=api` | ✅ `api.your-domain.com` | 4000 |
| `web` | **Application** | `docker/web.Dockerfile` | see below | ✅ `app.your-domain.com` | 3000 |
| `engine` | **Application** | `docker/node.Dockerfile` | `APP=engine` | ❌ | — |
| `collectors` | **Application** | `docker/node.Dockerfile` | `APP=collectors` | ❌ | — |
| `bot` | **Application** | `docker/node.Dockerfile` | `APP=bot` | ❌ | — |

`engine`, `collectors`, and `bot` are workers — **do not assign a domain or port**.
Prometheus/Grafana are intentionally omitted; use Dokploy's built-in monitoring.

## 0. Prep the VPS (strongly recommended)

The web build needs headroom. Add swap so a build spike can't OOM the host:

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # confirm swap is active
```

## 1. Create the databases

1. **Project → Create → Database → PostgreSQL.** Version 18, set a strong
   password, DB name `whalewatcher`. After it's running, open it and copy the
   **internal connection string** (host is the resource's service name, e.g.
   `whalewatcher-postgres`).
2. **Create → Database → Redis.** Note its internal host (e.g.
   `whalewatcher-redis`).

Both stay on the private Docker network — no domains, no published ports.

## 2. Create the `api` Application

1. **Create → Application**, source = this Git repo, branch `main`.
2. **Build Type → Dockerfile.**
   - Docker file path: `docker/node.Dockerfile`
   - Build context: `.` (repo root)
   - **Build arg:** `APP=api`
3. **Environment:** paste the COMMON + api blocks from
   [`.env.prod.example`](../.env.prod.example). Set `DATABASE_URL` / `REDIS_URL`
   to the Dokploy internal strings from step 1. Generate `API_KEYS` with
   `openssl rand -hex 32`. Set `API_CORS_ORIGIN=https://app.your-domain.com`.
4. **Run command** (runs migrations, then starts the API):
   ```sh
   sh -c "pnpm --filter @whale/db migrate:deploy && node apps/api/dist/index.js"
   ```
   `prisma` ships in the runtime image, so migrations run from this container —
   no separate migrate app needed.
5. **Domain:** `api.your-domain.com` → container port **4000**, enable HTTPS.
6. **Health check path:** `/health` (open, no key required).
7. Deploy. Watch logs for `migrate deploy` then `API listening`.

## 3. Create the worker apps: `engine`, `collectors`, `bot`

For each: **Create → Application** → same repo → **Dockerfile**
`docker/node.Dockerfile`, build context `.`, build arg `APP=engine` /
`collectors` / `bot`.

- **Environment:** COMMON block + the app's extra block from `.env.prod.example`
  (bot needs the `TELEGRAM_*` vars; engine/collectors take `METRICS_PORT=9100`).
- **No domain, no port** — these don't accept ingress.
- Leave the default start command (the image's `CMD` runs the right service).
- Deploy them **one at a time** (wait for each to go green before the next).

## 4. Create the `web` Application

1. **Create → Application** → same repo → **Dockerfile** `docker/web.Dockerfile`,
   context `.`.
2. **Build args** (these are baked into the browser bundle — they must be set at
   **build** time, not the Environment tab):
   ```
   NEXT_PUBLIC_API_URL=https://api.your-domain.com
   NEXT_PUBLIC_WS_URL=wss://api.your-domain.com/ws
   NEXT_PUBLIC_API_KEY=<one of the API_KEYS from the api app>
   ```
3. **Domain:** `app.your-domain.com` → container port **3000**, enable HTTPS.
4. Deploy.

> The dashboard's `NEXT_PUBLIC_API_KEY` is visible in the browser bundle (not a
> true secret). It stops random API access; if the dashboard itself must be
> private, put it behind proxy auth/VPN. See [SECURITY.md](./SECURITY.md).

## 5. Deploy order & verification

1. Postgres + Redis (must be running first).
2. `api` (creates the schema via migrate on first boot).
3. `engine`, `collectors`, `bot` (one at a time).
4. `web`.

Check: `https://api.your-domain.com/health` returns `{"status":"ok"}`; the
dashboard loads; Telegram receives alerts; `collectors` logs "discovered … WC
markets". Unauthenticated calls to `/api/*` now return `401` (key gate is on).

## Re-running migrations later

Migrations run automatically on every `api` deploy (idempotent). To run manually,
open the `api` container's terminal in Dokploy:
```sh
pnpm --filter @whale/db migrate:deploy
```

## Troubleshooting OOM / crashes

- **Deploy one app at a time.** Don't trigger all builds together.
- **Add swap** (step 0) — the single biggest win for the web build.
- **Lower `COLLECTOR_CONCURRENCY`** (e.g. 2–3) and reduce poll frequency if the
  collectors app is starved.
- Each node app opens its own DB pool — keep `connection_limit` modest per app
  (15 in the template) so the shared Postgres isn't exhausted.

## When the host still can't build

If even single builds OOM, stop building on the host: build images in CI and have
Dokploy **pull** them. A ready-to-use, manually-triggered workflow is included at
[`.github/workflows/images.yml`](../.github/workflows/images.yml) — run it
(Actions → "Build & push images" → Run workflow). Then for each Application switch
**Source → Docker Image**, e.g. `ghcr.io/alanwiz00/whale-watcher-api:latest`, add
your GHCR credentials, and redeploy. Deploys become a `docker pull` with zero
build load on the host.
