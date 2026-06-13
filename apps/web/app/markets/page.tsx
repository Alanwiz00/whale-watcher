import { api, fmtUsd } from '../../lib/api';

export const dynamic = 'force-dynamic';

interface MarketRow {
  id: string;
  platform: string;
  title: string;
  eventType: string;
  team: string | null;
  status: string;
  volumeUsd: number | null;
  liquidityUsd: number | null;
}

async function safe<T>(p: Promise<T>, f: T): Promise<T> {
  try {
    return await p;
  } catch {
    return f;
  }
}

export default async function MarketsPage() {
  const markets = await safe(api<MarketRow[]>('/api/markets?limit=200'), []);
  return (
    <>
      <h1>Markets</h1>
      <p className="sub">{markets.length} World Cup 2026 markets tracked across platforms</p>
      <div className="card">
        <h2>Tracked Markets</h2>
        {markets.length === 0 ? (
          <p className="empty">No markets discovered yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Platform</th>
                <th>Type</th>
                <th>Team</th>
                <th className="num">Volume</th>
                <th className="num">Liquidity</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td>{m.platform}</td>
                  <td>{m.eventType}</td>
                  <td>{m.team ?? '—'}</td>
                  <td className="num gold">{fmtUsd(m.volumeUsd)}</td>
                  <td className="num">{fmtUsd(m.liquidityUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
