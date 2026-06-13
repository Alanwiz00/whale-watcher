import { api, fmtPct, fmtUsd, short } from '../lib/api';

export const dynamic = 'force-dynamic';

interface Overview {
  whalesToday: number;
  alertsToday: number;
  marketsTracked: number;
  volumeTodayUsd: number | null;
  topWhaleScore: number | null;
}
interface Whale {
  id: string;
  platform: string;
  market?: string;
  wallet: string | null;
  walletRoi: number | null;
  side: string;
  sizeUsd: number | null;
  score: number;
  tier: string;
  marketImpactPct: number | null;
  timestamp: string;
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export default async function OverviewPage() {
  const [ov, whales] = await Promise.all([
    safe(api<Overview>('/api/overview'), {
      whalesToday: 0,
      alertsToday: 0,
      marketsTracked: 0,
      volumeTodayUsd: 0,
      topWhaleScore: null,
    }),
    safe(api<Whale[]>('/api/whales?limit=15'), []),
  ]);

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">World Cup 2026 whale & smart-money activity · today (UTC)</p>

      <div className="kpis">
        <Kpi label="Whales Today" value={ov.whalesToday.toString()} />
        <Kpi label="Volume Today" value={fmtUsd(ov.volumeTodayUsd)} />
        <Kpi label="Markets Tracked" value={ov.marketsTracked.toString()} />
        <Kpi label="Alerts Today" value={ov.alertsToday.toString()} />
        <Kpi label="Top Whale Score" value={ov.topWhaleScore?.toString() ?? '—'} />
      </div>

      <div className="card">
        <h2>Recent Whale Activity</h2>
        {whales.length === 0 ? (
          <p className="empty">No whale signals yet — collectors may still be warming up.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Tier</th>
                <th>Platform</th>
                <th>Market</th>
                <th>Wallet</th>
                <th className="num">ROI</th>
                <th className="num">Size</th>
                <th className="num">Impact</th>
                <th className="num">Score</th>
              </tr>
            </thead>
            <tbody>
              {whales.map((w) => (
                <tr key={w.id}>
                  <td>
                    <span className={`badge ${w.tier}`}>{w.tier}</span>
                  </td>
                  <td>{w.platform}</td>
                  <td>{w.market ?? '—'}</td>
                  <td className="mono">{short(w.wallet)}</td>
                  <td className={`num ${(w.walletRoi ?? 0) >= 0 ? 'green' : 'red'}`}>
                    {fmtPct(w.walletRoi)}
                  </td>
                  <td className="num gold">{fmtUsd(w.sizeUsd)}</td>
                  <td className="num">{fmtPct(w.marketImpactPct)}</td>
                  <td className="num">{w.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
