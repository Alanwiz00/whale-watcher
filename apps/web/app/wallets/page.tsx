import { api, fmtPct, fmtUsd, short } from '../../lib/api';

export const dynamic = 'force-dynamic';

interface WalletRow {
  wallet: string;
  platform: string;
  trades: number;
  totalStakedUsd: number | null;
  roi: number;
  winRate: number;
  sharpe: number;
  whaleScoreAvg: number | null;
  rankRoi: number | null;
}

async function safe<T>(p: Promise<T>, f: T): Promise<T> {
  try {
    return await p;
  } catch {
    return f;
  }
}

export default async function WalletsPage() {
  const [byRoi, byVol] = await Promise.all([
    safe(api<WalletRow[]>('/api/wallets/top?by=roi&limit=25'), []),
    safe(api<WalletRow[]>('/api/wallets/top?by=volume&limit=25'), []),
  ]);

  return (
    <>
      <h1>Wallets</h1>
      <p className="sub">Smart-money leaderboard · ROI is mark-to-market until markets resolve</p>
      <Table title="Top by ROI" rows={byRoi} highlight="roi" />
      <Table title="Top by Volume" rows={byVol} highlight="volume" />
    </>
  );
}

function Table({ title, rows, highlight }: { title: string; rows: WalletRow[]; highlight: string }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="empty">No wallet stats yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Wallet</th>
              <th>Platform</th>
              <th className="num">Trades</th>
              <th className="num">Staked</th>
              <th className="num">ROI</th>
              <th className="num">Win%</th>
              <th className="num">Sharpe</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w, i) => (
              <tr key={w.wallet + w.platform}>
                <td>{i + 1}</td>
                <td className="mono">{short(w.wallet)}</td>
                <td>{w.platform}</td>
                <td className="num">{w.trades}</td>
                <td className={`num ${highlight === 'volume' ? 'gold' : ''}`}>{fmtUsd(w.totalStakedUsd)}</td>
                <td className={`num ${w.roi >= 0 ? 'green' : 'red'}`}>{fmtPct(w.roi)}</td>
                <td className="num">{(w.winRate * 100).toFixed(0)}%</td>
                <td className="num">{w.sharpe.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
