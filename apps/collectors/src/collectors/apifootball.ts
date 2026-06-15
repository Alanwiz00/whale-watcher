import { config, logger, quant, type NormalizedMarket, type Platform } from '@whale/core';
import { fetchJson } from '../http.js';
import type { Collector, TrackedMarket } from './base.js';

const log = logger.child({ svc: 'collectors', platform: 'apifootball' });

/**
 * API-Football (API-Sports) adapter — replaces The Odds API as the price feed
 * for venues with no open trade API. We pull World Cup fixtures + per-bookmaker
 * "Match Winner" odds and emit them as markets tagged with the matching
 * platform, used purely for arbitrage / mispricing detection (odds only, no
 * wallets — a hard limitation of these books, not of WhaleWatcher).
 *
 * Works against either the direct API-Sports host (x-apisports-key) or the
 * RapidAPI host (x-rapidapi-key), auto-detected from API_FOOTBALL_BASE.
 * Discovery-only + page-capped to respect the free-tier daily quota.
 */

interface AfFixture {
  fixture?: { id?: number; date?: string; status?: { short?: string } };
  teams?: { home?: { name?: string }; away?: { name?: string } };
}

// Fixture statuses that mean "done / not playable" — never emit odds for these.
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP']);

interface AfOdds {
  fixture?: { id?: number };
  bookmakers?: Array<{
    id?: number;
    name?: string;
    bets?: Array<{ id?: number; name?: string; values?: Array<{ value?: string; odd?: string }> }>;
  }>;
}

interface AfResponse<T> {
  response?: T[];
  paging?: { current?: number; total?: number };
  errors?: unknown;
}

const BOOKMAKER_TO_PLATFORM: Array<[match: string, platform: Platform]> = [
  ['pinnacle', 'pinnacle'],
  ['betfair', 'betfair'],
  ['draftkings', 'draftkings'],
  ['fanduel', 'fanduel'],
  ['stake', 'stake'],
];

function platformFor(bookmakerName?: string): Platform | null {
  const n = (bookmakerName ?? '').toLowerCase();
  return BOOKMAKER_TO_PLATFORM.find(([m]) => n.includes(m))?.[1] ?? null;
}

export class ApiFootballCollector implements Collector {
  // Representative identity only; emitted markets carry their own per-book platform.
  readonly platform = 'pinnacle' as const;
  readonly capabilities = { wallets: false, trades: false, orderbook: false };

  private base = config.API_FOOTBALL_BASE.replace(/\/$/, '');
  private league = config.API_FOOTBALL_LEAGUE_ID;
  private season = config.API_FOOTBALL_SEASON;
  private lastRunAt = 0;

  private headers(): Record<string, string> {
    if (this.base.includes('rapidapi')) {
      return {
        'x-rapidapi-key': config.API_FOOTBALL_KEY,
        'x-rapidapi-host': new URL(this.base).host,
      };
    }
    return { 'x-apisports-key': config.API_FOOTBALL_KEY };
  }

  async discoverMarkets(): Promise<{ markets: NormalizedMarket[]; tracked: TrackedMarket[] }> {
    if (!config.API_FOOTBALL_KEY) {
      log.info('API_FOOTBALL_KEY not set — odds-only venues (pinnacle/dk/fanduel/betfair) disabled');
      return { markets: [], tracked: [] };
    }

    // Quota guard: only hit the API once per API_FOOTBALL_INTERVAL_MS, regardless
    // of how often the 5-min discovery cycle runs. Prevents blowing the free tier.
    const now = Date.now();
    if (now - this.lastRunAt < config.API_FOOTBALL_INTERVAL_MS) {
      return { markets: [], tracked: [] };
    }
    this.lastRunAt = now;

    // 1) Fixtures → team names + kickoff per fixtureId.
    const fixtures = new Map<number, { home: string; away: string; date?: string }>();
    const fx = await fetchJson<AfResponse<AfFixture>>(`${this.base}/fixtures`, {
      query: { league: this.league, season: this.season },
      headers: this.headers(),
    }).catch((err) => {
      log.warn({ err: String(err) }, 'api-football fixtures fetch failed');
      return { response: [] } as AfResponse<AfFixture>;
    });
    for (const f of fx.response ?? []) {
      const id = f.fixture?.id;
      const home = f.teams?.home?.name;
      const away = f.teams?.away?.name;
      if (!id || !home || !away) continue;
      // Only keep upcoming / live fixtures — never odds for finished or past matches.
      const status = f.fixture?.status?.short ?? 'NS';
      if (FINISHED_STATUSES.has(status)) continue;
      const kickoff = f.fixture?.date ? new Date(f.fixture.date).getTime() : 0;
      if (kickoff && kickoff < now - 3 * 60 * 60_000) continue; // started >3h ago = over
      fixtures.set(id, { home, away, date: f.fixture?.date });
    }

    // 2) Match-winner odds, page-capped.
    const markets: NormalizedMarket[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const od = await fetchJson<AfResponse<AfOdds>>(`${this.base}/odds`, {
        query: { league: this.league, season: this.season, bet: 1, page },
        headers: this.headers(),
      }).catch((err) => {
        log.warn({ err: String(err), page }, 'api-football odds fetch failed');
        return { response: [], paging: { current: page, total: page } } as AfResponse<AfOdds>;
      });
      totalPages = Math.min(od.paging?.total ?? 1, config.API_FOOTBALL_MAX_PAGES);

      for (const entry of od.response ?? []) {
        const fid = entry.fixture?.id;
        const fixture = fid ? fixtures.get(fid) : undefined;
        if (!fixture) continue;
        const title = `${fixture.home} vs ${fixture.away} (World Cup 2026)`;
        // Key per fixture id (not team aliases) so distinct matches never collide;
        // betfair/pinnacle for the SAME fixture still share it for cross-book arb.
        const canonicalKey = `wc2026:match:af:${fid}`;
        const kickoff = fixture.date ? new Date(fixture.date) : null;

        for (const bk of entry.bookmakers ?? []) {
          const platform = platformFor(bk.name);
          if (!platform) continue;
          const bet = bk.bets?.find((b) => b.id === 1 || /match winner|1x2|fulltime result/i.test(b.name ?? ''));
          if (!bet?.values?.length) continue;

          const outcomes = bet.values
            .map((v) => {
              const odd = Number(v.odd);
              if (!Number.isFinite(odd) || odd <= 1) return null;
              const name =
                v.value === 'Home' ? fixture.home : v.value === 'Away' ? fixture.away : 'Draw';
              return { name, impliedProb: quant.decimalToProb(odd), lastPrice: quant.decimalToProb(odd) };
            })
            .filter((o): o is NonNullable<typeof o> => o !== null);
          if (!outcomes.length) continue;

          markets.push({
            platform,
            externalId: `${platform}:fixture:${fid}`,
            title,
            eventType: 'match_result',
            team: null,
            canonicalKey,
            startTime: kickoff,
            // Match is "over" ~3h after kickoff — lets the engine exclude it.
            closeTime: kickoff ? new Date(kickoff.getTime() + 3 * 60 * 60_000) : null,
            status: 'open',
            outcomes,
          });
        }
      }
      page++;
    } while (page <= totalPages);

    log.info({ count: markets.length, fixtures: fixtures.size }, 'discovered api-football WC odds');
    return { markets, tracked: [] };
  }
}
