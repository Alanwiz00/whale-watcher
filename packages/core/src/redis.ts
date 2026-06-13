import { Redis } from 'ioredis';
import { config } from './config.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null`. We reuse one connection factory
 * for cache + pub/sub + queues; callers that need a dedicated subscriber should
 * call `createRedis()` rather than sharing the default client.
 */
export function createRedis(opts?: { lazy?: boolean }): Redis {
  return new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: opts?.lazy ?? false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

let _shared: Redis | undefined;
/** Shared client for cache/pubsub. Do not use for BullMQ workers. */
export function redis(): Redis {
  if (!_shared) _shared = createRedis();
  return _shared;
}

/** Redis pub/sub channels for realtime fan-out (API WebSocket subscribes). */
export const CHANNELS = {
  whales: 'ww:whales',
  alerts: 'ww:alerts',
  arbitrage: 'ww:arbitrage',
  steam: 'ww:steam',
  trades: 'ww:trades',
} as const;
