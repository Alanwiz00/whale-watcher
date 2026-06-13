import { CHANNELS, config, createRedis, logger, redis, type AlertPayload } from '@whale/core';
import type { Telegraf } from 'telegraf';
import { SUBS_KEY } from './bot.js';

const log = logger.child({ svc: 'bot', mod: 'alerts' });

const EMOJI: Record<string, string> = {
  whale_trade: '🐋',
  split_accumulation: '🧩',
  smart_money: '🧠',
  steam_move: '🚂',
  market_impact: '💥',
  arbitrage: '⚖️',
  volume_anomaly: '📊',
  wallet_anomaly: '🕵️',
};

/**
 * Bridge engine alerts → Telegram. High/critical alerts always hit the default
 * broadcast chat; every alert hits chats that opted in via /live. A small Redis
 * token bucket protects us from Telegram's ~30 msg/s global limit.
 */
export async function startAlertsSubscriber(bot: Telegraf): Promise<void> {
  const sub = createRedis();
  await sub.subscribe(CHANNELS.alerts);

  sub.on('message', async (_channel, message) => {
    let alert: AlertPayload;
    try {
      alert = JSON.parse(message);
    } catch {
      return;
    }
    const text = render(alert);

    const targets = new Set<string>();
    if (
      config.TELEGRAM_ALERT_CHAT_ID &&
      (alert.severity === 'high' || alert.severity === 'critical')
    ) {
      targets.add(config.TELEGRAM_ALERT_CHAT_ID);
    }
    const subs = await redis().smembers(SUBS_KEY);
    for (const s of subs) targets.add(s);

    for (const chatId of targets) {
      if (!(await allow())) break;
      try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        log.warn({ err: String(err), chatId }, 'failed to deliver alert');
      }
    }
  });

  log.info('telegram alert subscriber ready');
}

function render(a: AlertPayload): string {
  const e = EMOJI[a.type] ?? '🔔';
  const sev = a.severity.toUpperCase();
  return `${e} *${a.title}* _(${sev})_\n${a.body}`;
}

// Simple global rate limiter (~20/s) shared across bot instances via Redis.
async function allow(): Promise<boolean> {
  const key = `ww:tg:rate:${Math.floor(Date.now() / 1000)}`;
  const n = await redis().incr(key);
  if (n === 1) await redis().expire(key, 2);
  return n <= 20;
}
