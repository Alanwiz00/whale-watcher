import {
  classifyEventType,
  type NormalizedMarket,
  type NormalizedOrderBook,
  type NormalizedTrade,
  type Platform,
} from '@whale/core';
import { prisma, type Prisma } from '@whale/db';

/**
 * All DB writes live here so the detection modules stay pure-ish and testable.
 * Everything is idempotent on (platform, externalId) so re-ingesting is safe.
 */

const eventTypeEnum = (s: string) => s as Prisma.MarketCreateInput['eventType'];

export async function upsertMarket(m: NormalizedMarket): Promise<{ id: string }> {
  const primary = m.outcomes?.find((o) => o.impliedProb != null);
  const row = await prisma.market.upsert({
    where: { platform_externalId: { platform: m.platform, externalId: m.externalId } },
    create: {
      platform: m.platform,
      externalId: m.externalId,
      title: m.title,
      eventType: eventTypeEnum(m.eventType),
      team: m.team ?? null,
      canonicalKey: m.canonicalKey ?? null,
      startTime: m.startTime ?? null,
      closeTime: m.closeTime ?? null,
      status: m.status,
      volumeUsd: m.volumeUsd ?? null,
      liquidityUsd: m.liquidityUsd ?? null,
    },
    update: {
      title: m.title,
      eventType: eventTypeEnum(m.eventType),
      team: m.team ?? null,
      canonicalKey: m.canonicalKey ?? null,
      status: m.status,
      volumeUsd: m.volumeUsd ?? undefined,
      liquidityUsd: m.liquidityUsd ?? undefined,
    },
    select: { id: true },
  });

  // Capture a per-outcome snapshot for steam/arb time series. Falls back to the
  // headline outcome when only one is priced.
  const priced = (m.outcomes ?? []).filter((o) => o.impliedProb != null);
  if (priced.length > 0) {
    const now = new Date();
    await prisma.marketSnapshot.createMany({
      data: priced.map((o) => ({
        marketId: row.id,
        outcomeName: o.name,
        impliedProb: o.impliedProb!,
        volumeUsd: m.volumeUsd ?? null,
        liquidityUsd: m.liquidityUsd ?? null,
        timestamp: now,
      })),
    });
  } else if (primary?.impliedProb != null) {
    await prisma.marketSnapshot.create({
      data: {
        marketId: row.id,
        outcomeName: primary.name,
        impliedProb: primary.impliedProb,
        volumeUsd: m.volumeUsd ?? null,
        liquidityUsd: m.liquidityUsd ?? null,
        timestamp: new Date(),
      },
    });
  }
  return row;
}

/** Find a market row id, creating a minimal placeholder if discovery lagged. */
export async function ensureMarketId(
  platform: Platform,
  externalId: string,
  title?: string,
): Promise<string> {
  const existing = await prisma.market.findUnique({
    where: { platform_externalId: { platform, externalId } },
    select: { id: true },
  });
  if (existing) return existing.id;
  // Atomic insert-if-absent: createMany + skipDuplicates → `ON CONFLICT DO
  // NOTHING`, so a concurrent insert is a silent no-op (no unique-violation
  // raised or logged). Then read the row (ours or the race winner's).
  await prisma.market.createMany({
    data: [
      {
        platform,
        externalId,
        title: title ?? externalId,
        eventType: eventTypeEnum(classifyEventType(title ?? '')),
        status: 'unknown',
      },
    ],
    skipDuplicates: true,
  });
  const row = await prisma.market.findUnique({
    where: { platform_externalId: { platform, externalId } },
    select: { id: true },
  });
  if (!row) throw new Error(`ensureMarketId: ${platform}:${externalId} missing after upsert`);
  return row.id;
}

export async function upsertWallet(
  platform: Platform,
  address: string,
): Promise<{ id: string }> {
  return prisma.wallet.upsert({
    where: { platform_address: { platform, address } },
    create: { platform, address, lastSeen: new Date() },
    update: { lastSeen: new Date() },
    select: { id: true },
  });
}

export interface PersistedTrade {
  id: string;
  marketId: string;
  walletId: string | null;
  isNew: boolean;
}

export async function persistTrade(t: NormalizedTrade): Promise<PersistedTrade> {
  const marketId = await ensureMarketId(t.platform, t.marketExternalId);
  const wallet = t.wallet ? await upsertWallet(t.platform, t.wallet) : null;

  // Atomic, race-free idempotency on (platform, externalId): createMany +
  // skipDuplicates → `ON CONFLICT DO NOTHING`. `count === 1` means we inserted a
  // genuinely new trade (run detection once); `count === 0` means it already
  // existed (concurrent worker won) — no detection, no constraint-violation log.
  const inserted = await prisma.trade.createMany({
    data: [
      {
        platform: t.platform,
        externalId: t.externalId,
        marketId,
        outcomeName: t.outcomeName ?? null,
        walletId: wallet?.id ?? null,
        walletAddress: t.wallet ?? null,
        side: t.side,
        price: t.price,
        size: t.size,
        sizeUsd: t.sizeUsd,
        timestamp: t.timestamp,
        raw: (t.raw ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    ],
    skipDuplicates: true,
  });
  const row = await prisma.trade.findUnique({
    where: { platform_externalId: { platform: t.platform, externalId: t.externalId } },
    select: { id: true },
  });
  if (!row) throw new Error(`persistTrade: ${t.platform}:${t.externalId} missing after upsert`);
  return { id: row.id, marketId, walletId: wallet?.id ?? null, isNew: inserted.count === 1 };
}

export async function persistOrderBook(b: NormalizedOrderBook): Promise<string> {
  const marketId = await ensureMarketId(b.platform, b.marketExternalId);
  await prisma.orderBook.create({
    data: {
      platform: b.platform,
      marketId,
      outcomeName: b.outcomeName ?? null,
      bestBid: b.bestBid,
      bestAsk: b.bestAsk,
      spread: b.spread,
      bidDepthUsd: b.bidDepthUsd,
      askDepthUsd: b.askDepthUsd,
      liquidityUsd: b.liquidityUsd,
      timestamp: b.timestamp,
    },
  });
  // Mid-price snapshot drives steam detection.
  const mid =
    b.bestBid != null && b.bestAsk != null ? (b.bestBid + b.bestAsk) / 2 : (b.bestAsk ?? b.bestBid);
  if (mid != null) {
    await prisma.marketSnapshot.create({
      data: {
        marketId,
        outcomeName: b.outcomeName ?? null,
        impliedProb: mid,
        liquidityUsd: b.liquidityUsd,
        timestamp: b.timestamp,
      },
    });
  }
  return marketId;
}
