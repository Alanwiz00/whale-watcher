import { api } from '../../lib/api';

export const dynamic = 'force-dynamic';

interface ArbLeg {
  platform: string;
  outcome: string;
  impliedProb: number;
}
interface ArbEvent {
  id: string;
  canonicalKey: string;
  edge: number;
  bookSum: number;
  legs: ArbLeg[];
  detectedAt: string;
}

async function safe<T>(p: Promise<T>, f: T): Promise<T> {
  try {
    return await p;
  } catch {
    return f;
  }
}

export default async function ArbitragePage() {
  const arbs = await safe(api<ArbEvent[]>('/api/arbitrage?limit=50'), []);
  return (
    <>
      <h1>Arbitrage</h1>
      <p className="sub">Cross-platform edges & mispricing on linked World Cup markets</p>
      <div className="card">
        <h2>Current Opportunities</h2>
        {arbs.length === 0 ? (
          <p className="empty">No open opportunities. Needs ≥2 venues quoting the same market.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th className="num">Book Sum</th>
                <th className="num">Edge</th>
                <th>Best Legs</th>
                <th>Detected</th>
              </tr>
            </thead>
            <tbody>
              {arbs.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.canonicalKey}</td>
                  <td className="num">{(a.bookSum * 100).toFixed(1)}%</td>
                  <td className="num green">{(a.edge * 100).toFixed(1)}%</td>
                  <td>
                    {(a.legs ?? [])
                      .slice(0, 4)
                      .map((l) => `${l.outcome}@${l.platform}`)
                      .join(', ')}
                  </td>
                  <td>{new Date(a.detectedAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
