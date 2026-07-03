import { Worker } from 'bullmq';
import {
  config,
  logger,
  QUEUES,
  type MarketJob,
  type OrderBookJob,
  type TradeJob,
  type WalletStatsJob,
} from '@whale/core';
import { scanArbitrage } from './arbitrage.js';
import { withDbRetry } from './db-retry.js';
import { scanElonMarkets } from './detection/market-open.js';
import { detectSplitAccumulation } from './detection/split.js';
import { detectSteam } from './detection/steam.js';
import { detectWhale } from './detection/whale.js';
import { jobLatency, tradesProcessed } from './metrics.js';
import { normalizeMarket, normalizeOrderBook, normalizeTrade } from './normalizer.js';
import { persistOrderBook, persistTrade, upsertMarket } from './persist.js';
import { enqueueWalletStats } from './queues.js';
import { detectVolumeAnomalies, detectWalletAnomalies } from './scans.js';
import { computeWalletStats, recomputeRanks } from './wallet-stats.js';

const log = logger.child({ svc: 'engine', mod: 'workers' });
const connection = config.redisConnection;

export function startWorkers(): Worker[] {
  const marketsWorker = new Worker<MarketJob>(
    QUEUES.markets,
    async (job) => {
      const end = jobLatency.startTimer({ queue: 'markets' });
      const m = normalizeMarket(job.data.market);
      if (m) await withDbRetry(() => upsertMarket(m));
      end();
    },
    { connection, concurrency: 4 },
  );

  const tradesWorker = new Worker<TradeJob>(
    QUEUES.trades,
    async (job) => {
      const end = jobLatency.startTimer({ queue: 'trades' });
      const trade = normalizeTrade(job.data.trade);
      if (!trade) return end();
      // Wrap the persist+detect block so a transient DB-connection drop retries
      // (reconnects) instead of failing the job. The block is idempotent.
      await withDbRetry(async () => {
        const persisted = await persistTrade(trade);
        tradesProcessed.inc({ platform: trade.platform });
        if (persisted.isNew) {
          // Detection runs only on genuinely new trades.
          await detectWhale(trade, persisted);
          await detectSplitAccumulation(trade, persisted);
          if (persisted.walletId) await enqueueWalletStats(persisted.walletId, trade.platform);
        }
      });
      end();
    },
    // Concurrency is sized so the engine's total in-flight DB work stays well
    // under the Prisma connection pool (see DATABASE_URL connection_limit).
    // lockDuration is raised above the 30s default so a job slowed by match-day
    // DB contention isn't marked stalled mid-flight ("could not renew lock");
    // MIN_TRADE_USD keeps volume down, this is the safety margin.
    { connection, concurrency: 8, lockDuration: 60_000 },
  );

  const orderBooksWorker = new Worker<OrderBookJob>(
    QUEUES.orderbooks,
    async (job) => {
      const end = jobLatency.startTimer({ queue: 'orderbooks' });
      const book = normalizeOrderBook(job.data.book);
      if (!book) return end();
      await withDbRetry(async () => {
        const marketId = await persistOrderBook(book);
        const mid =
          book.bestBid != null && book.bestAsk != null
            ? (book.bestBid + book.bestAsk) / 2
            : (book.bestAsk ?? book.bestBid);
        if (mid != null) {
          await detectSteam(
            marketId,
            book.platform,
            book.outcomeName ?? null,
            mid,
            book.timestamp,
            book.liquidityUsd,
          );
        }
      });
      end();
    },
    { connection, concurrency: 4, lockDuration: 60_000 },
  );

  const walletStatsWorker = new Worker<WalletStatsJob>(
    QUEUES.walletStats,
    async (job) => {
      const end = jobLatency.startTimer({ queue: 'wallet-stats' });
      await withDbRetry(() => computeWalletStats(job.data.wallet));
      end();
    },
    // computeWalletStats can run a snapshot lookup per market a wallet has traded,
    // so a busy whale's job takes a while — raised lock so it isn't stalled.
    { connection, concurrency: 2, lockDuration: 60_000 },
  );

  const scanWorker = new Worker(
    'q-engine-scan',
    async (job) => {
      switch (job.name) {
        case 'arbitrage':
          return void (await withDbRetry(() => scanArbitrage()));
        case 'anomaly':
          await withDbRetry(() => detectVolumeAnomalies());
          await withDbRetry(() => detectWalletAnomalies());
          return;
        case 'ranks':
          return withDbRetry(() => recomputeRanks());
        case 'market-open':
          return scanElonMarkets();
      }
    },
    // Global scans (arbitrage / anomaly / leaderboard ranks) sweep every market &
    // wallet — minutes at tournament scale, so a generous lock avoids stalls.
    { connection, concurrency: 1, lockDuration: 5 * 60_000 },
  );

  for (const w of [marketsWorker, tradesWorker, orderBooksWorker, walletStatsWorker, scanWorker]) {
    w.on('failed', (job, err) =>
      log.error({ queue: w.name, job: job?.id, err: String(err) }, 'job failed'),
    );
  }

  return [marketsWorker, tradesWorker, orderBooksWorker, walletStatsWorker, scanWorker];
}
