/**
 * BullMQ queue names + job payload contracts shared between collectors
 * (producers) and the engine (consumers). Keeping these in core guarantees both
 * sides agree on the wire format.
 */
import type { NormalizedMarket, NormalizedOrderBook, NormalizedTrade } from './types.js';

export const QUEUES = {
  /** Raw normalized markets discovered by collectors → upserted by engine. */
  markets: 'q:markets',
  /** Raw normalized trades → persisted + run through detection. */
  trades: 'q:trades',
  /** Order book snapshots → persisted + feed impact/steam detectors. */
  orderbooks: 'q:orderbooks',
  /** Recompute wallet stats for a wallet (debounced). */
  walletStats: 'q:wallet-stats',
  /** Cross-platform arbitrage scan trigger. */
  arbitrage: 'q:arbitrage',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface MarketJob {
  market: NormalizedMarket;
}
export interface TradeJob {
  trade: NormalizedTrade;
}
export interface OrderBookJob {
  book: NormalizedOrderBook;
}
export interface WalletStatsJob {
  wallet: string;
  platform: string;
}
export interface ArbitrageJob {
  canonicalKey?: string;
}

export const DEFAULT_JOB_OPTS = {
  removeOnComplete: { age: 3600, count: 5_000 },
  removeOnFail: { age: 24 * 3600 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
};
