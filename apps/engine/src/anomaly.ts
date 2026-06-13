import { quant } from '@whale/core';

/* ──────────────────────────────────────────────────────────────────────────
 * Isolation Forest — unsupervised anomaly detection.
 *
 * Trains an ensemble of random isolation trees on subsamples. Anomalies isolate
 * with shorter average path length, yielding a score in (0,1): ~0.5 is nominal,
 * → 1 is strongly anomalous. Pure TS, no native deps.
 * ──────────────────────────────────────────────────────────────────────────*/

type Vec = number[];

interface ITreeNode {
  size: number;
  feature?: number;
  split?: number;
  left?: ITreeNode;
  right?: ITreeNode;
}

function harmonic(n: number): number {
  return n <= 1 ? 0 : Math.log(n - 1) + 0.5772156649;
}
/** Expected path length of an unsuccessful BST search over n points. */
function cFactor(n: number): number {
  if (n <= 1) return 0;
  return 2 * harmonic(n) - (2 * (n - 1)) / n;
}

export class IsolationForest {
  private trees: ITreeNode[] = [];
  private heightLimit = 0;
  private sampleSize = 0;

  constructor(
    private nTrees = 100,
    private subsample = 256,
  ) {}

  fit(data: Vec[]): this {
    if (data.length === 0) return this;
    this.sampleSize = Math.min(this.subsample, data.length);
    this.heightLimit = Math.ceil(Math.log2(Math.max(2, this.sampleSize)));
    const dims = data[0]!.length;
    this.trees = [];
    for (let i = 0; i < this.nTrees; i++) {
      const sample = subsampleRows(data, this.sampleSize);
      this.trees.push(this.buildTree(sample, 0, dims));
    }
    return this;
  }

  private buildTree(rows: Vec[], depth: number, dims: number): ITreeNode {
    if (depth >= this.heightLimit || rows.length <= 1) return { size: rows.length };
    const feature = Math.floor(Math.random() * dims);
    let min = Infinity;
    let max = -Infinity;
    for (const r of rows) {
      const v = r[feature]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) return { size: rows.length };
    const split = min + Math.random() * (max - min);
    const left: Vec[] = [];
    const right: Vec[] = [];
    for (const r of rows) (r[feature]! < split ? left : right).push(r);
    return {
      size: rows.length,
      feature,
      split,
      left: this.buildTree(left, depth + 1, dims),
      right: this.buildTree(right, depth + 1, dims),
    };
  }

  private pathLength(point: Vec, node: ITreeNode, depth: number): number {
    if (node.feature === undefined || !node.left || !node.right) {
      return depth + cFactor(node.size);
    }
    return point[node.feature]! < node.split!
      ? this.pathLength(point, node.left, depth + 1)
      : this.pathLength(point, node.right, depth + 1);
  }

  /** Anomaly score in (0,1). > ~0.6 is increasingly anomalous. */
  score(point: Vec): number {
    if (this.trees.length === 0) return 0;
    const avg = quant.mean(this.trees.map((t) => this.pathLength(point, t, 0)));
    return 2 ** (-avg / (cFactor(this.sampleSize) || 1));
  }
}

function subsampleRows(data: Vec[], k: number): Vec[] {
  const out: Vec[] = [];
  const n = data.length;
  for (let i = 0; i < k; i++) out.push(data[Math.floor(Math.random() * n)]!);
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * DBSCAN — density clustering to surface outlier trades/wallets (label -1).
 * ──────────────────────────────────────────────────────────────────────────*/

export function dbscan(points: Vec[], eps: number, minPts: number): number[] {
  const n = points.length;
  const labels = new Array<number>(n).fill(-2); // -2 = unvisited, -1 = noise
  let cluster = -1;

  const neighbors = (i: number): number[] => {
    const res: number[] = [];
    for (let j = 0; j < n; j++) if (euclid(points[i]!, points[j]!) <= eps) res.push(j);
    return res;
  };

  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    const nb = neighbors(i);
    if (nb.length < minPts) {
      labels[i] = -1;
      continue;
    }
    cluster++;
    labels[i] = cluster;
    const queue = [...nb];
    while (queue.length) {
      const q = queue.shift()!;
      if (labels[q] === -1) labels[q] = cluster;
      if (labels[q] !== -2) continue;
      labels[q] = cluster;
      const qnb = neighbors(q);
      if (qnb.length >= minPts) queue.push(...qnb);
    }
  }
  return labels;
}

function euclid(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return Math.sqrt(s);
}

/* ──────────────────────────────────────────────────────────────────────────
 * XGBoost / gradient-boosted models are intentionally NOT reimplemented in TS.
 * For supervised "is this wallet sharp?" scoring, export features to a Python
 * sidecar (scikit-learn/xgboost) and serve via ONNX Runtime. The hook below is
 * where that prediction would slot in; until a model is trained it returns null.
 * See docs/ARCHITECTURE.md § AI Layer.
 * ──────────────────────────────────────────────────────────────────────────*/
export async function xgbPredict(_features: Vec): Promise<number | null> {
  return null;
}
