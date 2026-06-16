import dns from 'node:dns';
import net from 'node:net';
import { z } from 'zod';

// Force IPv4 for all outbound connections. On WSL2 / some Docker networks the
// IPv6 route to external hosts (api.telegram.org, *.polymarket.com via
// Cloudflare) is dead, surfacing as ETIMEDOUT / "fetch failed". `ipv4first`
// alone only reorders DNS — Node's Happy-Eyeballs still races onto the dead IPv6
// — so we also disable auto-select-family so it sticks to the first (IPv4)
// address. Runs once, before any service makes a request.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

/**
 * Centralized, validated configuration. Every service imports `config` and
 * fails fast at boot if required env is missing/malformed. Never read
 * `process.env` directly outside this module.
 */

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: num(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_URL: z.string().optional(),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: num(4000),
  API_CORS_ORIGIN: z.string().default('*'),
  // Comma-separated bearer tokens. When set, EVERY endpoint except infra
  // (/health, /ready, /metrics) requires `Authorization: Bearer <token>`
  // (or `?key=<token>` for the /ws handshake). Empty = auth disabled (dev).
  API_KEYS: csv,

  WHALE_THRESHOLD_USD: num(300_000),
  // Ignore near-certainty BUYS (price ≥ this): paying ~99¢ to win $1 is risk-free
  // parking/yield, not conviction — not a meaningful whale. 1 = disable the skip.
  WHALE_MAX_PRICE: num(0.98),
  SPLIT_WINDOW_MS: num(15 * 60_000),
  SPLIT_THRESHOLD_USD: num(300_000),
  STEAM_MOVE_PCT: num(0.1),
  STEAM_WINDOW_MS: num(5 * 60_000),
  /** Min order-book liquidity (USD) for a market to qualify for steam detection. */
  STEAM_MIN_LIQUIDITY_USD: num(5_000),
  /** Min absolute probability shift (points) for steam — kills long-shot noise. */
  STEAM_MIN_ABS_MOVE: num(0.02),
  // Only ALERT on steam in markets with ≥ this cumulative volume (USD). Steam is
  // still detected/recorded below this — it just won't ping. Filters thin
  // longshot props whose % swings aren't tradeable. The steam equivalent of
  // TELEGRAM_MIN_ALERT_USD; each alert shows market size so you can tune it.
  STEAM_MIN_VOLUME_USD: num(50_000),
  ARB_MIN_EDGE: num(0.02),
  // Smart-money wallet signal: only consider wallets staking ≥ this much. Keeps
  // the "unusual wallet" alert to serious money instead of tiny-stake oddballs.
  WALLET_ALERT_MIN_STAKE_USD: num(25_000),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  // Accepts one or more comma-separated chat ids for the default alert broadcast.
  TELEGRAM_ALERT_CHAT_ID: csv,
  TELEGRAM_ADMIN_CHAT_IDS: csv,
  // Bot-only size gate (USD): Telegram pings only for whale/split alerts ≥ this,
  // independent of the lower WHALE_THRESHOLD_USD the engine detects at. 0 = off.
  TELEGRAM_MIN_ALERT_USD: num(0),

  POLYGON_RPC_URL: z.string().default('https://polygon-rpc.com'),
  // Polymarket Gamma tag id(s) for the World Cup. Discovery reads the EVENTS
  // under these tags (winner, groups, golden boot, props AND every individual
  // game). 102232 = "fifa-world-cup" (the PARENT tag — the only place per-game
  // markets like "Belgium vs. Egypt" live); 102350 = "2026-fifa-world-cup"
  // (futures/props subset, kept as a defensive secondary).
  POLYMARKET_WC_TAG_IDS: z
    .string()
    .default('102232,102350')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  KALSHI_API_BASE: z.string().default('https://api.elections.kalshi.com/trade-api/v2'),
  KALSHI_API_KEY_ID: z.string().optional().default(''),
  KALSHI_PRIVATE_KEY_PATH: z.string().optional().default(''),
  MANIFOLD_API_BASE: z.string().default('https://api.manifold.markets/v0'),
  MANIFOLD_API_KEY: z.string().optional().default(''),
  // Approximate USD value of 1 Manifold mana, so Manifold sizes/volumes are
  // comparable to real-money venues. Historical purchase rate ≈ 100 mana / $1
  // → 0.01. Set 0 to keep mana counted 1:1 (legacy) — but 0.01 is recommended.
  MANIFOLD_USD_PER_MANA: num(0.01),
  // API-Football (API-Sports) — fixtures + per-bookmaker match odds.
  // Direct: base v3.football.api-sports.io + x-apisports-key.
  // RapidAPI: base api-football-v1.p.rapidapi.com/v3 + x-rapidapi-key.
  API_FOOTBALL_KEY: z.string().optional().default(''),
  API_FOOTBALL_BASE: z.string().default('https://v3.football.api-sports.io'),
  API_FOOTBALL_LEAGUE_ID: num(1), // FIFA World Cup = league 1 in API-Football
  API_FOOTBALL_SEASON: num(2026),
  // Throttle API-Football independently of the 5-min discovery cycle. Free tier
  // is ~100 req/day; at ~4 calls/run, 1h ≈ 96/day, 2h ≈ 48/day. Default 1h.
  API_FOOTBALL_INTERVAL_MS: num(60 * 60_000),
  API_FOOTBALL_MAX_PAGES: num(3),
  BETFAIR_APP_KEY: z.string().optional().default(''),
  BETFAIR_SESSION_TOKEN: z.string().optional().default(''),

  // Comma-separated platforms to skip in the collector registry (e.g. "kalshi").
  DISABLED_PLATFORMS: csv,

  // Poll cadence. Wide enough that one pass over the (thousands of) live-WC
  // markets finishes within the interval; tighten only with a small market set.
  DISCOVERY_INTERVAL_MS: num(5 * 60_000),
  TRADES_INTERVAL_MS: num(120_000),
  ORDERBOOK_INTERVAL_MS: num(120_000),
  // Minimum combined volume + book liquidity (USD) for a market to be TRACKED
  // (discovery) and polled for trades/order books. A live World Cup exposes ~10k
  // Polymarket markets; this keeps the engine on the ones with real money so
  // polling/DB don't get swamped. Real match + futures markets clear it easily.
  MIN_POLL_LIQUIDITY_USD: num(1_000),
  // Drop dust trades at ingestion: don't enqueue/persist trades below this USD
  // size. A live match has thousands of sub-$100 trades that can't be whales or
  // meaningful split legs — one job each floods the queue (BullMQ stalled-lock
  // errors). The market cursor still advances past them, so they're skipped once.
  MIN_TRADE_USD: num(100),
  /** Max concurrent venue HTTP requests (keeps us polite + avoids resets). */
  COLLECTOR_CONCURRENCY: num(12),

  METRICS_PORT: num(9100),
});

export type AppConfig = z.infer<typeof schema> & {
  isProd: boolean;
  isTest: boolean;
  redisConnection: { host: string; port: number; password?: string };
};

function load(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n✖ Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  const env = parsed.data;
  return {
    ...env,
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    redisConnection: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD || undefined,
    },
  };
}

export const config = load();
