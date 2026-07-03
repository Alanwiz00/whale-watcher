import { config, logger, type AlertPayload } from '@whale/core';
import { emitAlert } from '../alerts.js';

const log = logger.child({ svc: 'engine', mod: 'market-open' });
const GAMMA = 'https://gamma-api.polymarket.com';

interface GammaEvent {
  id?: string;
  title?: string;
  slug?: string;
  startDate?: string;
  endDate?: string;
  closed?: boolean;
  markets?: Array<{ closed?: boolean }>;
}

// Only the tweet-COUNT windows ("Elon Musk # of tweets Feb 21-28?"), not the
// categorical "What will Elon post this week?" markets under the same tag.
const COUNT_RE = /#\s*of\s*tweets|number of tweets|how many .*tweet/i;

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

/** Human window label from the event's date span (daily / 2-day / weekly / N-day). */
function windowLabel(startISO?: string, endISO?: string): string {
  if (!startISO || !endISO) return 'unknown window';
  const days = Math.round((new Date(endISO).getTime() - new Date(startISO).getTime()) / 86_400_000);
  if (days <= 1) return 'daily';
  if (days === 2) return '2-day';
  if (days >= 6 && days <= 8) return 'weekly';
  return `${days}-day`;
}

const fmtDate = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : '?');

/**
 * "Market open" watcher. Polls the watched Elon-tweets tag(s) and fires a
 * `market_open` alert the first time a new COUNT window is listed — the moment
 * it opens, independent of liquidity/volume. emitAlert dedupes on the per-event
 * dedupeKey, so each window alerts exactly once. Failures are swallowed (logged)
 * so a Gamma hiccup never fails the scan job.
 */
export async function scanElonMarkets(): Promise<void> {
  if (!config.ELON_TRACKING || config.POLYMARKET_ELON_TAG_IDS.length === 0) return;
  const seen = new Set<string>();

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
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = ev.title ?? '';
      if (!COUNT_RE.test(title)) continue; // tweet-count windows only

      const win = windowLabel(ev.startDate, ev.endDate);
      const brackets = (ev.markets ?? []).filter((m) => !m.closed).length;
      const url = ev.slug ? `https://polymarket.com/event/${ev.slug}` : 'https://polymarket.com';

      const alert: AlertPayload = {
        type: 'market_open',
        severity: 'high',
        platform: 'polymarket',
        title: '🆕 New Elon Tweets Market',
        body: [
          `Market: ${title}`,
          `Window: ${win}  (${fmtDate(ev.startDate)} → ${fmtDate(ev.endDate)})`,
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
        // Once per event, ever — emitAlert dedupes on this via the Alert table.
        dedupeKey: `market_open:elon:${id}`,
        createdAt: new Date(),
      };
      const emitted = await emitAlert(alert);
      if (emitted) log.info({ event: id, title, window: win }, 'new elon market opened');
    }
  }
}
