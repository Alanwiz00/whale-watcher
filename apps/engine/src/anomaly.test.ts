import { describe, expect, it } from 'vitest';
import { dbscan, IsolationForest } from './anomaly.js';

function cluster(cx: number, cy: number, n: number, spread = 0.3): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    pts.push([cx + (Math.random() - 0.5) * spread, cy + (Math.random() - 0.5) * spread]);
  }
  return pts;
}

describe('IsolationForest', () => {
  it('scores a clear outlier higher than dense inliers', () => {
    const data = cluster(0, 0, 300, 0.5);
    const forest = new IsolationForest(120, 256).fit(data);

    const inlierScores = cluster(0, 0, 20, 0.3).map((p) => forest.score(p));
    const outlierScore = forest.score([50, 50]);

    const avgInlier = inlierScores.reduce((a, b) => a + b, 0) / inlierScores.length;
    expect(outlierScore).toBeGreaterThan(avgInlier);
    expect(outlierScore).toBeGreaterThan(0.6);
  });

  it('is safe on empty input', () => {
    const forest = new IsolationForest().fit([]);
    expect(forest.score([1, 2])).toBe(0);
  });
});

describe('dbscan', () => {
  it('separates two dense clusters and marks far points as noise', () => {
    const a = cluster(0, 0, 30, 0.2);
    const b = cluster(10, 10, 30, 0.2);
    const noise = [[100, 100]];
    const labels = dbscan([...a, ...b, ...noise], 1, 4);

    const clusterIds = new Set(labels.filter((l) => l >= 0));
    expect(clusterIds.size).toBe(2);
    expect(labels[labels.length - 1]).toBe(-1); // the far point is noise
  });
});
