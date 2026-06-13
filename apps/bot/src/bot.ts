import { config, logger, redis } from '@whale/core';
import { Telegraf } from 'telegraf';
import {
  arbitrageSummary,
  marketsSummary,
  overview,
  recentWhales,
  teamReport,
  topWallets,
} from './queries.js';

const log = logger.child({ svc: 'bot' });

const SUBS_KEY = 'ww:tg:subs'; // chats subscribed to the live alert feed

export function createBot(): Telegraf {
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

  const reply = (md: string) => md; // markdown passthrough helper

  bot.start((ctx) =>
    ctx.replyWithMarkdown(
      [
        '*🐋 WhaleWatcher* — World Cup 2026 smart-money intel.',
        '',
        'Commands:',
        '/whales – recent large bets',
        '/topwallets – wallet leaderboard',
        '/markets – tracked markets',
        '/arbitrage – cross-platform edges',
        '/worldcup – live overview',
        '/live – toggle realtime alerts here',
        '/brazil /england /france – team reports',
      ].join('\n'),
    ),
  );
  bot.help((ctx) => ctx.reply('Try /whales, /topwallets, /markets, /arbitrage, /worldcup, /live'));

  bot.command('whales', async (ctx) => ctx.replyWithMarkdown(reply(await recentWhales(10))));
  bot.command('topwallets', async (ctx) => ctx.replyWithMarkdown(reply(await topWallets(10))));
  bot.command('markets', async (ctx) => ctx.replyWithMarkdown(reply(await marketsSummary())));
  bot.command('arbitrage', async (ctx) => ctx.replyWithMarkdown(reply(await arbitrageSummary(10))));
  bot.command('worldcup', async (ctx) => ctx.replyWithMarkdown(reply(await overview())));

  for (const team of ['brazil', 'england', 'france', 'argentina', 'spain', 'germany', 'usa']) {
    bot.command(team, async (ctx) => ctx.replyWithMarkdown(reply(await teamReport(team))));
  }

  bot.command('live', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const isSub = await redis().sismember(SUBS_KEY, chatId);
    if (isSub) {
      await redis().srem(SUBS_KEY, chatId);
      await ctx.reply('🔕 Live alerts disabled for this chat.');
    } else {
      await redis().sadd(SUBS_KEY, chatId);
      await ctx.reply('🔔 Live alerts enabled. You will receive whale & steam alerts here.');
    }
  });

  bot.catch((err, ctx) => log.error({ err: String(err), update: ctx.updateType }, 'bot handler error'));
  return bot;
}

export { SUBS_KEY };
