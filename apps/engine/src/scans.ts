import { config, logger, quant, type Platform } from '@whale/core';
import { prisma } from '@whale/db';
import { emitAlert } from './alerts.js';
import { IsolationForest } from './anomaly.js';

const log = logger.child({ svc: 'engine', mod: 'scans' });

const HOUR = 3_600_000;

/**
 * Volume anomaly: for markets active in the last hour, bucket the trailing 24h
 * into hourly notional and flag when the latest hour is a robust-z outlier
 * (median + MAD based, so it tolerates fat tails). Catches sudden volume spikes
 * that often precede or accompany sharp action.
 */
export async function detectVolumeAnomalies(): Promise<number> {
  const since = new Date(Date.now() - HOUR);
  const active = await prisma.trade.findMany({
    where: { timestamp: { gte: since } },
    distinct: ['marketId'],
    select: { marketId: true, platform: true },
    take: 500,
  });

  let flagged = 0;
  for (const { marketId, platform } of active) {
    const trades = await prisma.trade.findMany({
      where: { marketId, timestamp: { gte: new Date(Date.now() - 24 * HOUR) } },
      select: { timestamp: true, sizeUsd: true },
    });
    if (trades.length < 12) continue;

    const buckets = new Array<number>(24).fill(0);
    const now = Date.now();
    for (const t of trades) {
      const hoursAgo = Math.floor((now - t.timestamp.getTime()) / HOUR);
      if (hoursAgo >= 0 && hoursAgo < 24) buckets[hoursAgo]! += Number(t.sizeUsd);
    }
    const latest = buckets[0]!;
    const history = buckets.slice(1).filter((v) => v > 0);
    if (history.length < 4) continue;
    const z = quant.robustZ(latest, history);
    if (z < 4 || latest <= 0) continue;

    const market = await prisma.market.findUnique({ where: { id: marketId }, select: { title: true } });
    const emitted = await emitAlert(
      {
        type: 'volume_anomaly',
        severity: z >= 7 ? 'high' : 'medium',
        platform: platform as Platform,
        title: 'Unusual Volume Spike',
        body: [
          `Platform: ${platform}`,
          `Market: ${market?.title ?? marketId}`,
          `Last hour: $${latest.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          `Robust z-score: ${z.toFixed(1)}`,
        ].join('\n'),
        data: { z, latestUsd: latest, medianUsd: quant.median(history), marketTitle: market?.title },
        dedupeKey: `vol:${marketId}:${Math.floor(now / HOUR)}`,
        createdAt: new Date(),
      },
      { marketId },
    );
    if (emitted) flagged++;
  }
  if (flagged) log.info({ flagged }, 'volume anomalies flagged');
  return flagged;
}

/**
 * Smart-money wallet signal (formerly raw "wallet anomaly").
 *
 * A pure Isolation Forest over mark-to-market stats just flags statistical
 * oddballs — including tiny-stake accounts and losers — which isn't actionable.
 * Instead we only surface wallets that are ALL of:
 *   1. serious      — staked ≥ WALLET_ALERT_MIN_STAKE_USD and ≥ MIN_TRADES trades
 *   2. profitable   — ROI ≥ MIN_ROI and win-rate ≥ MIN_WIN_RATE
 *   3. a standout   — a high Isolation-Forest score vs the serious-wallet pool
 * Negative/low-stake oddballs are ignored. Fires rarely, once per wallet/day,
 * and explains *why* (ROI, win-rate, sample, stake).
 */
const SMART_WALLET = {
  MIN_TRADES: 8,
  MIN_ROI: 0.15, // mark-to-market; converges to realized as markets settle
  MIN_WIN_RATE: 0.5,
  SCORE_FLOOR: 0.72, // Isolation-Forest standout threshold
  MIN_POOL: 20, // need enough serious wallets to define "unusual"
} as const;

export async function detectWalletAnomalies(): Promise<number> {
  const stats = await prisma.walletStats.findMany({
    where: {
      // Manifold is included via its mana→USD conversion; the stake floor (USD)
      // naturally keeps tiny play-money wallets out.
      totalStakedUsd: { gte: config.WALLET_ALERT_MIN_STAKE_USD },
      trades: { gte: SMART_WALLET.MIN_TRADES },
    },
    orderBy: { totalStakedUsd: 'desc' },
    take: 5_000,
    select: {
      walletId: true,
      trades: true,
      resolvedPositions: true,
      totalStakedUsd: true,
      avgPositionUsd: true,
      roi: true,
      winRate: true,
      sharpe: true,
    },
  });
  if (stats.length < SMART_WALLET.MIN_POOL) return 0;

  const features = stats.map((s) => [
    Math.log10(Number(s.totalStakedUsd) + 1),
    Math.log10(Number(s.avgPositionUsd) + 1),
    Math.log10(s.trades + 1),
    quant.clamp(s.roi, -2, 5),
    s.winRate,
    quant.clamp(s.sharpe, -5, 5),
  ]);
  const forest = new IsolationForest(120, 256).fit(features);

  let flagged = 0;
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i]!;
    // Must be profitable smart money, not just statistically weird.
    if (s.roi < SMART_WALLET.MIN_ROI || s.winRate < SMART_WALLET.MIN_WIN_RATE) continue;
    const score = forest.score(features[i]!);
    if (score < SMART_WALLET.SCORE_FLOOR) continue;

    const wallet = await prisma.wallet.findUnique({
      where: { id: s.walletId },
      select: { address: true, platform: true },
    });
    if (!wallet) continue;

    const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
    const sample =
      s.resolvedPositions > 0 ? `${s.resolvedPositions} resolved` : 'mark-to-market';
    const emitted = await emitAlert(
      {
        type: 'wallet_anomaly',
        // High only when it's both a strong standout AND strongly profitable.
        severity: score >= 0.78 && s.roi >= 0.4 ? 'high' : 'medium',
        platform: wallet.platform,
        title: 'Smart-Money Wallet',
        body: [
          `Platform: ${wallet.platform}`,
          `Wallet: ${wallet.address}`,
          `ROI ${(s.roi * 100).toFixed(0)}% · win ${(s.winRate * 100).toFixed(0)}% (${sample})`,
          `Staked ${usd(Number(s.totalStakedUsd))} · ${s.trades} trades · avg ${usd(Number(s.avgPositionUsd))}`,
          `Standout score ${(score * 100).toFixed(0)}/100`,
        ].join('\n'),
        data: {
          anomalyScore: score,
          roi: s.roi,
          winRate: s.winRate,
          trades: s.trades,
          resolvedPositions: s.resolvedPositions,
          totalStakedUsd: Number(s.totalStakedUsd),
          sharpe: s.sharpe,
        },
        dedupeKey: `smartwallet:${s.walletId}:${Math.floor(Date.now() / (24 * HOUR))}`,
        createdAt: new Date(),
      },
      { walletId: s.walletId },
    );
    if (emitted) flagged++;
  }
  if (flagged) log.info({ flagged }, 'smart-money wallets flagged');
  return flagged;
}
