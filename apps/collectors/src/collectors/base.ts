import type {
  NormalizedMarket,
  NormalizedOrderBook,
  NormalizedTrade,
  Platform,
} from '@whale/core';

/**
 * A `TrackedMarket` is the collector's working copy of a discovered market plus
 * a per-outcome cursor so trade polling only pulls deltas. `meta` carries
 * venue-native fetch hints (token ids, tickers, slugs) opaque to the engine.
 */
export interface TrackedMarket {
  platform: Platform;
  externalId: string;
  title: string;
  canonicalKey?: string | null;
  meta: Record<string, unknown>;
  outcomes: Array<{ name: string; externalId?: string | null }>;
  /** Liquidity / cumulative volume (USD) — used to skip polling dead markets. */
  liquidityUsd?: number | null;
  volumeUsd?: number | null;
  /** Last trade timestamp ingested for this market (poll cursor). */
  lastTradeAt?: Date;
}

export interface CollectorCapabilities {
  /** Can attribute trades to a stable wallet/user id. */
  wallets: boolean;
  /** Exposes trade-level data. */
  trades: boolean;
  /** Exposes order-book depth. */
  orderbook: boolean;
}

/**
 * Every venue implements this interface. Add a new platform by dropping a file
 * in this directory and registering it in `registry.ts`.
 */
export interface Collector {
  readonly platform: Platform;
  readonly capabilities: CollectorCapabilities;

  /** Discover all World Cup 2026 markets on this venue. */
  discoverMarkets(): Promise<{ markets: NormalizedMarket[]; tracked: TrackedMarket[] }>;

  /** Fetch trades for a market newer than `market.lastTradeAt`. */
  fetchTrades?(market: TrackedMarket): Promise<NormalizedTrade[]>;

  /** Fetch a current order-book snapshot (one per outcome where relevant). */
  fetchOrderBook?(market: TrackedMarket): Promise<NormalizedOrderBook[]>;
}

/**
 * Shared FIFA World Cup 2026 relevance test. Pass any combination of title,
 * slug, and event/series name — match markets ("Brazil vs Argentina") often
 * only carry the World-Cup signal in the slug or parent event, not the title.
 *
 * Hardened to be the *FIFA national-team* World Cup only: explicitly excludes
 * look-alikes (FIFA Club World Cup, Cricket/Rugby/etc. World Cups).
 */
export function isWorldCup2026(...texts: Array<string | null | undefined>): boolean {
  // Normalize hyphen/underscore so slugs ("fifa-world-cup-2026") match too.
  const t = texts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[-_]+/g, ' ');
  // Different tournaments / sports that also say "world cup" — never ours.
  if (/club world cup|cricket|rugby|t20|netball|world cup of hockey|lacrosse|under[- ]?\d/.test(t)) {
    return false;
  }
  if (t.includes('world cup 2026') || t.includes('fifa world cup')) return true;
  if (t.includes('world cup') && (t.includes('2026') || t.includes('fifa'))) return true;
  return false;
}
