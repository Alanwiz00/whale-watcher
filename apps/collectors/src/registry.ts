import { logger, type Platform } from '@whale/core';
import { KalshiCollector } from './collectors/kalshi.js';
import { ManifoldCollector } from './collectors/manifold.js';
import { OddsApiCollector } from './collectors/oddsapi.js';
import { PolymarketCollector } from './collectors/polymarket.js';
import type { Collector, TrackedMarket } from './collectors/base.js';

const log = logger.child({ svc: 'collectors', mod: 'registry' });

/** All enabled collectors. Add new venues here. */
export const collectors: Collector[] = [
  new PolymarketCollector(),
  new KalshiCollector(),
  new ManifoldCollector(),
  new OddsApiCollector(),
];

/**
 * In-memory store of markets we actively poll, keyed by `${platform}:${externalId}`.
 * Discovery refreshes it; the trade/orderbook workers iterate it. Keeping this
 * in the collector process (not the DB) means collectors own their poll state
 * and have no DB dependency.
 */
class TrackedMarketRegistry {
  private map = new Map<string, TrackedMarket>();

  key(platform: Platform, externalId: string): string {
    return `${platform}:${externalId}`;
  }

  upsert(m: TrackedMarket): void {
    const k = this.key(m.platform, m.externalId);
    const existing = this.map.get(k);
    // Preserve the poll cursor across discovery refreshes.
    if (existing) m.lastTradeAt = existing.lastTradeAt;
    this.map.set(k, m);
  }

  setCursor(platform: Platform, externalId: string, at: Date): void {
    const m = this.map.get(this.key(platform, externalId));
    if (m && (!m.lastTradeAt || at > m.lastTradeAt)) m.lastTradeAt = at;
  }

  all(): TrackedMarket[] {
    return [...this.map.values()];
  }

  byPlatform(platform: Platform): TrackedMarket[] {
    return this.all().filter((m) => m.platform === platform);
  }

  get size(): number {
    return this.map.size;
  }
}

export const registry = new TrackedMarketRegistry();

export function collectorFor(platform: Platform): Collector | undefined {
  return collectors.find((c) => c.platform === platform);
}

export function logRegistry(): void {
  log.info({ tracked: registry.size }, 'tracked-market registry size');
}
