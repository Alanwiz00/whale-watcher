import {
  classifyTier,
  computeWhaleScore,
  config,
  quant,
  type AlertSeverity,
  type NormalizedTrade,
} from '@whale/core';
import { prisma, tierToEnum } from '@whale/db';
import { emitAlert } from '../alerts.js';
import { whalesDetected } from '../metrics.js';
import type { PersistedTrade } from '../persist.js';
import { measureImpact } from './impact.js';

/**
 * Single-trade whale detection. Fires when notional ≥ WHALE_THRESHOLD_USD,
 * scores the trade with wallet history + market impact + timing, persists a
 * WhaleSignal, and emits a severity-graded alert.
 */
export async function detectWhale(trade: NormalizedTrade, persisted: PersistedTrade): Promise<void> {
  if (trade.sizeUsd < config.WHALE_THRESHOLD_USD) return;

  const stats = persisted.walletId
    ? await prisma.walletStats.findUnique({ where: { walletId: persisted.walletId } })
    : null;

  const impact = await measureImpact(persisted.marketId, trade.outcomeName ?? null, trade.timestamp, trade.price);

  const { score, tier, components } = computeWhaleScore({
    sizeUsd: trade.sizeUsd,
    walletRoi: stats?.roi ?? null,
    walletWinRate: stats?.winRate ?? null,
    walletSampleSize: stats?.resolvedPositions ?? 0,
    marketImpactPct: impact?.pct ?? null,
    timing: timingScore(trade),
  });

  await prisma.whaleSignal.upsert({
    where: { tradeId: persisted.id },
    create: {
      tradeId: persisted.id,
      platform: trade.platform,
      marketId: persisted.marketId,
      walletId: persisted.walletId,
      sizeUsd: trade.sizeUsd,
      side: trade.side,
      price: trade.price,
      score,
      tier: tierToEnum(tier),
      componentSize: components.positionSize,
      componentRoi: components.historicalRoi,
      componentImpact: components.marketImpact,
      componentTiming: components.timing,
      marketImpactPct: impact?.pct ?? null,
      timestamp: trade.timestamp,
    },
    update: { score, tier: tierToEnum(tier) },
  });

  whalesDetected.inc({ platform: trade.platform, tier: tierToEnum(tier) });

  const market = await prisma.market.findUnique({
    where: { id: persisted.marketId },
    select: { title: true },
  });

  await emitAlert(
    {
      type: 'whale_trade',
      severity: severityFor(score),
      platform: trade.platform,
      title: `${classifyTier(score)} Detected`,
      body: formatWhaleAlert({
        platform: trade.platform,
        market: market?.title ?? trade.marketExternalId,
        sizeUsd: trade.sizeUsd,
        roi: stats?.roi ?? null,
        score,
        impactPct: impact?.pct ?? null,
      }),
      data: {
        tradeExternalId: trade.externalId,
        wallet: trade.wallet,
        side: trade.side,
        price: trade.price,
        sizeUsd: trade.sizeUsd,
        score,
        tier,
        components,
        marketImpactPct: impact?.pct ?? null,
        marketTitle: market?.title,
      },
      dedupeKey: `whale:${trade.platform}:${trade.externalId}`,
      createdAt: new Date(),
    },
    { marketId: persisted.marketId, walletId: persisted.walletId },
  );
}

function severityFor(score: number): AlertSeverity {
  if (score >= 90) return 'critical';
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

/**
 * Timing quality in [0,1]: reward contrarian/early entries (buying a long-shot,
 * selling a near-certainty), penalize chasing. Neutral 0.5 mid-book.
 */
function timingScore(trade: NormalizedTrade): number {
  const p = trade.price;
  if (trade.side === 'buy') return quant.clamp(0.5 + (0.5 - p), 0, 1);
  return quant.clamp(0.5 + (p - 0.5), 0, 1);
}

function formatWhaleAlert(a: {
  platform: string;
  market: string;
  sizeUsd: number;
  roi: number | null;
  score: number;
  impactPct: number | null;
}): string {
  const roi = a.roi == null ? 'n/a' : `${a.roi >= 0 ? '+' : ''}${(a.roi * 100).toFixed(0)}%`;
  const impact = a.impactPct == null ? 'n/a' : `${a.impactPct >= 0 ? '+' : ''}${(a.impactPct * 100).toFixed(1)}%`;
  return [
    `Platform: ${a.platform}`,
    `Market: ${a.market}`,
    `Size: $${a.sizeUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
    `Wallet ROI: ${roi}`,
    `Whale Score: ${a.score}`,
    `Market Impact: ${impact}`,
  ].join('\n');
}
