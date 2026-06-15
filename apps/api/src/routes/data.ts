import { prisma, type Prisma } from '@whale/db';
import type { FastifyInstance } from 'fastify';
import { dec, intParam } from '../serialize.js';

/** All read-only data endpoints powering the dashboard, bot, and integrations. */
export async function dataRoutes(app: FastifyInstance): Promise<void> {
  // ── Overview KPIs ────────────────────────────────────────────────────────
  app.get('/api/overview', async () => {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const [whalesToday, alertsToday, marketsTracked, volumeAgg, topWhale] = await Promise.all([
      prisma.whaleSignal.count({ where: { timestamp: { gte: startOfDay } } }),
      prisma.alert.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.market.count({ where: { status: 'open' } }),
      prisma.trade.aggregate({ where: { timestamp: { gte: startOfDay } }, _sum: { sizeUsd: true } }),
      prisma.whaleSignal.findFirst({ orderBy: { score: 'desc' }, where: { timestamp: { gte: startOfDay } } }),
    ]);
    return {
      whalesToday,
      alertsToday,
      marketsTracked,
      volumeTodayUsd: dec(volumeAgg._sum.sizeUsd),
      topWhaleScore: topWhale?.score ?? null,
    };
  });

  // ── Recent whale signals ───────────────────────────────────────────────────
  app.get('/api/whales', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = intParam(q.limit, 50);
    const where: Prisma.WhaleSignalWhereInput = {};
    if (q.platform) where.platform = q.platform as Prisma.WhaleSignalWhereInput['platform'];
    if (q.minScore) where.score = { gte: Number(q.minScore) };
    if (q.tier) where.tier = q.tier as Prisma.WhaleSignalWhereInput['tier'];

    const rows = await prisma.whaleSignal.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      include: {
        market: { select: { title: true, eventType: true, team: true } },
        wallet: { select: { address: true, stats: { select: { roi: true, winRate: true } } } },
      },
    });
    return rows.map((w) => ({
      id: w.id,
      platform: w.platform,
      market: w.market?.title,
      eventType: w.market?.eventType,
      team: w.market?.team,
      wallet: w.wallet?.address ?? null,
      walletRoi: w.wallet?.stats?.roi ?? null,
      side: w.side,
      price: dec(w.price),
      sizeUsd: dec(w.sizeUsd),
      score: w.score,
      tier: w.tier,
      marketImpactPct: w.marketImpactPct,
      isSplitAggregate: w.isSplitAggregate,
      timestamp: w.timestamp,
    }));
  });

  // ── Wallet leaderboard ─────────────────────────────────────────────────────
  app.get('/api/wallets/top', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = intParam(q.limit, 50, 200);
    const by = q.by === 'volume' ? 'totalStakedUsd' : q.by === 'sharpe' ? 'sharpe' : 'roi';
    const rows = await prisma.walletStats.findMany({
      where: { resolvedPositions: { gte: 0 }, trades: { gte: 3 } },
      orderBy: { [by]: 'desc' } as Prisma.WalletStatsOrderByWithRelationInput,
      take: limit,
      include: { wallet: { select: { address: true, platform: true, label: true } } },
    });
    return rows.map((s) => ({
      wallet: s.wallet.address,
      platform: s.wallet.platform,
      label: s.wallet.label,
      trades: s.trades,
      resolvedPositions: s.resolvedPositions,
      totalStakedUsd: dec(s.totalStakedUsd),
      realizedPnlUsd: dec(s.realizedPnlUsd),
      roi: s.roi,
      winRate: s.winRate,
      avgPositionUsd: dec(s.avgPositionUsd),
      expectedValue: s.expectedValue,
      sharpe: s.sharpe,
      whaleScoreAvg: s.whaleScoreAvg,
      rankRoi: s.rankRoi,
      rankVolume: s.rankVolume,
    }));
  });

  app.get('/api/wallets/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const q = req.query as Record<string, string>;
    const wallet = await prisma.wallet.findFirst({
      where: { address: address.toLowerCase(), ...(q.platform ? { platform: q.platform as Prisma.WalletWhereInput['platform'] } : {}) },
      include: { stats: true },
    });
    if (!wallet) return reply.code(404).send({ error: 'wallet not found' });
    const recent = await prisma.trade.findMany({
      where: { walletId: wallet.id },
      orderBy: { timestamp: 'desc' },
      take: 50,
      include: { market: { select: { title: true } } },
    });
    return {
      wallet: wallet.address,
      platform: wallet.platform,
      stats: wallet.stats && {
        ...wallet.stats,
        totalStakedUsd: dec(wallet.stats.totalStakedUsd),
        realizedPnlUsd: dec(wallet.stats.realizedPnlUsd),
        avgPositionUsd: dec(wallet.stats.avgPositionUsd),
      },
      recentTrades: recent.map((t) => ({
        market: t.market.title,
        side: t.side,
        price: dec(t.price),
        sizeUsd: dec(t.sizeUsd),
        timestamp: t.timestamp,
      })),
    };
  });

  // ── Markets ────────────────────────────────────────────────────────────────
  app.get('/api/markets', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = intParam(q.limit, 100, 500);
    const where: Prisma.MarketWhereInput = {};
    if (q.platform) where.platform = q.platform as Prisma.MarketWhereInput['platform'];
    if (q.eventType) where.eventType = q.eventType as Prisma.MarketWhereInput['eventType'];
    if (q.team) where.team = q.team.toLowerCase();
    if (q.status) where.status = q.status as Prisma.MarketWhereInput['status'];
    const rows = await prisma.market.findMany({
      where,
      orderBy: { volumeUsd: 'desc' },
      take: limit,
    });
    return rows.map((m) => ({
      id: m.id,
      platform: m.platform,
      externalId: m.externalId,
      title: m.title,
      eventType: m.eventType,
      team: m.team,
      canonicalKey: m.canonicalKey,
      status: m.status,
      volumeUsd: dec(m.volumeUsd),
      liquidityUsd: dec(m.liquidityUsd),
      closeTime: m.closeTime,
    }));
  });

  // ── Arbitrage + steam ──────────────────────────────────────────────────────
  app.get('/api/arbitrage', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = intParam(q.limit, 50);
    const rows = await prisma.arbitrageEvent.findMany({
      where: { resolvedAt: null },
      orderBy: { detectedAt: 'desc' },
      take: limit,
    });
    return rows;
  });

  app.get('/api/steam', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = intParam(q.limit, 50);
    const rows = await prisma.steamMove.findMany({
      orderBy: { detectedAt: 'desc' },
      take: limit,
      include: { market: { select: { title: true } } },
    });
    return rows.map((s) => ({
      id: s.id,
      platform: s.platform,
      market: s.market?.title,
      fromProb: dec(s.fromProb),
      toProb: dec(s.toProb),
      movePct: s.movePct,
      noVisibleWhale: s.noVisibleWhale,
      detectedAt: s.detectedAt,
    }));
  });

  // ── Alerts feed ─────────────────────────────────────────────────────────────
  app.get('/api/alerts', async (req) => {
    const q = req.query as Record<string, string>;
    const limit = intParam(q.limit, 50);
    const where: Prisma.AlertWhereInput = {};
    if (q.type) where.type = q.type as Prisma.AlertWhereInput['type'];
    // Comma-separated multi-type filter, e.g. ?types=whale_trade,split_accumulation
    if (q.types) {
      const list = q.types.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) where.type = { in: list as Prisma.EnumAlertTypeFilter['in'] };
    }
    if (q.severity) where.severity = q.severity as Prisma.AlertWhereInput['severity'];
    const rows = await prisma.alert.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
    return rows;
  });
}
