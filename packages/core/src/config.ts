import { z } from 'zod';

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
  API_KEYS: csv,
  INTERNAL_JWT_SECRET: z.string().default('dev-internal-secret'),

  WHALE_THRESHOLD_USD: num(300_000),
  SPLIT_WINDOW_MS: num(15 * 60_000),
  SPLIT_THRESHOLD_USD: num(300_000),
  STEAM_MOVE_PCT: num(0.05),
  STEAM_WINDOW_MS: num(5 * 60_000),
  ARB_MIN_EDGE: num(0.02),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_ALERT_CHAT_ID: z.string().optional().default(''),
  TELEGRAM_ADMIN_CHAT_IDS: csv,

  POLYGON_RPC_URL: z.string().default('https://polygon-rpc.com'),
  KALSHI_API_BASE: z.string().default('https://api.elections.kalshi.com/trade-api/v2'),
  KALSHI_API_KEY_ID: z.string().optional().default(''),
  KALSHI_PRIVATE_KEY_PATH: z.string().optional().default(''),
  MANIFOLD_API_BASE: z.string().default('https://api.manifold.markets/v0'),
  MANIFOLD_API_KEY: z.string().optional().default(''),
  ODDS_API_KEY: z.string().optional().default(''),
  ODDS_API_BASE: z.string().default('https://api.the-odds-api.com/v4'),
  BETFAIR_APP_KEY: z.string().optional().default(''),
  BETFAIR_SESSION_TOKEN: z.string().optional().default(''),

  DISCOVERY_INTERVAL_MS: num(5 * 60_000),
  TRADES_INTERVAL_MS: num(15_000),
  ORDERBOOK_INTERVAL_MS: num(5_000),

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
