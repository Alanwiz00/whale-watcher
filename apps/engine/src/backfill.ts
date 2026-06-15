/**
 * One-time backfill: run whale detection over trades that already exist in the
 * DB and qualify under the *current* WHALE_THRESHOLD_USD but never had a signal
 * (e.g. ingested before the threshold was lowered, since live detection only
 * runs at ingestion time). Idempotent — re-running skips trades that already
 * have a WhaleSignal.
 *
 *   pnpm --filter @whale/engine backfill
 */
import { config, logger, type NormalizedTrade } from '@whale/core';
import { prisma } from '@whale/db';
import { detectWhale } from './detection/whale.js';

const log = logger.child({ svc: 'engine', mod: 'backfill' });

async function main(): Promise<void> {
  const trades = await prisma.trade.findMany({
    where: { sizeUsd: { gte: config.WHALE_THRESHOLD_USD }, whaleSignal: { is: null } },
    include: { market: { select: { externalId: true } } },
    orderBy: { timestamp: 'desc' },
    take: 10_000,
  });
  log.info(
    { count: trades.length, thresholdUsd: config.WHALE_THRESHOLD_USD },
    'backfilling whale detection over historical trades',
  );

  let processed = 0;
  for (const t of trades) {
    const trade: NormalizedTrade = {
      platform: t.platform,
      externalId: t.externalId,
      marketExternalId: t.market.externalId,
      outcomeName: t.outcomeName,
      wallet: t.walletAddress,
      side: t.side,
      price: Number(t.price),
      size: Number(t.size),
      sizeUsd: Number(t.sizeUsd),
      timestamp: t.timestamp,
    };
    await detectWhale(trade, {
      id: t.id,
      marketId: t.marketId,
      walletId: t.walletId,
      isNew: true,
    });
    processed++;
  }

  log.info({ processed }, 'backfill complete');
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  log.error({ err: String(err) }, 'backfill failed');
  process.exit(1);
});
