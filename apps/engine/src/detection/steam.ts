import { config, logger, PLAY_MONEY_PLATFORMS, type Platform } from '@whale/core';
import { prisma } from '@whale/db';
import { emitAlert } from '../alerts.js';

const log = logger.child({ svc: 'engine', mod: 'steam' });

/**
 * Steam move: a sharp odds shift (≥ STEAM_MOVE_PCT over STEAM_WINDOW_MS) with no
 * single qualifying whale trade to explain it — the fingerprint of distributed
 * sharp/syndicate action. We compare the current implied prob to the level at
 * the start of the window and, if it moved enough, check whether any whale-sized
 * trade occurred in that window. None → flag it.
 */
export async function detectSteam(
  marketId: string,
  platform: Platform,
  outcomeName: string | null,
  currentProb: number,
  at: Date,
  liquidityUsd?: number | null,
): Promise<void> {
  // Play-money venues don't produce tradeable steam; skip them.
  if (PLAY_MONEY_PLATFORMS.includes(platform)) return;
  // Require *known* real liquidity — unknown/thin order books are skipped, not
  // given the benefit of the doubt (that's where the noise comes from).
  if ((liquidityUsd ?? 0) < config.STEAM_MIN_LIQUIDITY_USD) return;

  const windowStart = new Date(at.getTime() - config.STEAM_WINDOW_MS);
  const outcomeFilter = outcomeName ? { OR: [{ outcomeName }, { outcomeName: null }] } : {};

  const past = await prisma.marketSnapshot.findFirst({
    where: { marketId, timestamp: { gte: windowStart, lt: at }, ...outcomeFilter },
    orderBy: { timestamp: 'asc' },
    select: { impliedProb: true, timestamp: true },
  });
  if (past?.impliedProb == null) return;
  const fromProb = Number(past.impliedProb);
  if (fromProb <= 0) return;

  const movePct = (currentProb - fromProb) / fromProb;
  if (Math.abs(movePct) < config.STEAM_MOVE_PCT) return;
  // Absolute-move floor: kills long-shot noise where a 0.1%→0.2% tick reads as
  // a +100% relative move. Require a real shift in probability *points* too.
  if (Math.abs(currentProb - fromProb) < config.STEAM_MIN_ABS_MOVE) return;

  // Is there a whale trade that explains the move?
  const whaleTrade = await prisma.trade.findFirst({
    where: { marketId, timestamp: { gte: windowStart, lte: at }, sizeUsd: { gte: config.WHALE_THRESHOLD_USD } },
    select: { id: true },
  });
  const noVisibleWhale = !whaleTrade;

  await prisma.steamMove.create({
    data: {
      platform,
      marketId,
      outcomeName,
      fromProb,
      toProb: currentProb,
      movePct,
      windowMs: config.STEAM_WINDOW_MS,
      noVisibleWhale,
    },
  });

  if (!noVisibleWhale) return; // explained by a visible whale; logged but not alerted as steam

  const market = await prisma.market.findUnique({ where: { id: marketId }, select: { title: true } });
  const bucket = Math.floor(at.getTime() / config.STEAM_WINDOW_MS);
  await emitAlert(
    {
      type: 'steam_move',
      severity: Math.abs(movePct) >= 2 * config.STEAM_MOVE_PCT ? 'high' : 'medium',
      platform,
      title: 'Steam Move Detected',
      body: [
        `Platform: ${platform}`,
        `Market: ${market?.title ?? marketId}`,
        `Move: ${(fromProb * 100).toFixed(1)}% → ${(currentProb * 100).toFixed(1)}% (${(movePct * 100).toFixed(1)}%)`,
        `Window: ${Math.round(config.STEAM_WINDOW_MS / 60000)} min`,
        `No visible whale trade — possible sharp syndicate activity`,
      ].join('\n'),
      data: { fromProb, toProb: currentProb, movePct, outcome: outcomeName, marketTitle: market?.title },
      dedupeKey: `steam:${platform}:${marketId}:${outcomeName ?? '_'}:${bucket}`,
      createdAt: new Date(),
    },
    { marketId },
  );

  log.info({ marketId, movePct }, 'steam move flagged');
}
