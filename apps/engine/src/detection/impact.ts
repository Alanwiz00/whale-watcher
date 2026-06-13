import { quant } from '@whale/core';
import { prisma } from '@whale/db';

/**
 * Market-impact estimate: signed relative change in implied probability around
 * a trade. Uses the last snapshot strictly before `at` as the baseline and the
 * first snapshot after `at` as the post-trade level. When no post-trade snapshot
 * exists yet, falls back to the trade's executed price vs the baseline — a
 * conservative immediate proxy.
 *
 * Returns `{ pct, before, after }` or null when there's no baseline.
 */
export async function measureImpact(
  marketId: string,
  outcomeName: string | null,
  at: Date,
  executedPrice?: number,
  windowMs = 120_000,
): Promise<{ pct: number; before: number; after: number } | null> {
  const outcomeFilter = outcomeName ? { OR: [{ outcomeName }, { outcomeName: null }] } : {};

  const before = await prisma.marketSnapshot.findFirst({
    where: { marketId, timestamp: { lt: at }, ...outcomeFilter },
    orderBy: { timestamp: 'desc' },
    select: { impliedProb: true },
  });
  if (before?.impliedProb == null) return null;
  const beforeProb = Number(before.impliedProb);

  const after = await prisma.marketSnapshot.findFirst({
    where: {
      marketId,
      timestamp: { gt: at, lte: new Date(at.getTime() + windowMs) },
      ...outcomeFilter,
    },
    orderBy: { timestamp: 'asc' },
    select: { impliedProb: true },
  });

  const afterProb = after?.impliedProb != null ? Number(after.impliedProb) : (executedPrice ?? beforeProb);
  return { pct: quant.marketImpactPct(beforeProb, afterProb), before: beforeProb, after: afterProb };
}
