import { pino } from 'pino';
import { config } from './config.js';

/**
 * Single structured logger. In dev we pretty-print; in prod we emit JSON for
 * log shippers. Create child loggers per service: `logger.child({ svc: 'api' })`.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'TELEGRAM_BOT_TOKEN',
      'KALSHI_PRIVATE_KEY_PATH',
      '*.password',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
  transport: config.isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
});

export type Logger = typeof logger;
