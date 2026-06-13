import { config, logger, redis, type NormalizedTrade } from '@whale/core';
import { emitAlert } from '../alerts.js';
import type { PersistedTrade } from '../persist.js';

const log = logger.child({ svc: 'engine', mod: 'split' });

/**
 * Split-order / accumulation detection. A single actor breaking a large
 * position into chunks (e.g. $100k + $100k + $120k within 15 min) evades the
 * single-trade whale trigger. We keep a rolling Redis sorted set per
 * (wallet, market, outcome) scored by timestamp, trim to the window, and fire
 * when the windowed sum crosses SPLIT_THRESHOLD_USD across ≥2 trades.
 *
 * Requires an identifiable wallet, so it only applies to wallet-native venues
 * (Polymarket, Manifold).
 */
export async function detectSplitAccumulation(
  trade: NormalizedTrade,
  persisted: PersistedTrade,
): Promise<void> {
  if (!trade.wallet) return;

  const r = redis();
  const nowMs = trade.timestamp.getTime();
  const windowStart = nowMs - config.SPLIT_WINDOW_MS;
  const key = `ww:split:${trade.platform}:${trade.wallet}:${persisted.marketId}:${trade.outcomeName ?? '_'}:${trade.side}`;

  await r.zadd(key, nowMs, `${trade.externalId}|${trade.sizeUsd}`);
  await r.zremrangebyscore(key, 0, windowStart);
  await r.pexpire(key, config.SPLIT_WINDOW_MS * 2);

  const members = await r.zrangebyscore(key, windowStart, nowMs);
  if (members.length < 2) return;

  const sizes = members.map((m) => Number(m.split('|')[1] ?? 0));
  const aggregate = sizes.reduce((a, b) => a + b, 0);
  if (aggregate < config.SPLIT_THRESHOLD_USD) return;

  // One alert per wallet/market per window bucket to avoid spam as more legs land.
  const bucket = Math.floor(nowMs / config.SPLIT_WINDOW_MS);
  const dedupeKey = `split:${trade.platform}:${trade.wallet}:${persisted.marketId}:${bucket}`;

  const emitted = await emitAlert(
    {
      type: 'split_accumulation',
      severity: aggregate >= 2 * config.SPLIT_THRESHOLD_USD ? 'high' : 'medium',
      platform: trade.platform,
      title: 'Split Accumulation Detected',
      body: [
        `Platform: ${trade.platform}`,
        `Wallet: ${trade.wallet}`,
        `Legs: ${members.length}`,
        `Whale accumulated $${aggregate.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        `Window: ${Math.round(config.SPLIT_WINDOW_MS / 60000)} min`,
      ].join('\n'),
      data: {
        wallet: trade.wallet,
        legs: members.length,
        aggregateUsd: aggregate,
        sizes,
        side: trade.side,
        outcome: trade.outcomeName,
      },
      dedupeKey,
      createdAt: new Date(),
    },
    { marketId: persisted.marketId, walletId: persisted.walletId },
  );

  if (emitted) log.info({ wallet: trade.wallet, aggregate, legs: members.length }, 'split accumulation');
}
