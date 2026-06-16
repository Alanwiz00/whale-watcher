import {
  buildCanonicalKey,
  classifyEventType,
  config,
  extractTeam,
  logger,
  type NormalizedMarket,
  type NormalizedOrderBook,
  type NormalizedTrade,
} from '@whale/core';
import { fetchJson, type FetchJsonOpts } from '../http.js';
import type { Collector, TrackedMarket } from './base.js';

const log = logger.child({ svc: 'collectors', platform: 'polymarket' });

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/**
 * Hard rate cap for ALL Polymarket requests: serialize them to ≥
 * POLYMARKET_MIN_REQUEST_MS apart so a poll pass over hundreds of markets stays
 * under data-api's limit no matter how many fetches COLLECTOR_CONCURRENCY runs
 * in parallel (they queue at the gate). This is what stops the HTTP 429s.
 */
const minGap = config.POLYMARKET_MIN_REQUEST_MS;
let nextSlot = 0;
async function gate(): Promise<void> {
  if (minGap <= 0) return;
  const now = Date.now();
  const wait = nextSlot - now;
  nextSlot = (wait > 0 ? nextSlot : now) + minGap;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Rate-limited Polymarket JSON fetch. */
async function pmFetch<T>(url: string, opts?: FetchJsonOpts): Promise<T> {
  await gate();
  return fetchJson<T>(url, opts);
}

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
  // Parent event(s) — match markets carry the "World Cup" signal here, not in
  // the per-market question.
  events?: Array<{ title?: string; slug?: string }>;
}

/**
 * A Gamma `/events` entry. The World Cup is organized as events (the winner
 * futures, each group, golden boot, props AND every individual game such as
 * "Belgium vs. Egypt"), each grouping its child `markets`. We discover via
 * events because the per-game markets live only here, and `/markets?tag_id=`
 * proved unreliable (intermittently returns 0).
 */
interface GammaEvent {
  id: string;
  title?: string;
  slug?: string;
  closed?: boolean;
  markets?: GammaMarket[];
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
    const limit = 100; // Gamma caps page size at 100
    const seen = new Set<string>();

    // Discover via the EVENTS endpoint under the World Cup tags. Polymarket groups
    // the WC as events — winner futures, groups, golden boot, props AND every
    // individual game ("Belgium vs. Egypt", whose markets like "Will Belgium win
    // on 2026-06-15?" are the highest-volume of all). The fifa-world-cup parent
    // tag (102232) is a superset of the year tag (102350) and is the ONLY place
    // those per-game markets appear. We read events (not /markets?tag_id=, which
    // intermittently returns 0) and walk each event's child markets.
    for (const tagId of config.POLYMARKET_WC_TAG_IDS) {
      for (let offset = 0; offset < 5_000; offset += limit) {
        let page: GammaEvent[] = [];
        try {
          page = await pmFetch<GammaEvent[]>(`${GAMMA}/events`, {
            query: { closed: false, limit, offset, tag_id: tagId },
          });
        } catch (err) {
          log.warn({ err: String(err), tagId, offset }, 'gamma events page fetch failed');
          break;
        }
        if (!page.length) break;

        for (const ev of page) {
          const eventTitle = ev.title ?? '';
          const eventIsMatch = / vs\.? /i.test(eventTitle);
          for (const m of ev.markets ?? []) {
            if (!m.conditionId || seen.has(m.conditionId) || m.closed) continue;
            seen.add(m.conditionId);
            const question = m.question ?? m.slug ?? '';
            if (!question) continue;

            // A live World Cup exposes ~10k Polymarket markets; tracking every $0
            // prop would swamp trade polling (and the DB). Skip dead markets at
            // discovery — real match/futures markets clear this easily. Reuses the
            // MIN_POLL_LIQUIDITY_USD knob (combined volume + book liquidity).
            const volumeUsd = num(m.volumeNum ?? m.volume);
            const liquidityUsd = num(m.liquidityNum ?? m.liquidity);
            if ((volumeUsd ?? 0) + (liquidityUsd ?? 0) < config.MIN_POLL_LIQUIDITY_USD) continue;

            // Per-game market questions ("Will Belgium win on 2026-06-15?") omit
            // the opponent; prefix the event matchup so classification + the
            // canonical key see both teams and group the game's markets together.
            const title =
              eventIsMatch && !/ vs\.? /i.test(question) ? `${eventTitle}: ${question}` : question;

            const outcomeNames = parseJsonArray(m.outcomes);
            const prices = parseJsonArray(m.outcomePrices).map(Number);
            const tokenIds = parseJsonArray(m.clobTokenIds);
            const eventType = classifyEventType(title);
            const team = extractTeam(title);

            // Skip CONCLUDED match markets — once a game ends, its winner sits at
            // ~0.999, so an extreme price reliably means "game over". (We don't
            // apply this to futures, where a ~0.99 side can just be a longshot
            // team that's still alive, not a decided market.)
            const isMatch =
              eventType === 'match_result' ||
              eventType === 'match_total_goals' ||
              eventType === 'match_scorer';
            const topPrice = Math.max(0, ...prices.filter(Number.isFinite));
            if (isMatch && topPrice >= config.MARKET_DECIDED_PRICE) continue;
            const canonicalKey = buildCanonicalKey(eventType, team, title);

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
              canonicalKey,
              startTime: m.startDate ? new Date(m.startDate) : null,
              closeTime: m.endDate ? new Date(m.endDate) : null,
              status: m.closed ? 'closed' : 'open',
              volumeUsd,
              liquidityUsd,
              outcomes,
            });

            tracked.push({
              platform: this.platform,
              externalId: m.conditionId,
              title,
              canonicalKey,
              meta: { conditionId: m.conditionId, tokenIds },
              liquidityUsd,
              volumeUsd,
              outcomes: outcomes.map((o) => ({ name: o.name, externalId: o.externalId })),
            });
          }
        }

        if (page.length < limit) break;
      }
    }

    log.info({ count: markets.length }, 'discovered polymarket WC markets (via events)');
    return { markets, tracked };
  }

  async fetchTrades(market: TrackedMarket): Promise<NormalizedTrade[]> {
    const conditionId = String(market.meta.conditionId ?? market.externalId);
    const sinceMs = market.lastTradeAt?.getTime() ?? 0;

    const raw = await pmFetch<DataApiTrade[]>(`${DATA_API}/trades`, {
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
      const book = await pmFetch<ClobBook>(`${CLOB}/book`, { query: { token_id: tokenId } }).catch(
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
