# Deploying WhaleWatcher on Dokploy (separate apps)

The single Docker Compose stack builds **all images on the host at once** — the
Next.js build alone is RAM-heavy, so concurrent builds OOM and crash a small VPS.
This guide splits the stack into independent Dokploy resources that build and
deploy **one at a time**.

> **Strategy: build on the Dokploy host.** Each app builds from its Dockerfile.
> If the host can't handle the web build even alone, add swap (below) or switch
> to the registry path in [the last section](#when-the-host-still-cant-build).

## Topology

| Resource | Type | Dockerfile | Runtime env | Public domain | Port |
|---|---|---|---|---|---|
| Postgres 18 | Dokploy **Database** | — | — | no | 5432 (internal) |
| Redis | Dokploy **Database** | — | — | no | 6379 (internal) |
| `api` | **Application** | `docker/node.Dockerfile` | `APP=api` | ✅ `api.your-domain.com` | 4000 |
| `web` | **Application** | `docker/web.Dockerfile` | (build args, below) | ✅ `app.your-domain.com` | 3000 |
| `engine` | **Application** | `docker/node.Dockerfile` | `APP=engine` | ❌ | — |
| `collectors` | **Application** | `docker/node.Dockerfile` | `APP=collectors` | ❌ | — |
| `bot` | **Application** | `docker/node.Dockerfile` | `APP=bot` | ❌ | — |

All four node apps build the **same** `docker/node.Dockerfile` with **no build
args** — the `APP` **environment variable** (Environment tab) selects which
service each container runs. `engine`, `collectors`, and `bot` are workers — **do
not assign a domain or port**. Prometheus/Grafana are intentionally omitted; use
Dokploy's built-in monitoring.

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
   - **No build args.**
3. **Environment:** paste the COMMON + api blocks from
   [`.env.prod.example`](../.env.prod.example). Set `DATABASE_URL` / `REDIS_URL`
   to the Dokploy internal strings from step 1. Generate `API_KEYS` with
   `openssl rand -hex 32`. Set `API_CORS_ORIGIN=https://app.your-domain.com`.
   - **`APP=api`** — required; selects which service this container runs.
   - **`RUN_MIGRATIONS=true`** — the entrypoint then applies pending Prisma
     migrations on startup before booting (no custom run command needed). `prisma`
     ships in the image, and a migration failure aborts startup so you never boot
     against a bad schema. Set this **only on api** so migrations run from one
     service.
4. **Domain:** `api.your-domain.com` → container port **4000**, enable HTTPS.
5. **Health check path:** `/health` (open, no key required).
6. Deploy. Watch logs for `→ prisma migrate deploy` then `API listening`.

## 3. Create the worker apps: `engine`, `collectors`, `bot`

For each: **Create → Application** → same repo → **Dockerfile**
`docker/node.Dockerfile`, build context `.`, **no build args**.

- **Environment:** COMMON block + the app's extra block from `.env.prod.example`.
  Set **`APP=engine`**, **`APP=collectors`**, or **`APP=bot`** respectively
  (required). bot needs the `TELEGRAM_*` vars; engine/collectors take
  `METRICS_PORT=9100`. **Do not set `RUN_MIGRATIONS`** — only api migrates.
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

With `RUN_MIGRATIONS=true` on the api app, migrations run automatically on every
api start/redeploy (idempotent — only pending migrations are applied). To run
them manually, open the `api` container's terminal in Dokploy:
```sh
pnpm --filter @whale/db migrate:deploy
```

## Troubleshooting builds

- **`"/apps": not found` (or `/packages`, `/.npmrc`) during COPY** — the build
  **context** is wrong. Set each app's **Docker Context Path / Build Path** to
  **`.`** (repo root) and the **Dockerfile path** to `docker/node.Dockerfile`
  (web: `docker/web.Dockerfile`). The Dockerfiles COPY from the monorepo root, so
  the context must be the root, not the `docker/` folder.
- **`target stage "production" could not be found`** — older builds; the runtime
  stage is now named `production` in both Dockerfiles, so `--target production`
  resolves. If a Dokploy **Build Stage** field is set, use `production` or leave
  it blank. Make sure the fix is committed & pushed (Dokploy builds from Git).
- **`No projects matched the filters` during build, then the container exits / is
  "not found"** — this was the old build-arg approach (`APP` unset at build).
  Fixed: the node image now builds all services and picks one via the `APP`
  **environment variable**. Ensure each node app sets `APP` (api/engine/
  collectors/bot) in its Environment; without it the container exits with
  `set APP to api|engine|collectors|bot`.

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
(Actions → "Build & push images" → Run workflow). It pushes two images:
`whale-watcher-node` (api/engine/collectors/bot — one image, `APP` picks the
service) and `whale-watcher-web`. Then for each Application switch **Source →
Docker Image**:

- api / engine / collectors / bot → `ghcr.io/alanwiz00/whale-watcher-node:latest`
  (set the same `APP` env per app as above)
- web → `ghcr.io/alanwiz00/whale-watcher-web:latest`

Add your GHCR credentials and redeploy. Deploys become a `docker pull` with zero
build load on the host.
