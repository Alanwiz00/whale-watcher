import { CHANNELS, logger, redis, type AlertPayload } from '@whale/core';
import { prisma, type Prisma } from '@whale/db';
import { alertsEmitted } from './metrics.js';

const log = logger.child({ svc: 'engine', mod: 'alerts' });

const CHANNEL_BY_TYPE: Record<string, string> = {
  whale_trade: CHANNELS.whales,
  split_accumulation: CHANNELS.whales,
  smart_money: CHANNELS.whales,
  steam_move: CHANNELS.steam,
  arbitrage: CHANNELS.arbitrage,
};

/**
 * Persist + fan-out an alert. Idempotent on `dedupeKey`: a repeated detection
 * (e.g. the same whale trade seen twice) is dropped silently. Published to a
 * Redis channel that both the API WebSocket and the Telegram bot subscribe to.
 */
export async function emitAlert(
  payload: AlertPayload,
  refs?: { marketId?: string; walletId?: string | null },
): Promise<boolean> {
  const existing = await prisma.alert.findUnique({
    where: { dedupeKey: payload.dedupeKey },
    select: { id: true },
  });
  if (existing) return false;

  try {
    await prisma.alert.create({
      data: {
        type: payload.type,
        severity: payload.severity,
        platform: payload.platform,
        marketId: refs?.marketId ?? null,
        walletId: refs?.walletId ?? null,
        title: payload.title,
        body: payload.body,
        data: payload.data as Prisma.InputJsonValue,
        dedupeKey: payload.dedupeKey,
      },
    });
  } catch (err) {
    // Unique race: another worker inserted the same dedupeKey first.
    log.debug({ err: String(err), dedupeKey: payload.dedupeKey }, 'alert insert race, skipping');
    return false;
  }

  const message = JSON.stringify(payload);
  const channel = CHANNEL_BY_TYPE[payload.type] ?? CHANNELS.alerts;
  // Publish to the type-specific channel AND the firehose.
  await redis().publish(channel, message);
  if (channel !== CHANNELS.alerts) await redis().publish(CHANNELS.alerts, message);

  alertsEmitted.inc({ type: payload.type, severity: payload.severity });
  log.info({ type: payload.type, severity: payload.severity, title: payload.title }, 'alert emitted');
  return true;
}
