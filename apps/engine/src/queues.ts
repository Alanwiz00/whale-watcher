import { Queue } from 'bullmq';
import { config, DEFAULT_JOB_OPTS, QUEUES, type WalletStatsJob } from '@whale/core';

const connection = config.redisConnection;

/** Debounced wallet-stats recompute. jobId = walletId coalesces bursts. */
export const walletStatsQueue = new Queue<WalletStatsJob>(QUEUES.walletStats, {
  connection,
  defaultJobOptions: { ...DEFAULT_JOB_OPTS, attempts: 2 },
});

/** Internal repeatable scans (arbitrage / anomaly / ranks). */
export const scanQueue = new Queue('q:engine:scan', { connection });

export function enqueueWalletStats(walletId: string, platform: string): Promise<unknown> {
  return walletStatsQueue.add(
    'recompute',
    { wallet: walletId, platform },
    { jobId: `ws:${walletId}`, delay: 3_000, removeOnComplete: true, removeOnFail: 100 },
  );
}

export async function registerScans(): Promise<void> {
  const existing = await scanQueue.getRepeatableJobs();
  await Promise.all(existing.map((j) => scanQueue.removeRepeatableByKey(j.key)));
  await scanQueue.add('arbitrage', {}, { repeat: { every: 60_000 }, jobId: 'arbitrage' });
  await scanQueue.add('anomaly', {}, { repeat: { every: 300_000 }, jobId: 'anomaly' });
  await scanQueue.add('ranks', {}, { repeat: { every: 300_000 }, jobId: 'ranks' });
}

export async function closeQueues(): Promise<void> {
  await Promise.all([walletStatsQueue.close(), scanQueue.close()]);
}
