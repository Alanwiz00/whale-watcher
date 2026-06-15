import { config, logger, redis, type Platform } from '@whale/core';
import { ApiFootballCollector } from './collectors/apifootball.js';
import { KalshiCollector } from './collectors/kalshi.js';
import { ManifoldCollector } from './collectors/manifold.js';
import { PolymarketCollector } from './collectors/polymarket.js';
import type { Collector, TrackedMarket } from './collectors/base.js';

const log = logger.child({ svc: 'collectors', mod: 'registry' });

/**
 * All available collectors. Disable any by listing its `platform` in
 * DISABLED_PLATFORMS (e.g. "kalshi" until we have API credentials). Note the
 * ApiFootball collector's identity platform is `pinnacle`.
 */
const allCollectors: Collector[] = [
  new PolymarketCollector(),
  new KalshiCollector(),
  new ManifoldCollector(),
  new ApiFootballCollector(),
];

export const collectors: Collector[] = allCollectors.filter((c) => {
  if (config.DISABLED_PLATFORMS.includes(c.platform)) {
    log.warn({ platform: c.platform }, 'collector disabled via DISABLED_PLATFORMS');
    return false;
  }
  return true;
});

/** Redis hash holding the last-ingested trade timestamp (epoch ms) per market. */
const CURSOR_HASH = 'ww:trade-cursors';

/**
 * In-memory store of markets we actively poll, keyed by `${platform}:${externalId}`.
 * Discovery refreshes it; the trade/orderbook workers iterate it.
 *
 * Poll cursors are **persisted to Redis** so a collector restart resumes from
 * where it left off instead of re-pulling ~500 trades for every market (which
 * previously flooded the queue with 100k+ stale jobs). `hydrate()` loads them at
 * boot; `setCursor()` writes through.
 */
class TrackedMarketRegistry {
  private map = new Map<string, TrackedMarket>();
  private cursorCache = new Map<string, number>(); // key -> epoch ms

  key(platform: Platform, externalId: string): string {
    return `${platform}:${externalId}`;
  }

  /** Load persisted poll cursors from Redis once at boot (before discovery). */
  async hydrate(): Promise<void> {
    try {
      const all = await redis().hgetall(CURSOR_HASH);
      for (const [k, v] of Object.entries(all)) {
        const ms = Number(v);
        if (Number.isFinite(ms)) this.cursorCache.set(k, ms);
      }
      log.info({ cursors: this.cursorCache.size }, 'hydrated trade cursors from redis');
    } catch (err) {
      log.warn({ err: String(err) }, 'failed to hydrate trade cursors (will re-pull recent trades)');
    }
  }

  upsert(m: TrackedMarket): void {
    const k = this.key(m.platform, m.externalId);
    const existing = this.map.get(k);
    // Preserve the poll cursor across discovery refreshes / restarts.
    if (existing?.lastTradeAt) {
      m.lastTradeAt = existing.lastTradeAt;
    } else {
      const cached = this.cursorCache.get(k);
      if (cached) m.lastTradeAt = new Date(cached);
    }
    this.map.set(k, m);
  }

  setCursor(platform: Platform, externalId: string, at: Date): void {
    const k = this.key(platform, externalId);
    const m = this.map.get(k);
    const ms = at.getTime();
    if (m && (!m.lastTradeAt || at > m.lastTradeAt)) m.lastTradeAt = at;
    if (ms > (this.cursorCache.get(k) ?? 0)) {
      this.cursorCache.set(k, ms);
      // Write-through to Redis (fire-and-forget; non-fatal if it fails).
      redis()
        .hset(CURSOR_HASH, k, String(ms))
        .catch((err) => log.warn({ err: String(err), k }, 'failed to persist trade cursor'));
    }
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
