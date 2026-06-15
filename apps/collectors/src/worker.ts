import { Worker } from 'bullmq';
import pLimit from 'p-limit';
import { config, DEFAULT_JOB_OPTS, logger } from '@whale/core';
import { collectors, registry } from './registry.js';
import { marketsQueue, orderBooksQueue, tradesQueue, collectQueue } from './queues.js';
import {
  collectDuration,
  collectErrors,
  marketsDiscovered,
  tradesIngested,
} from './metrics.js';

const log = logger.child({ svc: 'collectors', mod: 'worker' });
const SCHEDULE_QUEUE = collectQueue.name;

type Stage = 'discovery' | 'trades' | 'orderbooks';

/** Global fetch concurrency to stay polite to venue rate limits / avoid resets. */
const limit = pLimit(config.COLLECTOR_CONCURRENCY);

/** Skip polling markets with negligible liquidity+volume (they have no whales). */
function isActive(m: { liquidityUsd?: number | null; volumeUsd?: number | null }): boolean {
  const known = m.liquidityUsd != null || m.volumeUsd != null;
  if (!known) return true; // unknown → poll it
  return (m.liquidityUsd ?? 0) + (m.volumeUsd ?? 0) >= config.MIN_POLL_LIQUIDITY_USD;
}

/** Small random delay to de-synchronize bursts of requests to one host. */
const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 250));

async function runDiscovery(): Promise<void> {
  const end = timer('discovery');
  const perPlatform: Record<string, number> = {};
  await Promise.all(
    collectors.map((c) =>
      limit(async () => {
        try {
          const { markets, tracked } = await c.discoverMarkets();
          for (const t of tracked) registry.upsert(t);
          for (const m of markets) {
            perPlatform[m.platform] = (perPlatform[m.platform] ?? 0) + 1;
            await marketsQueue.add('market', { market: m }, DEFAULT_JOB_OPTS);
          }
        } catch (err) {
          collectErrors.inc({ platform: c.platform, stage: 'discovery' });
          log.error({ err: String(err), platform: c.platform }, 'discovery failed');
        }
      }),
    ),
  );
  for (const [platform, n] of Object.entries(perPlatform)) marketsDiscovered.set({ platform }, n);
  end();
}

async function runTrades(): Promise<void> {
  const end = timer('trades');
  const markets = registry.all().filter(isActive);
  await Promise.all(
    markets.map((m) =>
      limit(async () => {
        const c = collectors.find((x) => x.platform === m.platform);
        if (!c?.capabilities.trades || !c.fetchTrades) return;
        try {
          await jitter();
          const trades = await c.fetchTrades(m);
          let maxTs = m.lastTradeAt?.getTime() ?? 0;
          for (const trade of trades) {
            // Dedupe by a stable, colon-free job id so the same trade can't be
            // enqueued (and processed) twice. BullMQ ignores adds with an id that
            // already exists (incl. recently-completed), which removes the
            // concurrent-insert race in the engine. (jobIds can't contain ':'.)
            const jobId = `t-${trade.platform}-${trade.externalId}`.replace(/:/g, '-');
            await tradesQueue.add('trade', { trade }, { ...DEFAULT_JOB_OPTS, jobId });
            maxTs = Math.max(maxTs, trade.timestamp.getTime());
          }
          if (trades.length) {
            tradesIngested.inc({ platform: m.platform }, trades.length);
            registry.setCursor(m.platform, m.externalId, new Date(maxTs));
          }
        } catch (err) {
          collectErrors.inc({ platform: m.platform, stage: 'trades' });
          log.warn({ err: String(err), market: m.externalId }, 'trade fetch failed');
        }
      }),
    ),
  );
  end();
}

async function runOrderBooks(): Promise<void> {
  const end = timer('orderbooks');
  const markets = registry.all().filter(isActive);
  await Promise.all(
    markets.map((m) =>
      limit(async () => {
        const c = collectors.find((x) => x.platform === m.platform);
        if (!c?.capabilities.orderbook || !c.fetchOrderBook) return;
        try {
          await jitter();
          const books = await c.fetchOrderBook(m);
          for (const book of books) await orderBooksQueue.add('book', { book }, DEFAULT_JOB_OPTS);
        } catch (err) {
          collectErrors.inc({ platform: m.platform, stage: 'orderbooks' });
          log.warn({ err: String(err), market: m.externalId }, 'orderbook fetch failed');
        }
      }),
    ),
  );
  end();
}

function timer(stage: Stage): () => void {
  const start = Date.now();
  return () => collectDuration.set({ stage }, (Date.now() - start) / 1000);
}

/** Start the worker that executes scheduled collection ticks. */
export function startCollectorWorker(): Worker {
  const worker = new Worker(
    SCHEDULE_QUEUE,
    async (job) => {
      switch (job.name as Stage) {
        case 'discovery':
          return runDiscovery();
        case 'trades':
          return runTrades();
        case 'orderbooks':
          return runOrderBooks();
        default:
          log.warn({ name: job.name }, 'unknown collect job');
      }
    },
    { connection: config.redisConnection, concurrency: 3 },
  );

  worker.on('failed', (job, err) =>
    log.error({ job: job?.name, err: String(err) }, 'collect job failed'),
  );
  return worker;
}

export { runDiscovery };
