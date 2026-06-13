import { Queue } from 'bullmq';
import {
  config,
  DEFAULT_JOB_OPTS,
  QUEUES,
  type MarketJob,
  type OrderBookJob,
  type TradeJob,
} from '@whale/core';

/**
 * Producer-side queues. Collectors push normalized data onto these; the engine
 * service runs the matching Workers. One Redis connection per Queue is fine —
 * BullMQ multiplexes commands.
 */
const connection = config.redisConnection;

export const marketsQueue = new Queue<MarketJob>(QUEUES.markets, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
export const tradesQueue = new Queue<TradeJob>(QUEUES.trades, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
export const orderBooksQueue = new Queue<OrderBookJob>(QUEUES.orderbooks, {
  connection,
  defaultJobOptions: DEFAULT_JOB_OPTS,
});

/** Internal scheduling queue for repeatable collection ticks. */
export const collectQueue = new Queue(QUEUES.markets + ':schedule', { connection });

export async function closeQueues(): Promise<void> {
  await Promise.all([
    marketsQueue.close(),
    tradesQueue.close(),
    orderBooksQueue.close(),
    collectQueue.close(),
  ]);
}
