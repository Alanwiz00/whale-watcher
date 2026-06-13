import { config, logger } from '@whale/core';
import { prisma } from '@whale/db';
import { startMetricsServer } from './metrics.js';
import { closeQueues, registerScans } from './queues.js';
import { startWorkers } from './workers.js';

const log = logger.child({ svc: 'engine' });

async function main(): Promise<void> {
  log.info({ env: config.NODE_ENV }, 'starting detection engine');
  await prisma.$connect();
  startMetricsServer(config.METRICS_PORT + 1);

  const workers = startWorkers();
  await registerScans();
  log.info('engine ready — consuming markets/trades/orderbooks');

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down engine');
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err: String(err) }, 'engine crashed on boot');
  process.exit(1);
});
