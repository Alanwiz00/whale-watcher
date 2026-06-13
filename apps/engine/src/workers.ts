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
      if (m) await upsertMarket(m);
      end();
    },
    { connection, concurrency: 8 },
  );

  const tradesWorker = new Worker<TradeJob>(
    QUEUES.trades,
    async (job) => {
      const end = jobLatency.startTimer({ queue: 'trades' });
      const trade = normalizeTrade(job.data.trade);
      if (!trade) return end();
      const persisted = await persistTrade(trade);
      tradesProcessed.inc({ platform: trade.platform });
      if (persisted.isNew) {
        // Detection runs only on genuinely new trades.
        await detectWhale(trade, persisted);
        await detectSplitAccumulation(trade, persisted);
        if (persisted.walletId) await enqueueWalletStats(persisted.walletId, trade.platform);
      }
      end();
    },
    { connection, concurrency: 12 },
  );

  const orderBooksWorker = new Worker<OrderBookJob>(
    QUEUES.orderbooks,
    async (job) => {
      const end = jobLatency.startTimer({ queue: 'orderbooks' });
      const book = normalizeOrderBook(job.data.book);
      if (!book) return end();
      const marketId = await persistOrderBook(book);
      const mid =
        book.bestBid != null && book.bestAsk != null
          ? (book.bestBid + book.bestAsk) / 2
          : (book.bestAsk ?? book.bestBid);
      if (mid != null) {
        await detectSteam(marketId, book.platform, book.outcomeName ?? null, mid, book.timestamp);
      }
      end();
    },
    { connection, concurrency: 8 },
  );

  const walletStatsWorker = new Worker<WalletStatsJob>(
    QUEUES.walletStats,
    async (job) => {
      const end = jobLatency.startTimer({ queue: 'wallet-stats' });
      await computeWalletStats(job.data.wallet);
      end();
    },
    { connection, concurrency: 4 },
  );

  const scanWorker = new Worker(
    'q:engine:scan',
    async (job) => {
      switch (job.name) {
        case 'arbitrage':
          return void (await scanArbitrage());
        case 'anomaly':
          await detectVolumeAnomalies();
          await detectWalletAnomalies();
          return;
        case 'ranks':
          return recomputeRanks();
      }
    },
    { connection, concurrency: 1 },
  );

  for (const w of [marketsWorker, tradesWorker, orderBooksWorker, walletStatsWorker, scanWorker]) {
    w.on('failed', (job, err) =>
      log.error({ queue: w.name, job: job?.id, err: String(err) }, 'job failed'),
    );
  }

  return [marketsWorker, tradesWorker, orderBooksWorker, walletStatsWorker, scanWorker];
}
