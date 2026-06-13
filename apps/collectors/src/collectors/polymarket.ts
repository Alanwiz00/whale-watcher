import {
  buildCanonicalKey,
  classifyEventType,
  extractTeam,
  logger,
  type NormalizedMarket,
  type NormalizedOrderBook,
  type NormalizedTrade,
} from '@whale/core';
import { fetchJson } from '../http.js';
import { isWorldCup2026, type Collector, type TrackedMarket } from './base.js';

const log = logger.child({ svc: 'collectors', platform: 'polymarket' });

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/** Subset of the Gamma `/markets` payload we rely on. Fields are best-effort. */
interface GammaMarket {
  id: string;
  question?: string;
  conditionId?: string;
  slug?: string;
  active?: boolean;
  closed?: boolean;
  startDate?: string;
  endDate?: string;
  volumeNum?: number;
  volume?: string | number;
  liquidityNum?: number;
  liquidity?: string | number;
  outcomes?: string; // JSON-encoded string[]
  outcomePrices?: string; // JSON-encoded string[]
  clobTokenIds?: string; // JSON-encoded string[]
}

interface DataApiTrade {
  proxyWallet?: string;
  side?: string; // BUY | SELL
  size?: number;
  price?: number;
  asset?: string;
  conditionId?: string;
  outcome?: string;
  outcomeIndex?: number;
  timestamp?: number; // unix seconds
  transactionHash?: string;
}

interface ClobBook {
  market?: string;
  asset_id?: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

function parseJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export class PolymarketCollector implements Collector {
  readonly platform = 'polymarket' as const;
  readonly capabilities = { wallets: true, trades: true, orderbook: true };

  async discoverMarkets(): Promise<{ markets: NormalizedMarket[]; tracked: TrackedMarket[] }> {
    const markets: NormalizedMarket[] = [];
    const tracked: TrackedMarket[] = [];
    const limit = 100;

    // Page through active, open markets ordered by volume; cap pages to bound work.
    for (let offset = 0; offset < 2_000; offset += limit) {
      let page: GammaMarket[] = [];
      try {
        page = await fetchJson<GammaMarket[]>(`${GAMMA}/markets`, {
          query: {
            active: true,
            closed: false,
            limit,
            offset,
            order: 'volumeNum',
            ascending: false,
          },
        });
      } catch (err) {
        log.warn({ err: String(err), offset }, 'gamma page fetch failed');
        break;
      }
      if (!page.length) break;

      for (const m of page) {
        const title = m.question ?? m.slug ?? '';
        if (!title || !isWorldCup2026(title)) continue;
        if (!m.conditionId) continue;

        const outcomeNames = parseJsonArray(m.outcomes);
        const prices = parseJsonArray(m.outcomePrices).map(Number);
        const tokenIds = parseJsonArray(m.clobTokenIds);
        const eventType = classifyEventType(title);
        const team = extractTeam(title);

        const outcomes = outcomeNames.map((name, i) => ({
          name,
          externalId: tokenIds[i] ?? null,
          impliedProb: Number.isFinite(prices[i]) ? prices[i]! : null,
          lastPrice: Number.isFinite(prices[i]) ? prices[i]! : null,
        }));

        markets.push({
          platform: this.platform,
          externalId: m.conditionId,
          title,
          eventType,
          team,
          canonicalKey: buildCanonicalKey(eventType, team, title),
          startTime: m.startDate ? new Date(m.startDate) : null,
          closeTime: m.endDate ? new Date(m.endDate) : null,
          status: m.closed ? 'closed' : 'open',
          volumeUsd: num(m.volumeNum ?? m.volume),
          liquidityUsd: num(m.liquidityNum ?? m.liquidity),
          outcomes,
        });

        tracked.push({
          platform: this.platform,
          externalId: m.conditionId,
          title,
          canonicalKey: buildCanonicalKey(eventType, team, title),
          meta: { conditionId: m.conditionId, tokenIds },
          outcomes: outcomes.map((o) => ({ name: o.name, externalId: o.externalId })),
        });
      }

      if (page.length < limit) break;
    }

    log.info({ count: markets.length }, 'discovered polymarket WC markets');
    return { markets, tracked };
  }

  async fetchTrades(market: TrackedMarket): Promise<NormalizedTrade[]> {
    const conditionId = String(market.meta.conditionId ?? market.externalId);
    const sinceMs = market.lastTradeAt?.getTime() ?? 0;

    const raw = await fetchJson<DataApiTrade[]>(`${DATA_API}/trades`, {
      query: { market: conditionId, limit: 500, offset: 0, takerOnly: false },
    }).catch((err) => {
      log.warn({ err: String(err), conditionId }, 'trade fetch failed');
      return [] as DataApiTrade[];
    });

    const out: NormalizedTrade[] = [];
    for (const t of raw) {
      const tsMs = (t.timestamp ?? 0) * 1000;
      if (tsMs <= sinceMs) continue;
      const price = num(t.price);
      const size = num(t.size);
      if (price == null || size == null) continue;
      const sizeUsd = size * price; // shares × prob ≈ USDC notional
      const externalId = `${t.transactionHash ?? 'tx'}:${t.asset ?? '0'}:${t.proxyWallet ?? '0'}:${tsMs}`;

      out.push({
        platform: this.platform,
        externalId,
        marketExternalId: conditionId,
        outcomeName: t.outcome ?? null,
        wallet: t.proxyWallet ?? null,
        side: (t.side ?? 'BUY').toLowerCase() === 'sell' ? 'sell' : 'buy',
        price,
        size,
        sizeUsd,
        timestamp: new Date(tsMs),
        raw: t,
      });
    }
    return out;
  }

  async fetchOrderBook(market: TrackedMarket): Promise<NormalizedOrderBook[]> {
    const tokenIds = (market.meta.tokenIds as string[] | undefined) ?? [];
    const books: NormalizedOrderBook[] = [];

    for (const tokenId of tokenIds.slice(0, 2)) {
      const book = await fetchJson<ClobBook>(`${CLOB}/book`, { query: { token_id: tokenId } }).catch(
        () => null,
      );
      if (!book) continue;
      const bestBid = book.bids?.length ? Number(book.bids[book.bids.length - 1]!.price) : null;
      const bestAsk = book.asks?.length ? Number(book.asks[book.asks.length - 1]!.price) : null;
      const bidDepthUsd = sumDepth(book.bids);
      const askDepthUsd = sumDepth(book.asks);
      const outcomeName =
        market.outcomes.find((o) => o.externalId === tokenId)?.name ?? null;

      books.push({
        platform: this.platform,
        marketExternalId: market.externalId,
        outcomeName,
        bestBid,
        bestAsk,
        spread: bestBid != null && bestAsk != null ? +(bestAsk - bestBid).toFixed(6) : null,
        bidDepthUsd,
        askDepthUsd,
        liquidityUsd: (bidDepthUsd ?? 0) + (askDepthUsd ?? 0),
        timestamp: new Date(),
        raw: book,
      });
    }
    return books;
  }
}

function sumDepth(levels?: Array<{ price: string; size: string }>): number | null {
  if (!levels?.length) return null;
  return levels.reduce((acc, l) => acc + Number(l.price) * Number(l.size), 0);
}
