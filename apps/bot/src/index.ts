import { config, logger } from '@whale/core';
import { prisma } from '@whale/db';
import { startAlertsSubscriber } from './alerts-subscriber.js';
import { createBot } from './bot.js';

const log = logger.child({ svc: 'bot' });

async function main(): Promise<void> {
  if (!config.TELEGRAM_BOT_TOKEN) {
    log.warn('TELEGRAM_BOT_TOKEN not set — bot will not start. Set it in .env to enable.');
    // Keep the process alive so docker/healthchecks don't crash-loop in dev.
    setInterval(() => undefined, 1 << 30);
    return;
  }

  await prisma.$connect();
  const bot = createBot();
  await startAlertsSubscriber(bot);

  // NB: telegraf's launch() promise only resolves when the bot STOPS, so we
  // intentionally don't await it here — it runs for the process lifetime.
  void bot.launch();
  log.info('telegram bot launched (long polling)');

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down bot');
    bot.stop(sig);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal({ err: String(err) }, 'bot crashed on boot');
  process.exit(1);
});
