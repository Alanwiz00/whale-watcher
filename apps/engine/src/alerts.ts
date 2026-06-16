import { CHANNELS, logger, redis, type AlertPayload } from '@whale/core';
import { prisma, type Prisma } from '@whale/db';
import { alertsEmitted } from './metrics.js';

const log = logger.child({ svc: 'engine', mod: 'alerts' });

// The "whales" channel is the high-signal feed the dashboard Live tab shows:
// notable big trades + sudden volume accumulation only.
const CHANNEL_BY_TYPE: Record<string, string> = {
  whale_trade: CHANNELS.whales,
  split_accumulation: CHANNELS.whales,
  smart_money: CHANNELS.whales,
  volume_anomaly: CHANNELS.whales,
  steam_move: CHANNELS.steam,
  arbitrage: CHANNELS.arbitrage,
  wallet_anomaly: CHANNELS.alerts,
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
  // Atomic, race-free dedupe: createMany + skipDuplicates compiles to
  // `INSERT ... ON CONFLICT DO NOTHING`, so a concurrent duplicate is skipped at
  // the DB without raising (and logging) a unique-constraint violation. count===0
  // means the alert already existed → don't re-publish.
  const { count } = await prisma.alert.createMany({
    data: [
      {
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
    ],
    skipDuplicates: true,
  });
  if (count === 0) return false;

  const message = JSON.stringify(payload);
  const channel = CHANNEL_BY_TYPE[payload.type] ?? CHANNELS.alerts;
  // Publish to the type-specific channel AND the firehose.
  await redis().publish(channel, message);
  if (channel !== CHANNELS.alerts) await redis().publish(CHANNELS.alerts, message);

  alertsEmitted.inc({ type: payload.type, severity: payload.severity });
  // Log the key structured fields so each line is actionable (pino drops the
  // undefined ones per alert type). The full human-readable text is `payload.body`.
  const d = (payload.data ?? {}) as Record<string, unknown>;
  log.info(
    {
      type: payload.type,
      severity: payload.severity,
      platform: payload.platform,
      title: payload.title,
      market: d.marketTitle,
      trader: d.trader,
      outcome: d.outcome,
      side: d.side,
      usd: d.sizeUsd ?? d.aggregateUsd ?? d.latestUsd,
      price: d.entryPrice ?? d.currentProb ?? d.toProb,
      score: d.score,
      wallet: d.wallet,
    },
    'alert emitted',
  );
  return true;
}
