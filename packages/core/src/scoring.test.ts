import { describe, expect, it } from 'vitest';
import { classifyTier, computeWhaleScore } from './scoring.js';

describe('classifyTier', () => {
  it('maps scores to tiers', () => {
    expect(classifyTier(95)).toBe('Elite Whale');
    expect(classifyTier(80)).toBe('Strong Whale');
    expect(classifyTier(60)).toBe('Notable Whale');
    expect(classifyTier(20)).toBe('Normal');
  });
});

describe('computeWhaleScore', () => {
  it('returns a 0–100 score with components', () => {
    const r = computeWhaleScore({ sizeUsd: 300_000 });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.components.positionSize).toBeGreaterThan(0);
  });

  it('is monotonic in position size', () => {
    const small = computeWhaleScore({ sizeUsd: 300_000 }).score;
    const big = computeWhaleScore({ sizeUsd: 5_000_000 }).score;
    expect(big).toBeGreaterThan(small);
  });

  it('rewards strong historical ROI (with enough samples)', () => {
    const base = { sizeUsd: 500_000, marketImpactPct: 0.05 };
    const sharp = computeWhaleScore({ ...base, walletRoi: 0.6, walletSampleSize: 50 }).score;
    const dumb = computeWhaleScore({ ...base, walletRoi: -0.4, walletSampleSize: 50 }).score;
    expect(sharp).toBeGreaterThan(dumb);
  });

  it('shrinks ROI influence when sample size is tiny', () => {
    const base = { sizeUsd: 500_000 };
    const lowN = computeWhaleScore({ ...base, walletRoi: 1.0, walletSampleSize: 1 }).components.historicalRoi;
    const highN = computeWhaleScore({ ...base, walletRoi: 1.0, walletSampleSize: 50 }).components.historicalRoi;
    expect(highN).toBeGreaterThan(lowN);
    expect(lowN).toBeCloseTo(0.5, 1); // ~neutral with no evidence
  });

  it('an elite profile clears the 90 threshold', () => {
    const r = computeWhaleScore({
      sizeUsd: 8_000_000,
      walletRoi: 0.8,
      walletSampleSize: 100,
      marketImpactPct: 0.15,
      timing: 0.95,
    });
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.tier).toBe('Elite Whale');
  });

  it('respects custom weights', () => {
    const onlyImpact = computeWhaleScore({
      sizeUsd: 1,
      marketImpactPct: 0.2,
      weights: { positionSize: 0, historicalRoi: 0, marketImpact: 1, timing: 0 },
    });
    expect(onlyImpact.components.marketImpact).toBeGreaterThan(0);
    expect(onlyImpact.score).toBeGreaterThan(0);
  });
});
