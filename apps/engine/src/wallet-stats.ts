import { logger, quant } from '@whale/core';
import { prisma } from '@whale/db';

const log = logger.child({ svc: 'engine', mod: 'wallet-stats' });

/**
 * Compute smart-money performance for a wallet.
 *
 * PnL accounting: for each (market, outcome) we net buys/sells into a position
 * with cost basis. Remaining open shares are marked to the latest snapshot
 * probability (or to the 0/1 resolution for resolved markets). This yields a
 * meaningful ROI/win-rate/Sharpe *before* the tournament resolves — clearly an
 * estimate that converges to realized PnL as markets settle.
 */
export async function computeWalletStats(walletId: string): Promise<void> {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) return;

  const trades = await prisma.trade.findMany({
    where: { walletId },
    orderBy: { timestamp: 'asc' },
    take: 10_000,
    select: {
      marketId: true,
      outcomeName: true,
      side: true,
      price: true,
      size: true,
      sizeUsd: true,
      market: { select: { status: true } },
    },
  });
  if (trades.length === 0) return;

  // Group by market+outcome.
  type Group = {
    marketId: string;
    outcome: string;
    cost: number;
    proceeds: number;
    boughtShares: number;
    soldShares: number;
    resolved: boolean;
  };
  const groups = new Map<string, Group>();
  for (const t of trades) {
    const key = `${t.marketId}:${t.outcomeName ?? '_'}`;
    const g =
      groups.get(key) ??
      ({
        marketId: t.marketId,
        outcome: t.outcomeName ?? '_',
        cost: 0,
        proceeds: 0,
        boughtShares: 0,
        soldShares: 0,
        resolved: t.market.status === 'resolved',
      } satisfies Group);
    const size = Number(t.size);
    const usd = Number(t.sizeUsd);
    if (t.side === 'buy') {
      g.cost += usd;
      g.boughtShares += size;
    } else {
      g.proceeds += usd;
      g.soldShares += size;
    }
    g.resolved = g.resolved || t.market.status === 'resolved';
    groups.set(key, g);
  }

  // Latest mark price per (market, outcome).
  const markCache = new Map<string, number>();
  async function markPrice(marketId: string, outcome: string): Promise<number> {
    const key = `${marketId}:${outcome}`;
    if (markCache.has(key)) return markCache.get(key)!;
    const snap = await prisma.marketSnapshot.findFirst({
      where: { marketId, OR: [{ outcomeName: outcome }, { outcomeName: null }] },
      orderBy: { timestamp: 'desc' },
      select: { impliedProb: true },
    });
    const p = snap?.impliedProb != null ? Number(snap.impliedProb) : 0.5;
    markCache.set(key, p);
    return p;
  }

  const positions: quant.ResolvedPosition[] = [];
  let resolvedCount = 0;
  for (const g of groups.values()) {
    const netShares = g.boughtShares - g.soldShares;
    let v: number;
    if (g.resolved) {
      const p = await markPrice(g.marketId, g.outcome);
      v = p >= 0.5 ? 1 : 0; // settled value per share
      resolvedCount++;
    } else {
      v = await markPrice(g.marketId, g.outcome);
    }
    const positionValue = netShares * v + g.proceeds;
    const pnl = positionValue - g.cost;
    if (g.cost > 0) positions.push({ stakeUsd: g.cost, pnlUsd: pnl });
  }

  const whaleAgg = await prisma.whaleSignal.aggregate({
    where: { walletId },
    _avg: { score: true },
  });

  const totalStaked = quant.sum(positions.map((p) => p.stakeUsd));
  const realizedPnl = quant.sum(positions.map((p) => p.pnlUsd));

  await prisma.walletStats.upsert({
    where: { walletId },
    create: {
      walletId,
      trades: trades.length,
      resolvedPositions: resolvedCount,
      totalStakedUsd: totalStaked,
      realizedPnlUsd: realizedPnl,
      roi: quant.roi(positions),
      winRate: quant.winRate(positions),
      avgPositionUsd: quant.avgPosition(positions),
      expectedValue: quant.expectedValue(positions),
      sharpe: quant.sharpe(positions),
      whaleScoreAvg: whaleAgg._avg.score ?? null,
    },
    update: {
      trades: trades.length,
      resolvedPositions: resolvedCount,
      totalStakedUsd: totalStaked,
      realizedPnlUsd: realizedPnl,
      roi: quant.roi(positions),
      winRate: quant.winRate(positions),
      avgPositionUsd: quant.avgPosition(positions),
      expectedValue: quant.expectedValue(positions),
      sharpe: quant.sharpe(positions),
      whaleScoreAvg: whaleAgg._avg.score ?? null,
    },
  });

  log.debug({ walletId, positions: positions.length, roi: quant.roi(positions) }, 'wallet stats updated');
}

/**
 * Recompute leaderboard ranks in two set-based UPDATEs using window functions.
 * Far cheaper than the previous per-row transaction (which fired up to ~20k
 * UPDATE statements and hogged a pooled connection). For very large wallet
 * counts, promote this to a materialized view (see DEPLOYMENT.md).
 */
export async function recomputeRanks(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE wallet_stats ws
    SET "rankRoi" = r.rn
    FROM (SELECT id, row_number() OVER (ORDER BY roi DESC) AS rn FROM wallet_stats) r
    WHERE ws.id = r.id`;
  await prisma.$executeRaw`
    UPDATE wallet_stats ws
    SET "rankVolume" = r.rn
    FROM (SELECT id, row_number() OVER (ORDER BY "totalStakedUsd" DESC) AS rn FROM wallet_stats) r
    WHERE ws.id = r.id`;
}
