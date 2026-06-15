import { config, logger, PLAY_MONEY_PLATFORMS, quant, type Platform } from '@whale/core';
import { prisma } from '@whale/db';
import { emitAlert } from './alerts.js';

const log = logger.child({ svc: 'engine', mod: 'arbitrage' });

/** Per-leg taker fee assumptions used when netting arbitrage edge. */
const FEE_BY_PLATFORM: Partial<Record<Platform, number>> = {
  polymarket: 0.0,
  kalshi: 0.0,
  manifold: 0.0,
  pinnacle: 0.02,
  draftkings: 0.05,
  fanduel: 0.05,
  betfair: 0.02,
};

interface OutcomeQuote {
  platform: Platform;
  marketExternalId: string;
  prob: number;
}

/**
 * Cross-platform arbitrage / mispricing scan. Markets are linked by
 * `canonicalKey`. For each linked group we take the latest implied probability
 * per (platform, outcome), then:
 *   • multi-way arb — back each outcome at its cheapest venue; if Σ bestProb
 *     (net fees) < 1 by ≥ ARB_MIN_EDGE, it's a riskless edge.
 *   • mispricing — flag outcomes whose cross-venue prob spread is large.
 */
export async function scanArbitrage(): Promise<number> {
  const now = new Date();
  const markets = await prisma.market.findMany({
    where: {
      canonicalKey: { not: null },
      status: 'open',
      // Exclude markets that have already closed/resolved (e.g. concluded matches).
      OR: [{ closeTime: null }, { closeTime: { gt: now } }],
    },
    select: {
      id: true,
      platform: true,
      externalId: true,
      canonicalKey: true,
      startTime: true,
    },
  });

  // Group markets by canonical key.
  const byKey = new Map<string, typeof markets>();
  for (const m of markets) {
    const arr = byKey.get(m.canonicalKey!) ?? [];
    arr.push(m);
    byKey.set(m.canonicalKey!, arr);
  }

  let opportunities = 0;
  for (const [canonicalKey, group] of byKey) {
    // Skip catch-all keys that collapse unrelated markets into one bucket.
    if (canonicalKey.includes(':other')) continue;
    // Skip matches that have already kicked off — their odds are stale, not arbs.
    if (canonicalKey.includes(':match:') && group.some((m) => m.startTime && m.startTime < now)) {
      continue;
    }

    // Only real-money venues are arbitrageable; play money (Manifold) is signal-only.
    const realGroup = group.filter((m) => !PLAY_MONEY_PLATFORMS.includes(m.platform));
    const platforms = new Set(realGroup.map((m) => m.platform));
    if (platforms.size < 2) continue; // need ≥2 DISTINCT real-money venues

    // outcome → best quote PER PLATFORM. Deduping by platform stops the
    // "manifold vs manifold vs manifold" nonsense where many distinct markets
    // on one venue shared a canonical key.
    const outcomeQuotes = new Map<string, Map<Platform, OutcomeQuote>>();
    for (const m of realGroup) {
      const latest = await latestProbsForMarket(m.id);
      for (const [outcome, prob] of latest) {
        const norm = normalizeOutcome(outcome);
        const perPlatform = outcomeQuotes.get(norm) ?? new Map<Platform, OutcomeQuote>();
        const existing = perPlatform.get(m.platform);
        if (!existing || prob < existing.prob) {
          perPlatform.set(m.platform, { platform: m.platform, marketExternalId: m.externalId, prob });
        }
        outcomeQuotes.set(norm, perPlatform);
      }
    }

    // Best (lowest) prob per outcome = best odds; build the synthetic book.
    const legs: Array<{ platform: Platform; marketExternalId: string; impliedProb: number; bestPrice: number; outcome: string }> = [];
    const bestProbs: number[] = [];
    let multiVenueOutcomes = 0;
    for (const [outcome, perPlatform] of outcomeQuotes) {
      const quotes = [...perPlatform.values()];
      if (quotes.length < 2) continue; // ≥2 DISTINCT platforms quoting this outcome
      multiVenueOutcomes++;
      const best = quotes.reduce((a, b) => (b.prob < a.prob ? b : a));
      const fee = FEE_BY_PLATFORM[best.platform] ?? 0.02;
      bestProbs.push(best.prob * (1 + fee));
      legs.push({ ...best, impliedProb: best.prob, bestPrice: best.prob, outcome });

      // Mispricing: large spread on the same outcome across distinct venues.
      const spread = Math.max(...quotes.map((q) => q.prob)) - Math.min(...quotes.map((q) => q.prob));
      if (spread >= config.ARB_MIN_EDGE * 2) {
        await recordMispricing(canonicalKey, outcome, quotes, spread);
        opportunities++;
      }
    }

    if (multiVenueOutcomes < 2) continue; // need a (near) complete book for true arb
    const bookSum = quant.bookSum(bestProbs);
    const edge = 1 - bookSum;
    if (edge < config.ARB_MIN_EDGE) continue;

    await prisma.arbitrageEvent.create({
      data: { canonicalKey, outcomeName: 'ALL', edge, bookSum, legs },
    });
    await emitAlert({
      type: 'arbitrage',
      severity: edge >= 2 * config.ARB_MIN_EDGE ? 'high' : 'medium',
      platform: legs[0]!.platform,
      title: 'Cross-Platform Arbitrage',
      body: [
        `Market: ${canonicalKey}`,
        `Book sum: ${(bookSum * 100).toFixed(1)}%  (edge ${(edge * 100).toFixed(1)}%)`,
        ...legs.map((l) => `  • ${l.outcome}: back on ${l.platform} @ ${(l.impliedProb * 100).toFixed(1)}%`),
      ].join('\n'),
      data: { canonicalKey, edge, bookSum, legs },
      dedupeKey: `arb:${canonicalKey}:${Math.floor(Date.now() / 300_000)}`,
      createdAt: new Date(),
    });
    opportunities++;
  }

  if (opportunities) log.info({ opportunities }, 'arbitrage scan complete');
  return opportunities;
}

async function recordMispricing(
  canonicalKey: string,
  outcome: string,
  quotes: OutcomeQuote[],
  spread: number,
): Promise<void> {
  await emitAlert({
    type: 'arbitrage',
    severity: 'low',
    platform: quotes[0]!.platform,
    title: 'Cross-Platform Mispricing',
    body: [
      `Market: ${canonicalKey} — ${outcome}`,
      `Spread: ${(spread * 100).toFixed(1)}%`,
      ...quotes.map((q) => `  • ${q.platform}: ${(q.prob * 100).toFixed(1)}%`),
    ].join('\n'),
    data: { canonicalKey, outcome, spread, quotes },
    dedupeKey: `mispx:${canonicalKey}:${outcome}:${Math.floor(Date.now() / 600_000)}`,
    createdAt: new Date(),
  });
}

/** Latest implied prob per outcome for a market from recent snapshots. */
async function latestProbsForMarket(marketId: string): Promise<Map<string, number>> {
  const snaps = await prisma.marketSnapshot.findMany({
    where: { marketId },
    orderBy: { timestamp: 'desc' },
    take: 50,
    select: { outcomeName: true, impliedProb: true },
  });
  const out = new Map<string, number>();
  for (const s of snaps) {
    const name = s.outcomeName ?? '_';
    if (out.has(name) || s.impliedProb == null) continue; // first seen = latest
    out.set(name, Number(s.impliedProb));
  }
  return out;
}

/** Canonicalize outcome labels so "Yes"/"YES" and team names line up across venues. */
function normalizeOutcome(name: string): string {
  return name.trim().toLowerCase();
}
