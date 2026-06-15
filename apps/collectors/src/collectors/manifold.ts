import {
  buildCanonicalKey,
  classifyEventType,
  config,
  extractTeam,
  logger,
  type NormalizedMarket,
  type NormalizedTrade,
} from '@whale/core';
import { fetchJson } from '../http.js';
import { isWorldCup2026, type Collector, type TrackedMarket } from './base.js';

const log = logger.child({ svc: 'collectors', platform: 'manifold' });

interface ManifoldMarket {
  id: string;
  question?: string;
  slug?: string;
  url?: string;
  outcomeType?: string;
  probability?: number;
  volume?: number;
  totalLiquidity?: number;
  createdTime?: number;
  closeTime?: number;
  isResolved?: boolean;
}

interface ManifoldBet {
  id: string;
  userId?: string;
  userName?: string;
  username?: string;
  contractId?: string;
  amount?: number; // mana (M$)
  outcome?: string; // YES | NO | answer id
  probBefore?: number;
  probAfter?: number;
  shares?: number;
  createdTime?: number;
  isRedemption?: boolean;
  isAnte?: boolean;
  isLiquidityProvision?: boolean;
}

const SEARCH_TERMS = ['world cup 2026', 'fifa world cup 2026', '2026 world cup'];

export class ManifoldCollector implements Collector {
  readonly platform = 'manifold' as const;
  // NB: Manifold is play-money (mana). All mana figures are converted to
  // approximate USD via MANIFOLD_USD_PER_MANA so they're comparable to real
  // venues. `toUsd` is the single conversion point.
  readonly capabilities = { wallets: true, trades: true, orderbook: false };
  private mana = config.MANIFOLD_USD_PER_MANA;
  private toUsd = (n: number | null | undefined): number | null =>
    n == null ? null : n * this.mana;
  private base = config.MANIFOLD_API_BASE;
  private headers: Record<string, string> = config.MANIFOLD_API_KEY
    ? { authorization: `Key ${config.MANIFOLD_API_KEY}` }
    : {};

  async discoverMarkets(): Promise<{ markets: NormalizedMarket[]; tracked: TrackedMarket[] }> {
    const seen = new Set<string>();
    const markets: NormalizedMarket[] = [];
    const tracked: TrackedMarket[] = [];

    for (const term of SEARCH_TERMS) {
      const res = await fetchJson<ManifoldMarket[]>(`${this.base}/search-markets`, {
        query: { term, limit: 100 },
        headers: this.headers,
      }).catch((err) => {
        log.warn({ err: String(err), term }, 'manifold search failed');
        return [] as ManifoldMarket[];
      });

      for (const m of res) {
        const title = m.question ?? m.slug ?? '';
        if (seen.has(m.id) || !isWorldCup2026(title, m.slug)) continue;
        seen.add(m.id);
        const eventType = classifyEventType(title);
        const team = extractTeam(title);
        const prob = m.probability ?? null;

        markets.push({
          platform: this.platform,
          externalId: m.id,
          title,
          eventType,
          team,
          canonicalKey: buildCanonicalKey(eventType, team, title),
          startTime: m.createdTime ? new Date(m.createdTime) : null,
          closeTime: m.closeTime ? new Date(m.closeTime) : null,
          status: m.isResolved ? 'resolved' : 'open',
          volumeUsd: this.toUsd(m.volume),
          liquidityUsd: this.toUsd(m.totalLiquidity),
          outcomes:
            m.outcomeType === 'BINARY'
              ? [
                  { name: 'YES', impliedProb: prob, lastPrice: prob },
                  { name: 'NO', impliedProb: prob == null ? null : 1 - prob, lastPrice: prob == null ? null : 1 - prob },
                ]
              : [],
        });

        tracked.push({
          platform: this.platform,
          externalId: m.id,
          title,
          canonicalKey: buildCanonicalKey(eventType, team, title),
          meta: { contractId: m.id },
          liquidityUsd: this.toUsd(m.totalLiquidity),
          volumeUsd: this.toUsd(m.volume),
          outcomes: [{ name: 'YES' }, { name: 'NO' }],
        });
      }
    }

    log.info({ count: markets.length }, 'discovered manifold WC markets');
    return { markets, tracked };
  }

  async fetchTrades(market: TrackedMarket): Promise<NormalizedTrade[]> {
    const contractId = String(market.meta.contractId ?? market.externalId);
    const sinceMs = market.lastTradeAt?.getTime() ?? 0;
    const bets = await fetchJson<ManifoldBet[]>(`${this.base}/bets`, {
      query: { contractId, limit: 1000 },
      headers: this.headers,
    }).catch((err) => {
      log.warn({ err: String(err), contractId }, 'manifold bets fetch failed');
      return [] as ManifoldBet[];
    });

    const out: NormalizedTrade[] = [];
    for (const b of bets) {
      // Skip non-trades: redemptions, ante, and liquidity provision (the last has
      // a large `amount` but isn't trading volume — it was inflating "trades").
      if (b.isRedemption || b.isAnte || b.isLiquidityProvision) continue;
      const tsMs = b.createdTime ?? 0;
      if (tsMs <= sinceMs) continue;
      const yesProb = b.probAfter ?? b.probBefore ?? null;
      const amount = b.amount ?? 0;
      if (yesProb == null || amount === 0) continue;
      // Manifold bets are BUYS of an outcome (YES/NO); a negative amount is a
      // sale. Price is the backed outcome's price: YES→yesProb, NO→1−yesProb.
      const outcome = (b.outcome ?? 'YES').toUpperCase();
      const isNo = outcome === 'NO';
      const price = isNo ? 1 - yesProb : yesProb;
      out.push({
        platform: this.platform,
        externalId: b.id,
        marketExternalId: contractId,
        outcomeName: isNo ? 'NO' : 'YES',
        wallet: b.userId ?? b.username ?? null,
        side: amount < 0 ? 'sell' : 'buy',
        price,
        size: Math.abs(b.shares ?? amount),
        sizeUsd: Math.abs(amount) * this.mana, // mana → approximate USD
        timestamp: new Date(tsMs),
        raw: b,
      });
    }
    return out;
  }
}
