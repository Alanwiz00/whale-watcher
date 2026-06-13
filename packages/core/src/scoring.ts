import { WHALE_TIERS, type WhaleTier } from './constants.js';
import { clamp, logistic01, saturating } from './quant.js';
import type { WhaleScoreComponents } from './types.js';

/**
 * Whale Score — a 0–100 composite of four weighted, normalized components:
 *
 *   score = 100 * ( w_size * sizeScore
 *                 + w_roi  * roiScore
 *                 + w_imp  * impactScore
 *                 + w_time * timingScore )
 *
 * Each sub-score is normalized to [0,1] so weights are interpretable. Defaults
 * favor position size and historical ROI, the two strongest "smart money"
 * signals, while still rewarding measurable market impact and well-timed entries.
 */
export const DEFAULT_WEIGHTS = {
  positionSize: 0.35,
  historicalRoi: 0.3,
  marketImpact: 0.2,
  timing: 0.15,
} as const;

export interface WhaleScoreInput {
  /** Notional position size in USD. */
  sizeUsd: number;
  /** Reference size at which the size sub-score saturates (~0.63 at ref). */
  sizeRefUsd?: number;
  /** Historical ROI of the wallet (e.g. 0.38 = +38%). Null when unknown. */
  walletRoi?: number | null;
  /** Wallet win rate in [0,1]. Null when unknown. */
  walletWinRate?: number | null;
  /** Number of resolved positions backing the ROI estimate (confidence). */
  walletSampleSize?: number;
  /** Signed market-impact fraction caused by the trade (e.g. 0.048 = +4.8%). */
  marketImpactPct?: number | null;
  /**
   * Timing quality in [0,1]: how early/contrarian the entry is relative to the
   * eventual consensus move. 0.5 is neutral when unknown.
   */
  timing?: number | null;
  weights?: Partial<Record<keyof typeof DEFAULT_WEIGHTS, number>>;
}

export interface WhaleScoreResult {
  score: number;
  tier: WhaleTier;
  components: WhaleScoreComponents;
}

function sizeScore(sizeUsd: number, refUsd: number): number {
  return saturating(Math.max(0, sizeUsd), refUsd);
}

/**
 * ROI sub-score: logistic around 0 ROI, scaled so +30% ROI ≈ 0.82. Shrunk
 * toward neutral (0.5) when sample size is small to avoid rewarding noise.
 */
function roiScore(walletRoi: number | null | undefined, sampleSize: number): number {
  if (walletRoi == null) return 0.5;
  const raw = logistic01(walletRoi, 0.2);
  const confidence = clamp(sampleSize / 20, 0, 1);
  return 0.5 + (raw - 0.5) * confidence;
}

/** Impact sub-score from |move|; saturates around a 10% move. */
function impactScore(impactPct: number | null | undefined): number {
  if (impactPct == null) return 0;
  return saturating(Math.abs(impactPct), 0.1);
}

function timingScore(timing: number | null | undefined): number {
  if (timing == null) return 0.5;
  return clamp(timing, 0, 1);
}

export function classifyTier(score: number): WhaleTier {
  return (WHALE_TIERS.find((t) => score >= t.min) ?? WHALE_TIERS[WHALE_TIERS.length - 1]!).label;
}

export function computeWhaleScore(input: WhaleScoreInput): WhaleScoreResult {
  const w = { ...DEFAULT_WEIGHTS, ...input.weights };
  const wsum = w.positionSize + w.historicalRoi + w.marketImpact + w.timing || 1;

  const components: WhaleScoreComponents = {
    positionSize: sizeScore(input.sizeUsd, input.sizeRefUsd ?? 500_000),
    historicalRoi: roiScore(input.walletRoi, input.walletSampleSize ?? 0),
    marketImpact: impactScore(input.marketImpactPct),
    timing: timingScore(input.timing),
  };

  const weighted =
    (w.positionSize * components.positionSize +
      w.historicalRoi * components.historicalRoi +
      w.marketImpact * components.marketImpact +
      w.timing * components.timing) /
    wsum;

  const score = Math.round(clamp(weighted, 0, 1) * 100);
  return { score, tier: classifyTier(score), components };
}
