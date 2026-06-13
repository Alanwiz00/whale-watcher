'use client';

import { useEffect, useRef, useState } from 'react';

interface FeedItem {
  channel: string;
  title?: string;
  body?: string;
  ts: number;
}

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws';

export default function LivePage() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [connected, setConnected] = useState(false);
  const ref = useRef<WebSocket | null>(null);

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
          if (msg.channel === 'system') return;
          const d = msg.data ?? {};
          setItems((prev) =>
            [{ channel: msg.channel, title: d.title, body: d.body, ts: Date.now() }, ...prev].slice(0, 100),
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
        {connected ? 'Connected' : 'Reconnecting…'} · realtime whale, steam & arbitrage alerts
      </p>
      <div className="card">
        <h2>Realtime Whale Activity</h2>
        {items.length === 0 ? (
          <p className="empty">Waiting for events…</p>
        ) : (
          <div className="feed">
            {items.map((it, i) => (
              <div className="row" key={i}>
                <span className="chan">{it.channel.replace('ww:', '')}</span>
                <span>
                  <strong>{it.title ?? '(event)'}</strong>
                  {it.body ? ` — ${it.body.split('\n').join(' · ')}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
