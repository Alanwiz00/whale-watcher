import { WHALE_TIERS, type WhaleTier } from './constants.js';
import { clamp, logistic01, saturating } from './quant.js';
import type { WhaleScoreComponents } from './types.js';

/**
 * Whale Score — 0–100, **anchored to the configured whale threshold** so that
 * any trade large enough to be a whale is always meaningful (≥ Notable), and
 * the score scales with how far above the threshold it is:
 *
 *   sizePts = clamp(50 + 25·log2(sizeUsd / thresholdUsd), 50, 85)
 *     • exactly at threshold → 50  (Notable / medium)
 *     • 2× threshold        → 75  (Strong / high)
 *     • ~2.8× and beyond    → 85  (size cap)
 *
 * Smart-money signals are *bonuses* added on top — they can lift a big trade to
 * Elite but never drag a genuine whale below its size anchor:
 *
 *   score = sizePts + roiBonus(≤10) + impactBonus(≤7) + timingBonus(≤5)   (cap 100)
 *
 * Net effect: crossing WHALE_THRESHOLD_USD is always "effective" (broadcasts),
 * and only large + sharp + impactful + well-timed trades reach Elite (≥90).
 */

/** Size anchor parameters. */
const SIZE_BASE = 50; // points at exactly the threshold → medium
const SIZE_SLOPE = 25; // points added per doubling above the threshold
const SIZE_CAP = 85; // max points from size alone (leaves room for bonuses)

/** Maximum bonus points per smart-money signal. */
const ROI_BONUS = 10;
const IMPACT_BONUS = 7;
const TIMING_BONUS = 5;

export interface WhaleScoreInput {
  /** Notional position size in USD. */
  sizeUsd: number;
  /** Configured whale threshold (USD). The score is anchored to this. */
  thresholdUsd: number;
  /** Historical ROI of the wallet (e.g. 0.38 = +38%). Null when unknown. */
  walletRoi?: number | null;
  /** Wallet win rate in [0,1]. Null when unknown. */
  walletWinRate?: number | null;
  /** Number of resolved positions backing the ROI estimate (confidence). */
  walletSampleSize?: number;
  /** Signed market-impact fraction caused by the trade (e.g. 0.048 = +4.8%). */
  marketImpactPct?: number | null;
  /** Timing quality in [0,1]; 0.5 is neutral when unknown. */
  timing?: number | null;
}

export interface WhaleScoreResult {
  score: number;
  tier: WhaleTier;
  components: WhaleScoreComponents;
}

/** Size points anchored to the threshold: threshold→50, scales by log2, capped. */
function sizePoints(sizeUsd: number, thresholdUsd: number): number {
  const threshold = thresholdUsd > 0 ? thresholdUsd : 1;
  const mult = Math.max(1, sizeUsd / threshold);
  return clamp(SIZE_BASE + SIZE_SLOPE * Math.log2(mult), SIZE_BASE, SIZE_CAP);
}

/**
 * ROI sub-score in [0,1]: logistic around 0 ROI, scaled so +30% ROI ≈ 0.82.
 * Shrunk toward neutral (0.5) when the resolved-position sample is small.
 */
function roiScore(walletRoi: number | null | undefined, sampleSize: number): number {
  if (walletRoi == null) return 0.5;
  const raw = logistic01(walletRoi, 0.2);
  const confidence = clamp(sampleSize / 20, 0, 1);
  return 0.5 + (raw - 0.5) * confidence;
}

/** Impact sub-score in [0,1] from |move|; saturates around a 10% move. */
function impactScore(impactPct: number | null | undefined): number {
  if (impactPct == null) return 0;
  return saturating(Math.abs(impactPct), 0.1);
}

/** Timing sub-score in [0,1]; 0.5 neutral when unknown. */
function timingScore(timing: number | null | undefined): number {
  if (timing == null) return 0.5;
  return clamp(timing, 0, 1);
}

export function classifyTier(score: number): WhaleTier {
  return (WHALE_TIERS.find((t) => score >= t.min) ?? WHALE_TIERS[WHALE_TIERS.length - 1]!).label;
}

export function computeWhaleScore(input: WhaleScoreInput): WhaleScoreResult {
  const sizePts = sizePoints(input.sizeUsd, input.thresholdUsd);

  const roiNorm = roiScore(input.walletRoi, input.walletSampleSize ?? 0);
  const impactNorm = impactScore(input.marketImpactPct);
  const timingNorm = timingScore(input.timing);

  // Bonuses only add (clamped ≥ 0) so a real whale never scores below its anchor.
  const roiPts = clamp((roiNorm - 0.5) * 2, 0, 1) * ROI_BONUS;
  const impactPts = impactNorm * IMPACT_BONUS;
  const timingPts = clamp((timingNorm - 0.5) * 2, 0, 1) * TIMING_BONUS;

  const score = Math.round(clamp(sizePts + roiPts + impactPts + timingPts, 0, 100));

  const components: WhaleScoreComponents = {
    positionSize: sizePts / 100,
    historicalRoi: roiNorm,
    marketImpact: impactNorm,
    timing: timingNorm,
  };
  return { score, tier: classifyTier(score), components };
}
