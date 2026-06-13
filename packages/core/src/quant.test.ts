import { describe, expect, it } from 'vitest';
import * as q from './quant.js';

describe('roi / winRate / avgPosition', () => {
  const positions = [
    { stakeUsd: 100, pnlUsd: 50 },
    { stakeUsd: 100, pnlUsd: -100 },
    { stakeUsd: 200, pnlUsd: 100 },
  ];

  it('computes ROI as total pnl / total staked', () => {
    expect(q.roi(positions)).toBeCloseTo(50 / 400, 6);
  });

  it('returns 0 ROI with no stake', () => {
    expect(q.roi([])).toBe(0);
    expect(q.roi([{ stakeUsd: 0, pnlUsd: 10 }])).toBe(0);
  });

  it('computes win rate', () => {
    expect(q.winRate(positions)).toBeCloseTo(2 / 3, 6);
  });

  it('computes average position', () => {
    expect(q.avgPosition(positions)).toBeCloseTo(400 / 3, 6);
  });
});

describe('expectedValue & sharpe', () => {
  it('EV is the mean per-unit return', () => {
    const ev = q.expectedValue([
      { stakeUsd: 100, pnlUsd: 20 }, // +0.2
      { stakeUsd: 100, pnlUsd: -10 }, // -0.1
    ]);
    expect(ev).toBeCloseTo(0.05, 6);
  });

  it('sharpe is 0 with <2 samples or zero dispersion', () => {
    expect(q.sharpe([{ stakeUsd: 1, pnlUsd: 1 }])).toBe(0);
    expect(
      q.sharpe([
        { stakeUsd: 100, pnlUsd: 10 },
        { stakeUsd: 100, pnlUsd: 10 },
      ]),
    ).toBe(0);
  });

  it('sharpe is positive for consistently profitable returns', () => {
    const s = q.sharpe([
      { stakeUsd: 100, pnlUsd: 30 },
      { stakeUsd: 100, pnlUsd: 10 },
      { stakeUsd: 100, pnlUsd: 20 },
    ]);
    expect(s).toBeGreaterThan(0);
  });
});

describe('market impact & kelly', () => {
  it('impact is the signed relative move', () => {
    expect(q.marketImpactPct(0.5, 0.55)).toBeCloseTo(0.1, 6);
    expect(q.marketImpactPct(0.5, 0.45)).toBeCloseTo(-0.1, 6);
    expect(q.marketImpactPct(0, 0.5)).toBe(0);
  });

  it('kelly is 0 with no edge and positive with edge', () => {
    expect(q.kellyFraction(0.5, 0.5)).toBeCloseTo(0, 6);
    expect(q.kellyFraction(0.6, 0.5)).toBeGreaterThan(0);
    expect(q.kellyFraction(0.4, 0.5)).toBe(0); // negative edge clamped
  });
});

describe('odds conversions', () => {
  it('american → prob', () => {
    expect(q.americanToProb(100)).toBeCloseTo(0.5, 6);
    expect(q.americanToProb(-200)).toBeCloseTo(2 / 3, 6);
    expect(q.americanToProb(200)).toBeCloseTo(1 / 3, 6);
  });
  it('decimal ↔ prob', () => {
    expect(q.decimalToProb(2)).toBeCloseTo(0.5, 6);
    expect(q.probToDecimal(0.25)).toBeCloseTo(4, 6);
  });
});

describe('arbitrage', () => {
  it('bookSum sums positive probabilities', () => {
    expect(q.bookSum([0.5, 0.45, 0])).toBeCloseTo(0.95, 6);
  });
  it('edge is positive when book sums below 1', () => {
    expect(q.arbitrageEdge([0.48, 0.48])).toBeCloseTo(0.04, 6);
  });
  it('fees erode edge', () => {
    expect(q.arbitrageEdge([0.48, 0.48], 0.05)).toBeLessThan(0.04);
  });
});

describe('normalization + robust stats', () => {
  it('saturating maps to [0,1] and grows with value', () => {
    expect(q.saturating(0, 100)).toBe(0);
    expect(q.saturating(100, 100)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(q.saturating(1e9, 100)).toBeLessThanOrEqual(1);
  });
  it('logistic01 is 0.5 at 0 and monotonic', () => {
    expect(q.logistic01(0)).toBeCloseTo(0.5, 6);
    expect(q.logistic01(5)).toBeGreaterThan(q.logistic01(-5));
  });
  it('median handles even/odd lengths', () => {
    expect(q.median([3, 1, 2])).toBe(2);
    expect(q.median([1, 2, 3, 4])).toBe(2.5);
  });
  it('robustZ flags outliers', () => {
    const sample = [10, 11, 9, 10, 12, 11, 10];
    expect(q.robustZ(100, sample)).toBeGreaterThan(5);
    expect(Math.abs(q.robustZ(10, sample))).toBeLessThan(1);
  });
});
