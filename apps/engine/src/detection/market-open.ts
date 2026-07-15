import { config, logger, redis, type AlertPayload } from '@whale/core';
import { emitAlert } from '../alerts.js';

const log = logger.child({ svc: 'engine', mod: 'market-open' });
const GAMMA = 'https://gamma-api.polymarket.com';

// Persisted "seen" set + a primed flag so we alert ONLY on windows that appear
// after we start watching — never a backfill of already-listed markets.
const SEEN_KEY = 'ww:market-open:elon:seen';
const PRIMED_KEY = 'ww:market-open:elon:primed';

interface GammaEvent {
  id?: string;
  title?: string;
  slug?: string;
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  closed?: boolean;
  markets?: Array<{ closed?: boolean }>;
}

// Elon tweet-COUNT windows only. Polymarket's current format is "Elon Musk #
// tweets July 10 - July 17, 2026?" (note "# tweets", not "# of tweets"); the tag
// also holds other figures ("Zelenskyy # posts …"), so require BOTH "elon" and a
// tweet-count phrase, and exclude the categorical "What will Elon post" markets.
const ELON_RE = /elon/i;
const COUNT_RE = /#\s*(?:of\s+)?tweets|number of tweets|tweet count/i;
const isElonTweetCount = (title: string): boolean => ELON_RE.test(title) && COUNT_RE.test(title);

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Window length in days from the title's date range — e.g. "July 10 - July 17,
 * 2026" → 7, "July 16 - July 18, 2026" → 2, "January 10-17" → 7. The event's
 * startDate is the LISTING time (days before the window), so it can't be used.
 * Returns null if the title has no parseable range (e.g. "# tweets in July").
 */
function windowDaysFromTitle(title: string): number | null {
  const m = title.match(
    /([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*[-–]\s*(?:([A-Za-z]{3,9})\.?\s+)?(\d{1,2})(?:,?\s*(\d{4}))?/,
  );
  if (!m) return null;
  const mon1 = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  const mon2 = m[3] ? MONTHS[m[3].slice(0, 3).toLowerCase()] : mon1;
  if (mon1 == null || mon2 == null) return null;
  const year = m[5] ? Number(m[5]) : new Date().getUTCFullYear();
  const start = Date.UTC(year, mon1, Number(m[2]));
  let end = Date.UTC(year, mon2, Number(m[4]));
  if (end < start) end = Date.UTC(year + 1, mon2, Number(m[4])); // cross-year (Dec→Jan)
  return Math.round((end - start) / 86_400_000);
}

function windowLabel(title: string): string {
  const days = windowDaysFromTitle(title);
  if (days != null) {
    if (days <= 1) return 'daily';
    if (days === 2) return '2-day';
    if (days >= 6 && days <= 8) return 'weekly';
    return `${days}-day`;
  }
  // No date range: "# tweets in July 2026" → monthly; a single specific day
  // ("… July 15, 2026?") → daily; otherwise unknown.
  if (/\bin\s+[A-Za-z]{3,9}\b/i.test(title)) return 'monthly';
  if (/\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\s*\??\s*$/i.test(title)) return 'daily';
  return 'unknown window';
}

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'WhaleWatcher/0.1' },
      signal: ac.signal,
    });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const fmtDate = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : '?');

/**
 * "Market open" watcher. Polls the watched Elon-tweets tag(s) and fires a
 * `market_open` alert ONLY when a COUNT window is newly listed — the moment it
 * appears, independent of liquidity/volume.
 *
 * On the first run (or after a Redis flush) it PRIMES: records everything
 * currently listed as seen WITHOUT alerting, so there's never a backfill burst —
 * only windows that appear afterwards ping. A persisted Redis set tracks seen
 * events; emitAlert also dedupes on the per-event key. Failures are swallowed
 * (logged) so a Gamma hiccup never fails the scan job.
 */
export async function scanElonMarkets(): Promise<void> {
  if (!config.ELON_TRACKING || config.POLYMARKET_ELON_TAG_IDS.length === 0) return;

  // Gather the currently-listed Elon tweet-count windows across the tag(s).
  const byId = new Map<string, GammaEvent>();
  for (const tagId of config.POLYMARKET_ELON_TAG_IDS) {
    const events = await getJson<GammaEvent[]>(
      `${GAMMA}/events?closed=false&limit=100&offset=0&tag_id=${tagId}`,
    );
    if (!events) {
      log.warn({ tagId }, 'elon events fetch failed');
      continue;
    }
    for (const ev of events) {
      const id = ev.id ?? ev.slug;
      if (!id || byId.has(id) || !isElonTweetCount(ev.title ?? '')) continue;
      byId.set(id, ev);
    }
  }
  if (byId.size === 0) return;

  const r = redis();
  // First run / post-flush: prime the seen set and DON'T alert existing windows.
  if (!(await r.get(PRIMED_KEY))) {
    await r.sadd(SEEN_KEY, ...byId.keys());
    await r.set(PRIMED_KEY, '1');
    log.info({ existing: byId.size }, 'market-open primed — existing windows suppressed; only new listings alert');
    return;
  }

  for (const [id, ev] of byId) {
    // sadd returns 1 only if the id was newly added → a window we hadn't seen.
    if ((await r.sadd(SEEN_KEY, id)) === 0) continue;
    // Guard against a partial seen-set loss re-alerting an old window.
    const listedMs = ev.createdAt ? new Date(ev.createdAt).getTime() : Date.now();
    if (Date.now() - listedMs > config.ELON_MAX_AGE_MS) continue;

    const title = ev.title ?? '';
    const win = windowLabel(title);
    const brackets = (ev.markets ?? []).filter((m) => !m.closed).length;
    const url = ev.slug ? `https://polymarket.com/event/${ev.slug}` : 'https://polymarket.com';

    const alert: AlertPayload = {
      type: 'market_open',
      severity: 'high',
      platform: 'polymarket',
      title: '🆕 New Elon Tweets Market',
      body: [
        `Market: ${title}`,
        `Window: ${win} · resolves ${fmtDate(ev.endDate)}`,
        `Brackets: ${brackets}`,
        `Trade: ${url}`,
      ].join('\n'),
      data: {
        eventId: id,
        slug: ev.slug,
        window: win,
        brackets,
        startDate: ev.startDate,
        endDate: ev.endDate,
        url,
        marketTitle: title,
      },
      dedupeKey: `market_open:elon:${id}`,
      createdAt: new Date(),
    };
    const emitted = await emitAlert(alert);
    if (emitted) log.info({ event: id, title, window: win }, 'new elon market opened');
  }
}
