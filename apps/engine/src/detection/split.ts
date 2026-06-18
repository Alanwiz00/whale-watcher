import { config, logger, redis, traderLabel, traderProfileUrl, type NormalizedTrade } from '@whale/core';
import { prisma } from '@whale/db';
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

  const market = await prisma.market.findUnique({
    where: { id: persisted.marketId },
    select: { title: true },
  });
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const dir = trade.side === 'sell' ? '🔴 SELL' : '🟢 BUY';
  const profileUrl = traderProfileUrl(trade.platform, trade.wallet);
  // Per-leg breakdown, largest first: "$120k + $100k + $100k" (cap at 8 shown).
  const legsDesc = [...sizes].sort((a, b) => b - a);
  const shown = legsDesc.slice(0, 8).map(usd).join(' + ');
  const breakdown = legsDesc.length > 8 ? `${shown} + … (${legsDesc.length - 8} more)` : shown;

  const emitted = await emitAlert(
    {
      type: 'split_accumulation',
      severity: aggregate >= 2 * config.SPLIT_THRESHOLD_USD ? 'high' : 'medium',
      platform: trade.platform,
      title: 'Split Accumulation Detected',
      body: [
        `Platform: ${trade.platform}`,
        `Market: ${market?.title ?? trade.marketExternalId}`,
        `Trader: ${traderLabel(trade.trader, trade.wallet)}`,
        profileUrl ? `Profile: ${profileUrl}` : null,
        `Action: ${dir} ${trade.outcomeName ?? ''}`.trim(),
        `Accumulated ${usd(aggregate)} across ${members.length} legs`,
        `Breakdown: ${breakdown}`,
        `Window: ${Math.round(config.SPLIT_WINDOW_MS / 60000)} min`,
      ]
        .filter(Boolean)
        .join('\n'),
      data: {
        wallet: trade.wallet,
        trader: trade.trader,
        profileUrl,
        legs: members.length,
        aggregateUsd: aggregate,
        sizes: legsDesc,
        side: trade.side,
        outcome: trade.outcomeName,
        marketTitle: market?.title,
      },
      dedupeKey,
      createdAt: new Date(),
    },
    { marketId: persisted.marketId, walletId: persisted.walletId },
  );

  if (emitted) log.info({ wallet: trade.wallet, aggregate, legs: members.length }, 'split accumulation');
}
