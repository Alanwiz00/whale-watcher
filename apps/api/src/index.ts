import { config, logger } from '@whale/core';
import { prisma } from '@whale/db';
import { buildServer } from './server.js';

const log = logger.child({ svc: 'api' });

async function main(): Promise<void> {
  await prisma.$connect();
  const app = await buildServer();
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  log.info({ host: config.API_HOST, port: config.API_PORT }, 'API listening');

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down api');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err: String(err) }, 'api crashed on boot');
  process.exit(1);
});
