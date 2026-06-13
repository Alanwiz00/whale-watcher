import {
  config,
  logger,
  quant,
  type NormalizedMarket,
  type Platform,
} from '@whale/core';
import { fetchJson } from '../http.js';
import type { Collector, TrackedMarket } from './base.js';

const log = logger.child({ svc: 'collectors', platform: 'oddsapi' });

/**
 * Aggregator adapter for venues with NO open trade API (Pinnacle, DraftKings,
 * FanDuel, Betfair, Stake). We pull *odds only* via The Odds API and emit them
 * as markets tagged with the matching platform, used purely as price feeds for
 * arbitrage + steam detection. There are no wallets and no trade-level data
 * here — that is a hard limitation of these venues, not of WhaleWatcher.
 *
 * Quota-aware: The Odds API bills per request, so this collector only runs on
 * the discovery interval (capabilities.trades/orderbook = false).
 */

interface OddsEvent {
  id: string;
  sport_key?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers?: Array<{
    key: string;
    title?: string;
    markets?: Array<{ key: string; outcomes?: Array<{ name: string; price: number }> }>;
  }>;
}

const BOOKMAKER_TO_PLATFORM: Record<string, Platform> = {
  pinnacle: 'pinnacle',
  draftkings: 'draftkings',
  fanduel: 'fanduel',
  betfair_ex_uk: 'betfair',
  betfair_ex_eu: 'betfair',
  betfair: 'betfair',
  stake: 'stake',
};

// Outright winner market is the most reliably available WC market on the API.
const SPORT_KEYS = ['soccer_fifa_world_cup_winner', 'soccer_fifa_world_cup'];

export class OddsApiCollector implements Collector {
  // Representative identity; emitted markets carry their own per-bookmaker platform.
  readonly platform = 'pinnacle' as const;
  readonly capabilities = { wallets: false, trades: false, orderbook: false };

  async discoverMarkets(): Promise<{ markets: NormalizedMarket[]; tracked: TrackedMarket[] }> {
    if (!config.ODDS_API_KEY) {
      log.info('ODDS_API_KEY not set — odds-only venues (pinnacle/dk/fanduel/betfair) disabled');
      return { markets: [], tracked: [] };
    }

    const markets: NormalizedMarket[] = [];
    for (const sport of SPORT_KEYS) {
      const events = await fetchJson<OddsEvent[]>(`${config.ODDS_API_BASE}/sports/${sport}/odds`, {
        query: {
          apiKey: config.ODDS_API_KEY,
          regions: 'us,uk,eu',
          markets: sport.endsWith('winner') ? 'outrights' : 'h2h',
          oddsFormat: 'decimal',
          bookmakers: Object.keys(BOOKMAKER_TO_PLATFORM).join(','),
        },
      }).catch((err) => {
        log.warn({ err: String(err), sport }, 'odds api fetch failed');
        return [] as OddsEvent[];
      });

      for (const ev of events) {
        for (const bk of ev.bookmakers ?? []) {
          const platform = BOOKMAKER_TO_PLATFORM[bk.key];
          if (!platform) continue;
          const market = bk.markets?.[0];
          if (!market?.outcomes?.length) continue;

          const isOutright = market.key === 'outrights';
          const title = isOutright
            ? 'Who will win the 2026 FIFA World Cup?'
            : `${ev.home_team} vs ${ev.away_team} (World Cup 2026)`;

          markets.push({
            platform,
            externalId: `${bk.key}:${ev.id}:${market.key}`,
            title,
            eventType: isOutright ? 'tournament_winner' : 'match_result',
            team: null,
            canonicalKey: isOutright ? 'wc2026:winner' : `wc2026:match:${ev.id}`,
            startTime: ev.commence_time ? new Date(ev.commence_time) : null,
            status: 'open',
            outcomes: market.outcomes.map((o) => ({
              name: o.name,
              impliedProb: quant.decimalToProb(o.price),
              lastPrice: quant.decimalToProb(o.price),
            })),
          });
        }
      }
    }

    log.info({ count: markets.length }, 'discovered odds-only WC markets');
    // No tracked markets: odds-only venues are not polled for trades/books.
    return { markets, tracked: [] };
  }
}
