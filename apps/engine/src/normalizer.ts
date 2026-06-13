import {
  quant,
  type NormalizedMarket,
  type NormalizedOrderBook,
  type NormalizedTrade,
} from '@whale/core';

/**
 * Defensive normalization layer. Collectors already emit the right shapes, but
 * upstream APIs drift and lie — so we validate, coerce probabilities into
 * [0,1], drop non-finite money, and reject records that can't be trusted before
 * anything is persisted or scored.
 */

export function normalizeTrade(t: NormalizedTrade): NormalizedTrade | null {
  if (!t.externalId || !t.marketExternalId) return null;
  const price = clampProb(t.price);
  const size = finite(t.size);
  const sizeUsd = finite(t.sizeUsd);
  if (price == null || size == null || sizeUsd == null || sizeUsd < 0) return null;
  const ts = validDate(t.timestamp);
  if (!ts) return null;
  return {
    ...t,
    price,
    size: Math.abs(size),
    sizeUsd: Math.abs(sizeUsd),
    wallet: t.wallet ? String(t.wallet).toLowerCase() : null,
    side: t.side === 'sell' ? 'sell' : 'buy',
    timestamp: ts,
  };
}

export function normalizeMarket(m: NormalizedMarket): NormalizedMarket | null {
  if (!m.externalId || !m.title) return null;
  return {
    ...m,
    title: m.title.trim().slice(0, 500),
    volumeUsd: m.volumeUsd != null ? Math.max(0, finite(m.volumeUsd) ?? 0) : null,
    liquidityUsd: m.liquidityUsd != null ? Math.max(0, finite(m.liquidityUsd) ?? 0) : null,
    outcomes: (m.outcomes ?? []).map((o) => ({
      ...o,
      impliedProb: o.impliedProb != null ? clampProb(o.impliedProb) : null,
      lastPrice: o.lastPrice != null ? clampProb(o.lastPrice) : null,
    })),
  };
}

export function normalizeOrderBook(b: NormalizedOrderBook): NormalizedOrderBook | null {
  if (!b.marketExternalId) return null;
  const bestBid = b.bestBid != null ? clampProb(b.bestBid) : null;
  const bestAsk = b.bestAsk != null ? clampProb(b.bestAsk) : null;
  return {
    ...b,
    bestBid,
    bestAsk,
    spread: bestBid != null && bestAsk != null ? Math.max(0, bestAsk - bestBid) : b.spread,
    bidDepthUsd: b.bidDepthUsd != null ? Math.max(0, finite(b.bidDepthUsd) ?? 0) : null,
    askDepthUsd: b.askDepthUsd != null ? Math.max(0, finite(b.askDepthUsd) ?? 0) : null,
    liquidityUsd: b.liquidityUsd != null ? Math.max(0, finite(b.liquidityUsd) ?? 0) : null,
    timestamp: validDate(b.timestamp) ?? new Date(),
  };
}

function clampProb(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n)) return null;
  return quant.clamp(n, 0, 1);
}

function finite(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function validDate(d: unknown): Date | null {
  const date = d instanceof Date ? d : new Date(d as string);
  return Number.isNaN(date.getTime()) ? null : date;
}
