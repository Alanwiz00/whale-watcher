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
import { fetchJson } from '../http.js';
import { isWorldCup2026, type Collector, type TrackedMarket } from './base.js';

const log = logger.child({ svc: 'collectors', platform: 'kalshi' });

interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_bid?: number; // cents
  yes_ask?: number;
  last_price?: number;
  volume?: number;
  open_interest?: number;
  liquidity?: number; // cents
  status?: string;
  open_time?: string;
  close_time?: string;
}

interface KalshiTrade {
  trade_id: string;
  ticker: string;
  count?: number;
  yes_price?: number; // cents
  no_price?: number;
  taker_side?: string; // "yes" | "no"
  created_time?: string;
}

interface KalshiOrderbook {
  orderbook?: { yes?: Array<[number, number]>; no?: Array<[number, number]> };
}

const cents = (c?: number): number | null => (c == null ? null : c / 100);

export class KalshiCollector implements Collector {
  readonly platform = 'kalshi' as const;
  readonly capabilities = { wallets: false, trades: true, orderbook: true };
  private base = config.KALSHI_API_BASE;

  async discoverMarkets(): Promise<{ markets: NormalizedMarket[]; tracked: TrackedMarket[] }> {
    const markets: NormalizedMarket[] = [];
    const tracked: TrackedMarket[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      let res: { markets?: KalshiMarket[]; cursor?: string };
      try {
        res = await fetchJson(`${this.base}/markets`, {
          query: { status: 'open', limit: 1000, cursor },
        });
      } catch (err) {
        log.warn({ err: String(err) }, 'kalshi markets fetch failed');
        break;
      }
      for (const m of res.markets ?? []) {
        const title = [m.title, m.subtitle].filter(Boolean).join(' — ');
        if (!isWorldCup2026(title)) continue;
        const eventType = classifyEventType(title);
        const team = extractTeam(title);
        const yesProb = cents(m.last_price) ?? cents(m.yes_bid);

        markets.push({
          platform: this.platform,
          externalId: m.ticker,
          title,
          eventType,
          team,
          canonicalKey: buildCanonicalKey(eventType, team, title),
          startTime: m.open_time ? new Date(m.open_time) : null,
          closeTime: m.close_time ? new Date(m.close_time) : null,
          status: m.status === 'active' || m.status === 'open' ? 'open' : 'closed',
          volumeUsd: m.volume ?? null,
          liquidityUsd: cents(m.liquidity),
          outcomes: [
            { name: 'Yes', externalId: `${m.ticker}:yes`, impliedProb: yesProb, lastPrice: yesProb },
            {
              name: 'No',
              externalId: `${m.ticker}:no`,
              impliedProb: yesProb == null ? null : 1 - yesProb,
              lastPrice: yesProb == null ? null : 1 - yesProb,
            },
          ],
        });

        tracked.push({
          platform: this.platform,
          externalId: m.ticker,
          title,
          canonicalKey: buildCanonicalKey(eventType, team, title),
          meta: { ticker: m.ticker },
          outcomes: [{ name: 'Yes' }, { name: 'No' }],
        });
      }
      cursor = res.cursor;
      pages++;
    } while (cursor && pages < 10);

    log.info({ count: markets.length }, 'discovered kalshi WC markets');
    return { markets, tracked };
  }

  async fetchTrades(market: TrackedMarket): Promise<NormalizedTrade[]> {
    const ticker = String(market.meta.ticker ?? market.externalId);
    const sinceMs = market.lastTradeAt?.getTime() ?? 0;
    const res = await fetchJson<{ trades?: KalshiTrade[] }>(`${this.base}/markets/trades`, {
      query: { ticker, limit: 1000 },
    }).catch((err) => {
      log.warn({ err: String(err), ticker }, 'kalshi trades fetch failed');
      return { trades: [] as KalshiTrade[] };
    });

    const out: NormalizedTrade[] = [];
    for (const t of res.trades ?? []) {
      const tsMs = t.created_time ? new Date(t.created_time).getTime() : 0;
      if (tsMs <= sinceMs) continue;
      const yesProb = cents(t.yes_price);
      if (yesProb == null) continue;
      const count = t.count ?? 0;
      // Each contract settles at $1; USD notional = count × price.
      const sizeUsd = count * yesProb;
      out.push({
        platform: this.platform,
        externalId: t.trade_id,
        marketExternalId: ticker,
        outcomeName: t.taker_side === 'no' ? 'No' : 'Yes',
        wallet: null, // Kalshi trades are anonymized
        side: t.taker_side === 'no' ? 'sell' : 'buy',
        price: yesProb,
        size: count,
        sizeUsd,
        timestamp: new Date(tsMs),
        raw: t,
      });
    }
    return out;
  }

  async fetchOrderBook(market: TrackedMarket): Promise<NormalizedOrderBook[]> {
    const ticker = String(market.meta.ticker ?? market.externalId);
    const res = await fetchJson<KalshiOrderbook>(`${this.base}/markets/${ticker}/orderbook`).catch(
      () => null,
    );
    if (!res?.orderbook) return [];
    const yes = res.orderbook.yes ?? [];
    const no = res.orderbook.no ?? [];
    // Best yes bid = highest yes price; best yes ask = 100 - highest no price.
    const bestBid = yes.length ? cents(Math.max(...yes.map((l) => l[0]))) : null;
    const bestNo = no.length ? Math.max(...no.map((l) => l[0])) : null;
    const bestAsk = bestNo == null ? null : cents(100 - bestNo);
    const bidDepthUsd = yes.reduce((a, [p, s]) => a + (p / 100) * s, 0);
    const askDepthUsd = no.reduce((a, [p, s]) => a + (p / 100) * s, 0);

    return [
      {
        platform: this.platform,
        marketExternalId: ticker,
        outcomeName: 'Yes',
        bestBid,
        bestAsk,
        spread: bestBid != null && bestAsk != null ? +(bestAsk - bestBid).toFixed(6) : null,
        bidDepthUsd,
        askDepthUsd,
        liquidityUsd: bidDepthUsd + askDepthUsd,
        timestamp: new Date(),
        raw: res,
      },
    ];
  }
}
