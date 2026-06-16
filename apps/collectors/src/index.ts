import { config, logger } from '@whale/core';
import { startMetricsServer } from './metrics.js';
import { closeQueues } from './queues.js';
import { registry } from './registry.js';
import { registerSchedules } from './scheduler.js';
import { runDiscovery, runTrades, startCollectorWorker } from './worker.js';

const log = logger.child({ svc: 'collectors' });

async function main(): Promise<void> {
  log.info({ env: config.NODE_ENV }, 'starting collectors service');
  startMetricsServer(config.METRICS_PORT);

  // Restore persisted poll cursors BEFORE discovery so we resume from where we
  // left off instead of re-pulling every market's recent trades.
  await registry.hydrate();

  const worker = startCollectorWorker();
  await registerSchedules();

  // Kick an immediate discovery so the registry is warm before the first tick.
  await runDiscovery().catch((err) => log.error({ err: String(err) }, 'initial discovery failed'));
  // …then a first trades pass right away, so we don't wait a full TRADES_INTERVAL
  // for any data (the repeatable tick only fires after the interval elapses).
  // Backgrounded — boot shouldn't block on a multi-minute poll pass.
  void runTrades().catch((err) => log.error({ err: String(err) }, 'initial trades pass failed'));

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down collectors');
    await worker.close();
    await closeQueues();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err: String(err) }, 'collectors crashed on boot');
  process.exit(1);
});
