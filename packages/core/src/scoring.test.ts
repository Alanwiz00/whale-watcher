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

describe('computeWhaleScore (threshold-anchored)', () => {
  const THRESH = 1000;

  it('returns a 0–100 score with components', () => {
    const r = computeWhaleScore({ sizeUsd: 5_000, thresholdUsd: THRESH });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.components.positionSize).toBeGreaterThan(0);
  });

  it('a trade AT the threshold is always at least Notable (medium-worthy)', () => {
    const r = computeWhaleScore({ sizeUsd: THRESH, thresholdUsd: THRESH });
    expect(r.score).toBe(50);
    expect(r.tier).toBe('Notable Whale');
  });

  it('a sub-threshold-but-scored trade never drops below the anchor', () => {
    // detectWhale gates on size, but the score floor must hold regardless.
    const r = computeWhaleScore({ sizeUsd: THRESH / 10, thresholdUsd: THRESH });
    expect(r.score).toBeGreaterThanOrEqual(50);
  });

  it('2× threshold reaches Strong (high)', () => {
    const r = computeWhaleScore({ sizeUsd: 2 * THRESH, thresholdUsd: THRESH });
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.tier).toBe('Strong Whale');
  });

  it('scales with how far above the threshold it is (until the size cap)', () => {
    const atThreshold = computeWhaleScore({ sizeUsd: THRESH, thresholdUsd: THRESH }).score;
    const bigger = computeWhaleScore({ sizeUsd: 2.5 * THRESH, thresholdUsd: THRESH }).score;
    expect(bigger).toBeGreaterThan(atThreshold);
  });

  it('the same multiple of the threshold scores the same regardless of absolute size', () => {
    const a = computeWhaleScore({ sizeUsd: 2_000, thresholdUsd: 1_000 }).score;
    const b = computeWhaleScore({ sizeUsd: 600_000, thresholdUsd: 300_000 }).score;
    expect(a).toBe(b); // both are 2× the threshold
  });

  it('rewards strong historical ROI as a bonus (with enough samples)', () => {
    const base = { sizeUsd: 5_000, thresholdUsd: THRESH, marketImpactPct: 0.05 };
    const sharp = computeWhaleScore({ ...base, walletRoi: 0.6, walletSampleSize: 50 }).score;
    const dumb = computeWhaleScore({ ...base, walletRoi: -0.4, walletSampleSize: 50 }).score;
    expect(sharp).toBeGreaterThan(dumb);
  });

  it('a negative-ROI whale is not dragged below its size anchor', () => {
    const r = computeWhaleScore({
      sizeUsd: THRESH,
      thresholdUsd: THRESH,
      walletRoi: -0.9,
      walletSampleSize: 50,
    });
    expect(r.score).toBe(50); // still Notable — it's still a real whale
  });

  it('shrinks ROI influence when sample size is tiny', () => {
    const base = { sizeUsd: 5_000, thresholdUsd: THRESH };
    const lowN = computeWhaleScore({ ...base, walletRoi: 1.0, walletSampleSize: 1 }).components.historicalRoi;
    const highN = computeWhaleScore({ ...base, walletRoi: 1.0, walletSampleSize: 50 }).components.historicalRoi;
    expect(highN).toBeGreaterThan(lowN);
    expect(lowN).toBeCloseTo(0.5, 1);
  });

  it('a large + sharp + impactful + well-timed whale reaches Elite (≥90)', () => {
    const r = computeWhaleScore({
      sizeUsd: 10 * THRESH,
      thresholdUsd: THRESH,
      walletRoi: 0.8,
      walletSampleSize: 100,
      marketImpactPct: 0.15,
      timing: 0.95,
    });
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.tier).toBe('Elite Whale');
  });
});
