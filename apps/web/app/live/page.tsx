'use client';

import { useEffect, useRef, useState } from 'react';

interface FeedItem {
  type: string;
  severity: string;
  title: string;
  detail: string;
  ts: number;
}

const BASE_WS = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? '';
// Key rides the query string for WS (no headers on browser handshakes).
const WS_URL = `${BASE_WS}?channels=whales${API_KEY ? `&key=${encodeURIComponent(API_KEY)}` : ''}`;
const AUTH_HEADERS: HeadersInit | undefined = API_KEY ? { authorization: `Bearer ${API_KEY}` } : undefined;

// Only these alert types belong on the feed: notable big trades + sudden volume
// accumulation. Anything else on the channel (incl. stray/test publishes) is
// ignored, so the feed can't be polluted by non-alert messages.
const FEED_TYPES = new Set(['whale_trade', 'split_accumulation', 'volume_anomaly', 'smart_money']);
const ICON: Record<string, string> = {
  whale_trade: '🐋',
  split_accumulation: '🧩',
  volume_anomaly: '📊',
  smart_money: '🧠',
};
const SEV_COLOR: Record<string, string> = {
  critical: 'var(--red)',
  high: 'var(--gold)',
  medium: 'var(--accent)',
  low: 'var(--muted)',
};

const fmtUsd = (n: unknown) =>
  n == null || Number.isNaN(Number(n))
    ? '—'
    : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const shortW = (a?: string) => (!a ? '' : a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const hhmmss = (ts: number) => new Date(ts).toLocaleTimeString();

const pct = (p: unknown) => (p == null ? '' : `${(Number(p) * 100).toFixed(1)}%`);

function detailFor(type: string, data: Record<string, unknown> = {}): string {
  switch (type) {
    case 'whale_trade': {
      const isSell = String(data.side).toLowerCase() === 'sell';
      const action = data.outcome ? `${isSell ? 'SELL' : 'BUY'} ${data.outcome}` : isSell ? 'SELL' : 'BUY';
      const entry = data.entryPrice != null ? `@ ${pct(data.entryPrice)}` : '';
      const signed = (n: unknown) =>
        `${Number(n) >= 0 ? '+' : '-'}$${Math.abs(Math.round(Number(n))).toLocaleString('en-US')}`;
      const outcomeBit = isSell
        ? data.sellPnl != null
          ? `PnL ${signed(data.sellPnl)}`
          : ''
        : data.payoutIfWin != null
          ? `→ ${fmtUsd(data.payoutIfWin)} if win`
          : '';
      return [
        fmtUsd(data.sizeUsd),
        `${action} ${entry}`.trim(),
        outcomeBit,
        data.currentProb != null ? `now ${pct(data.currentProb)}` : '',
        data.marketTitle,
        `score ${data.score ?? '—'}`,
      ]
        .filter(Boolean)
        .join('  ·  ');
    }
    case 'split_accumulation':
      return [`${fmtUsd(data.aggregateUsd)} across ${data.legs ?? '?'} legs`, shortW(data.wallet as string)]
        .filter(Boolean)
        .join('  ·  ');
    case 'volume_anomaly':
      return [data.marketTitle, data.z != null ? `z=${Number(data.z).toFixed(1)}` : '']
        .filter(Boolean)
        .join('  ·  ');
    default:
      return '';
  }
}

export default function LivePage() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const ref = useRef<WebSocket | null>(null);

  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Seed + poll from the API so the feed reliably reflects the DB even if the
  // WS is idle. WS still delivers instant updates; this is the safety net.
  useEffect(() => {
    let stop = false;
    const types = [...FEED_TYPES].join(',');
    const load = () =>
      fetch(`${API_URL}/api/alerts?types=${types}&limit=80`, { headers: AUTH_HEADERS })
        .then((r) => r.json())
        .then((rows: Array<{ type: string; severity: string; title: string; data: Record<string, unknown>; createdAt: string }>) => {
          if (stop) return;
          const seed = rows
            .filter((a) => FEED_TYPES.has(a.type))
            .map((a) => ({
              type: a.type,
              severity: a.severity,
              title: a.title,
              detail: detailFor(a.type, a.data),
              ts: new Date(a.createdAt).getTime(),
            }));
          setItems((prev) => dedupe([...prev, ...seed]));
          setUpdatedAt(Date.now());
        })
        .catch(() => undefined);
    load();
    const id = setInterval(load, 8000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let stop = false;
    function connect() {
      const ws = new WebSocket(WS_URL);
      ref.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stop) setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          const p = msg.data ?? {};
          // Ignore system frames and anything that isn't a real feed alert.
          if (!p.type || !FEED_TYPES.has(p.type)) return;
          setItems((prev) =>
            dedupe([
              {
                type: p.type,
                severity: p.severity ?? 'low',
                title: p.title ?? '(alert)',
                detail: detailFor(p.type, p.data ?? {}),
                ts: Date.now(),
              },
              ...prev,
            ]),
          );
        } catch {
          /* ignore */
        }
      };
    }
    connect();
    return () => {
      stop = true;
      ref.current?.close();
    };
  }, []);

  return (
    <>
      <h1>Live Feed</h1>
      <p className="sub">
        <span className="dot" style={{ background: connected ? 'var(--green)' : 'var(--red)' }} />
        {connected ? 'Connected' : 'Reconnecting…'} · {items.length} events
        {updatedAt ? ` · updated ${hhmmss(updatedAt)}` : ''} · big trades &amp; volume accumulation
      </p>
      <div className="card">
        <h2>Realtime Whale Activity</h2>
        {items.length === 0 ? (
          <p className="empty">
            No qualifying activity yet. A year out, trades are small — if this stays empty, lower
            <code> WHALE_THRESHOLD_USD</code> / <code>SPLIT_THRESHOLD_USD</code> in <code>.env</code>.
          </p>
        ) : (
          <div className="feed">
            {items.map((it, i) => (
              <div className="row" key={`${it.title}-${it.ts}-${i}`} style={{ alignItems: 'baseline' }}>
                <span style={{ color: 'var(--muted)', minWidth: 72, fontVariantNumeric: 'tabular-nums' }}>
                  {hhmmss(it.ts)}
                </span>
                <span
                  title={it.severity}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: SEV_COLOR[it.severity] ?? 'var(--muted)',
                    flex: '0 0 auto',
                    alignSelf: 'center',
                  }}
                />
                <span style={{ minWidth: 150 }}>
                  {ICON[it.type] ?? '🔔'} <strong>{it.title}</strong>
                </span>
                <span style={{ color: 'var(--muted)' }}>{it.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** Newest-first, de-duplicated by title+detail, capped at 100. */
function dedupe(list: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];
  for (const it of [...list].sort((a, b) => b.ts - a.ts)) {
    const key = `${it.title}|${it.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out.slice(0, 100);
}
