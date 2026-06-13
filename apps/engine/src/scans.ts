import { logger, quant, type Platform } from '@whale/core';
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
 * Wallet behavior anomaly: build feature vectors over active wallets and run an
 * Isolation Forest. High anomaly scores surface wallets whose size/frequency/
 * performance profile is unlike the population — candidate smart money or
 * manipulation. Features are normalized to comparable scales.
 */
export async function detectWalletAnomalies(): Promise<number> {
  const stats = await prisma.walletStats.findMany({
    where: { trades: { gte: 3 } },
    orderBy: { totalStakedUsd: 'desc' },
    take: 5_000,
    select: {
      walletId: true,
      trades: true,
      totalStakedUsd: true,
      avgPositionUsd: true,
      roi: true,
      winRate: true,
      sharpe: true,
    },
  });
  if (stats.length < 20) return 0;

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
    const score = forest.score(features[i]!);
    if (score < 0.66) continue;
    const s = stats[i]!;
    const wallet = await prisma.wallet.findUnique({
      where: { id: s.walletId },
      select: { address: true, platform: true },
    });
    if (!wallet) continue;
    const emitted = await emitAlert(
      {
        type: 'wallet_anomaly',
        severity: score >= 0.72 ? 'high' : 'medium',
        platform: wallet.platform,
        title: 'Unusual Wallet Behavior',
        body: [
          `Platform: ${wallet.platform}`,
          `Wallet: ${wallet.address}`,
          `Anomaly score: ${(score * 100).toFixed(0)}/100`,
          `ROI ${(s.roi * 100).toFixed(0)}% · ${s.trades} trades · staked $${Number(s.totalStakedUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        ].join('\n'),
        data: { anomalyScore: score, roi: s.roi, trades: s.trades, sharpe: s.sharpe },
        dedupeKey: `walletanom:${s.walletId}:${Math.floor(Date.now() / (24 * HOUR))}`,
        createdAt: new Date(),
      },
      { walletId: s.walletId },
    );
    if (emitted) flagged++;
  }
  if (flagged) log.info({ flagged }, 'wallet anomalies flagged');
  return flagged;
}
