import { config, logger } from '@whale/core';
import { collectQueue } from './queues.js';

const log = logger.child({ svc: 'collectors', mod: 'scheduler' });

/**
 * Register repeatable jobs on the schedule queue. BullMQ dedupes by jobId so
 * restarts don't pile up duplicate schedules. Intervals come from config.
 */
export async function registerSchedules(): Promise<void> {
  // Clear stale repeatables first so interval changes take effect on deploy.
  const existing = await collectQueue.getRepeatableJobs();
  await Promise.all(existing.map((j) => collectQueue.removeRepeatableByKey(j.key)));

  await collectQueue.add(
    'discovery',
    {},
    { repeat: { every: config.DISCOVERY_INTERVAL_MS }, jobId: 'discovery' },
  );
  await collectQueue.add(
    'trades',
    {},
    { repeat: { every: config.TRADES_INTERVAL_MS }, jobId: 'trades' },
  );
  await collectQueue.add(
    'orderbooks',
    {},
    { repeat: { every: config.ORDERBOOK_INTERVAL_MS }, jobId: 'orderbooks' },
  );

  log.info(
    {
      discoveryMs: config.DISCOVERY_INTERVAL_MS,
      tradesMs: config.TRADES_INTERVAL_MS,
      orderbookMs: config.ORDERBOOK_INTERVAL_MS,
    },
    'collection schedules registered',
  );
}
