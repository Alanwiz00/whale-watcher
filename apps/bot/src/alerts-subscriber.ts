import { CHANNELS, config, createRedis, logger, redis, type AlertPayload } from '@whale/core';
import type { Telegraf } from 'telegraf';
import { SUBS_KEY } from './bot.js';

const log = logger.child({ svc: 'bot', mod: 'alerts' });

/**
 * Alert types delivered ONLY to /live subscribers, never the default broadcast
 * chats. Steam moves are lower-confidence/noisier, so they're opt-in via /live.
 */
const LIVE_ONLY_TYPES = new Set<AlertPayload['type']>(['steam_move']);

const EMOJI: Record<string, string> = {
  whale_trade: '🐋',
  split_accumulation: '🧩',
  smart_money: '🧠',
  steam_move: '🚂',
  market_impact: '💥',
  arbitrage: '⚖️',
  volume_anomaly: '📊',
  wallet_anomaly: '🕵️',
  market_open: '🆕',
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

    // Bot-side size gate: the engine detects/stores whales at WHALE_THRESHOLD_USD
    // (rich dashboard), but Telegram only pings for trades/accumulations ≥
    // TELEGRAM_MIN_ALERT_USD. Non-size alerts (steam/arb/volume/wallet) use their
    // own detection thresholds and are unaffected.
    // High-conviction whales (big payout + high upside) ALWAYS ping, bypassing
    // the size gate — they're the headline signal.
    const bigUpside = (alert.data as Record<string, unknown> | undefined)?.bigUpside === true;
    const usd = alertUsd(alert);
    if (!bigUpside && usd != null && usd < config.TELEGRAM_MIN_ALERT_USD) return;

    const text = render(alert);

    const targets = new Set<string>();
    if (alert.type === 'market_open') {
      // Gated delivery: market-open (new Elon window) goes ONLY to the selected
      // chats — never the general broadcast or /live subscribers.
      for (const id of config.TELEGRAM_MARKET_OPEN_CHAT_ID) targets.add(id);
    } else {
      // Default broadcast chats get medium+ severity (low = e.g. small "Normal"
      // whales, which would be too chatty). /live chats get everything.
      // Steam moves are lower-confidence/noisier, so they're firehose-only: never
      // broadcast — delivered solely to chats that opted in via /live.
      const liveOnly = LIVE_ONLY_TYPES.has(alert.type);
      if (!liveOnly && alert.severity !== 'low') {
        for (const id of config.TELEGRAM_ALERT_CHAT_ID) targets.add(id);
      }
      const subs = await redis().smembers(SUBS_KEY);
      for (const s of subs) targets.add(s);
    }

    for (const chatId of targets) {
      if (!(await allow())) break;
      try {
        await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        log.warn({ err: String(err), chatId }, 'failed to deliver alert');
      }
    }
  });

  log.info(
    { minAlertUsd: config.TELEGRAM_MIN_ALERT_USD },
    'telegram alert subscriber ready',
  );
}

/** USD magnitude of a size/volume-based alert, or null if the gate doesn't apply. */
function alertUsd(a: AlertPayload): number | null {
  const d = (a.data ?? {}) as Record<string, unknown>;
  if (a.type === 'whale_trade') return Number(d.sizeUsd) || null;
  if (a.type === 'split_accumulation') return Number(d.aggregateUsd) || null;
  if (a.type === 'volume_anomaly') return Number(d.latestUsd) || null;
  return null;
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
