/**
 * Pure quantitative helpers. No I/O, fully unit-tested. Everything here is
 * deterministic so the scoring/detection engines stay reproducible.
 */

export interface ResolvedPosition {
  /** USD staked when the position was opened. */
  stakeUsd: number;
  /** Realized profit/loss in USD (negative for losses). */
  pnlUsd: number;
}

/** Total return on invested capital. roi = pnl / staked. */
export function roi(positions: ResolvedPosition[]): number {
  const staked = sum(positions.map((p) => p.stakeUsd));
  if (staked <= 0) return 0;
  return sum(positions.map((p) => p.pnlUsd)) / staked;
}

/** Fraction of resolved positions that were profitable. */
export function winRate(positions: ResolvedPosition[]): number {
  if (positions.length === 0) return 0;
  return positions.filter((p) => p.pnlUsd > 0).length / positions.length;
}

export function avgPosition(positions: ResolvedPosition[]): number {
  if (positions.length === 0) return 0;
  return sum(positions.map((p) => p.stakeUsd)) / positions.length;
}

/**
 * Expected value per $1 staked, estimated empirically from realized returns.
 * Equivalent to the mean per-unit return across resolved positions.
 */
export function expectedValue(positions: ResolvedPosition[]): number {
  if (positions.length === 0) return 0;
  return mean(positions.map((p) => (p.stakeUsd > 0 ? p.pnlUsd / p.stakeUsd : 0)));
}

/**
 * Sharpe ratio of per-unit returns. `riskFree` is per-period (default 0 — bet
 * returns are typically measured in excess terms already). Returns 0 when there
 * is no dispersion or too few samples to be meaningful.
 */
export function sharpe(positions: ResolvedPosition[], riskFree = 0): number {
  if (positions.length < 2) return 0;
  const returns = positions.map((p) => (p.stakeUsd > 0 ? p.pnlUsd / p.stakeUsd : 0));
  const excess = returns.map((r) => r - riskFree);
  const m = mean(excess);
  const sd = stddev(excess);
  if (sd === 0) return 0;
  return m / sd;
}

/**
 * Market-impact percentage: signed relative change in implied probability
 * caused by a trade. before/after are probabilities in (0,1].
 * Positive = price moved up after the trade.
 */
export function marketImpactPct(beforeProb: number, afterProb: number): number {
  if (beforeProb <= 0) return 0;
  return (afterProb - beforeProb) / beforeProb;
}

/**
 * Kelly fraction for a binary bet given the bettor's edge. `prob` is the
 * estimated true win probability, `price` the implied probability paid.
 * Returns the fraction of bankroll; clamped to [0,1].
 */
export function kellyFraction(prob: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  // Decimal odds b = (1/price) - 1 net; payoff multiple per unit staked.
  const b = (1 - price) / price;
  const q = 1 - prob;
  const f = (b * prob - q) / b;
  return clamp(f, 0, 1);
}

/* ── Odds conversions ─────────────────────────────────────────────────────── */

/** American moneyline → implied probability (no vig removal). */
export function americanToProb(american: number): number {
  if (american === 0) return 0;
  return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
}

/** Decimal odds → implied probability. */
export function decimalToProb(decimal: number): number {
  return decimal > 0 ? 1 / decimal : 0;
}

/** Probability → decimal odds. */
export function probToDecimal(prob: number): number {
  return prob > 0 ? 1 / prob : Infinity;
}

/* ── Arbitrage ────────────────────────────────────────────────────────────── */

/**
 * Book sum across the best price for each mutually-exclusive outcome.
 * < 1 implies a riskless arbitrage (before fees) on a complete book.
 */
export function bookSum(bestProbs: number[]): number {
  return sum(bestProbs.filter((p) => p > 0));
}

/**
 * Arbitrage edge = 1 - bookSum, net of a per-leg fee. Positive means profit.
 * `feePerLeg` is a fractional taker fee applied to each leg's stake.
 */
export function arbitrageEdge(bestProbs: number[], feePerLeg = 0): number {
  const adjusted = bestProbs.map((p) => p * (1 + feePerLeg));
  return 1 - bookSum(adjusted);
}

/* ── Normalization helpers ──────────────────────────────────────────────────── */

/** Map an arbitrary positive value to [0,1] via a saturating curve at `ref`. */
export function saturating(value: number, ref: number): number {
  if (ref <= 0) return 0;
  return clamp(1 - Math.exp(-value / ref), 0, 1);
}

/** Map a signed/zero-centered value to [0,1] via logistic with scale `k`. */
export function logistic01(value: number, k = 1): number {
  return 1 / (1 + Math.exp(-value / k));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : 0;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Robust z-score using median + MAD; resistant to fat tails in volume data. */
export function robustZ(value: number, samples: number[]): number {
  if (samples.length === 0) return 0;
  const med = median(samples);
  const mad = median(samples.map((x) => Math.abs(x - med))) || 1e-9;
  return (value - med) / (1.4826 * mad);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
