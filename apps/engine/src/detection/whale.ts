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
  // Skip near-certainty buys (e.g. BUY No @ 99.5%): ~0 upside, risk-free parking,
  // not conviction. (Long-shot buys at low prices are kept — those are real bets.)
  if (trade.side !== 'sell' && trade.price >= config.WHALE_MAX_PRICE) return;

  const stats = persisted.walletId
    ? await prisma.walletStats.findUnique({ where: { walletId: persisted.walletId } })
    : null;

  const impact = await measureImpact(persisted.marketId, trade.outcomeName ?? null, trade.timestamp, trade.price);

  const { score, tier, components } = computeWhaleScore({
    sizeUsd: trade.sizeUsd,
    thresholdUsd: config.WHALE_THRESHOLD_USD,
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
    select: { title: true, volumeUsd: true },
  });
  const volumeUsd = market?.volumeUsd != null ? Number(market.volumeUsd) : null;
  const currentProb = impact?.after ?? trade.price; // post-trade implied probability

  // BUY → potential payout if the outcome wins (each share settles at $1):
  //   payout = cost / price; profit = payout − cost. SELL → realized PnL vs the
  //   wallet's average entry on this outcome.
  const isBuy = trade.side !== 'sell';
  const payoutIfWin = isBuy && trade.price > 0 ? trade.sizeUsd / trade.price : null;
  const sellPnl = !isBuy ? await estimateSellPnl(trade, persisted) : null;

  await emitAlert(
    {
      type: 'whale_trade',
      severity: severityFor(score),
      platform: trade.platform,
      title: `${classifyTier(score)} Detected`,
      body: formatWhaleAlert({
        platform: trade.platform,
        market: market?.title ?? trade.marketExternalId,
        trader: trade.trader ?? null,
        wallet: trade.wallet ?? null,
        side: trade.side,
        outcome: trade.outcomeName ?? null,
        entryPrice: trade.price,
        currentProb,
        sizeUsd: trade.sizeUsd,
        volumeUsd,
        payoutIfWin,
        sellPnl,
        roi: stats?.roi ?? null,
        score,
        impactPct: impact?.pct ?? null,
      }),
      data: {
        tradeExternalId: trade.externalId,
        wallet: trade.wallet,
        trader: trade.trader,
        side: trade.side,
        outcome: trade.outcomeName,
        entryPrice: trade.price,
        currentProb,
        price: trade.price,
        sizeUsd: trade.sizeUsd,
        volumeUsd,
        payoutIfWin,
        sellPnl,
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
  trader: string | null;
  wallet: string | null;
  side: string;
  outcome: string | null;
  entryPrice: number;
  currentProb: number | null;
  sizeUsd: number;
  volumeUsd: number | null;
  payoutIfWin: number | null;
  sellPnl: number | null;
  roi: number | null;
  score: number;
  impactPct: number | null;
}): string {
  const pct = (p: number | null) => (p == null ? 'n/a' : `${(p * 100).toFixed(1)}%`);
  const usd = (n: number | null) =>
    n == null ? 'n/a' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const signedUsd = (n: number) =>
    `${n >= 0 ? '+' : '-'}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  const roi = a.roi == null ? 'n/a' : `${a.roi >= 0 ? '+' : ''}${(a.roi * 100).toFixed(0)}%`;
  const impact = a.impactPct == null ? 'n/a' : `${a.impactPct >= 0 ? '+' : ''}${(a.impactPct * 100).toFixed(1)}%`;
  // e.g. "🟢 BUY Yes @ 12.3%"  — side + outcome backed + price paid (implied prob).
  const isBuy = a.side.toLowerCase() !== 'sell';
  const action = `${isBuy ? '🟢 BUY' : '🔴 SELL'} ${a.outcome ?? ''}`.trim();

  // Trader display name (Polymarket exposes one), with the short wallet for
  // verification; fall back to the short wallet alone when there's no name.
  const shortWallet =
    a.wallet && a.wallet.length > 10 ? `${a.wallet.slice(0, 5)}…${a.wallet.slice(-5)}` : a.wallet;
  const trader = a.trader ? (shortWallet ? `${a.trader} (${shortWallet})` : a.trader) : (shortWallet ?? 'unknown');

  // BUY → payout if it wins (+profit · multiple); SELL → estimated realized PnL.
  let outcomeLine: string;
  if (isBuy) {
    if (a.payoutIfWin != null) {
      const profit = a.payoutIfWin - a.sizeUsd;
      const mult = a.sizeUsd > 0 ? a.payoutIfWin / a.sizeUsd : 0;
      outcomeLine = `Payout if win: ${usd(a.payoutIfWin)} (${signedUsd(profit)} · ${mult.toFixed(1)}×)`;
    } else {
      outcomeLine = 'Payout if win: n/a';
    }
  } else {
    outcomeLine =
      a.sellPnl == null ? 'Est. PnL: n/a (no entry on record)' : `Est. PnL: ${signedUsd(a.sellPnl)}`;
  }

  return [
    `Platform: ${a.platform}`,
    `Market: ${a.market}`,
    `Trader: ${trader}`,
    `Action: ${action} @ ${pct(a.entryPrice)}`,
    `Size: ${usd(a.sizeUsd)}`,
    outcomeLine,
    // Price of the OUTCOME they backed (labelled to avoid "Ecuador 99.5%?"
    // confusion when the backed side is No on a "Will X win?" market).
    `${a.outcome ?? 'Outcome'} price now: ${pct(a.currentProb)}`,
    `Market volume: ${usd(a.volumeUsd)}`,
    `Wallet ROI: ${roi}`,
    `Whale Score: ${a.score}`,
    `Market Impact: ${impact}`,
  ].join('\n');
}

/**
 * Estimated realized PnL of a SELL vs the wallet's VWAP entry on this outcome:
 * sharesSold × (sellPrice − avgEntry). Null when there's no recorded entry
 * (we only see WC-2026 history) — labelled as an estimate, not exact accounting.
 */
async function estimateSellPnl(
  trade: NormalizedTrade,
  persisted: PersistedTrade,
): Promise<number | null> {
  if (!persisted.walletId || trade.price <= 0) return null;
  const buys = await prisma.trade.aggregate({
    where: {
      walletId: persisted.walletId,
      marketId: persisted.marketId,
      outcomeName: trade.outcomeName ?? null,
      side: 'buy',
    },
    _sum: { sizeUsd: true, size: true },
  });
  const buyUsd = Number(buys._sum.sizeUsd ?? 0);
  const buyShares = Number(buys._sum.size ?? 0);
  if (buyShares <= 0) return null;
  const avgEntry = buyUsd / buyShares; // VWAP entry price (implied prob)
  const sharesSold = trade.sizeUsd / trade.price;
  return sharesSold * (trade.price - avgEntry);
}
