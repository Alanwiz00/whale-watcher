import { prisma } from '@whale/db';

const usd = (n: number | null | undefined) =>
  n == null ? 'n/a' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (n: number | null | undefined) =>
  n == null ? 'n/a' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(0)}%`;

const TIER_EMOJI: Record<string, string> = { elite: '🐋', strong: '🦈', notable: '🐬', normal: '🐟' };

export async function recentWhales(limit = 10): Promise<string> {
  const rows = await prisma.whaleSignal.findMany({
    orderBy: { timestamp: 'desc' },
    take: limit,
    include: { market: { select: { title: true } }, wallet: { select: { address: true } } },
  });
  if (!rows.length) return 'No whale activity yet. Collectors may still be warming up. 🐳';
  return [
    '*🐋 Recent Whales*',
    ...rows.map((w) => {
      const e = TIER_EMOJI[w.tier] ?? '🐟';
      return `${e} *${usd(Number(w.sizeUsd))}* · score ${w.score} · ${w.platform}\n   ${trunc(w.market?.title)}`;
    }),
  ].join('\n');
}

export async function topWallets(limit = 10, by: 'roi' | 'volume' = 'roi'): Promise<string> {
  const rows = await prisma.walletStats.findMany({
    where: { trades: { gte: 3 } },
    orderBy: by === 'volume' ? { totalStakedUsd: 'desc' } : { roi: 'desc' },
    take: limit,
    include: { wallet: { select: { address: true, platform: true } } },
  });
  if (!rows.length) return 'No wallet stats computed yet.';
  return [
    `*🏆 Top Wallets by ${by === 'volume' ? 'Volume' : 'ROI'}*`,
    ...rows.map(
      (s, i) =>
        `${i + 1}. \`${short(s.wallet.address)}\` (${s.wallet.platform})\n   ROI ${pct(s.roi)} · staked ${usd(Number(s.totalStakedUsd))} · ${s.trades} trades`,
    ),
  ].join('\n');
}

export async function marketsSummary(team?: string): Promise<string> {
  const where = team ? { team: team.toLowerCase(), status: 'open' as const } : { status: 'open' as const };
  const [count, rows] = await Promise.all([
    prisma.market.count({ where }),
    prisma.market.findMany({ where, orderBy: { volumeUsd: 'desc' }, take: 10 }),
  ]);
  if (!rows.length) return team ? `No open markets found for *${team}*.` : 'No markets tracked yet.';
  return [
    `*📈 ${team ? team.toUpperCase() + ' ' : ''}World Cup Markets* (${count} open)`,
    ...rows.map((m) => `• ${trunc(m.title)}\n   ${m.platform} · vol ${usd(Number(m.volumeUsd))}`),
  ].join('\n');
}

export async function arbitrageSummary(limit = 10): Promise<string> {
  const rows = await prisma.arbitrageEvent.findMany({
    where: { resolvedAt: null },
    orderBy: { detectedAt: 'desc' },
    take: limit,
  });
  if (!rows.length) return 'No open arbitrage/mispricing opportunities right now.';
  return [
    '*⚖️ Arbitrage & Mispricing*',
    ...rows.map((a) => `• ${a.canonicalKey} — edge *${(a.edge * 100).toFixed(1)}%* (book ${(a.bookSum * 100).toFixed(1)}%)`),
  ].join('\n');
}

export async function overview(): Promise<string> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const [whales, alerts, markets, vol] = await Promise.all([
    prisma.whaleSignal.count({ where: { timestamp: { gte: start } } }),
    prisma.alert.count({ where: { createdAt: { gte: start } } }),
    prisma.market.count({ where: { status: 'open' } }),
    prisma.trade.aggregate({ where: { timestamp: { gte: start } }, _sum: { sizeUsd: true } }),
  ]);
  return [
    '*🌍 World Cup 2026 — WhaleWatcher*',
    `Whales today: *${whales}*`,
    `Volume today: *${usd(Number(vol._sum.sizeUsd ?? 0))}*`,
    `Markets tracked: *${markets}*`,
    `Alerts today: *${alerts}*`,
  ].join('\n');
}

export async function teamReport(team: string): Promise<string> {
  const markets = await prisma.market.findMany({
    where: { team: team.toLowerCase(), status: 'open' },
    select: { id: true },
  });
  const ids = markets.map((m) => m.id);
  const whales = ids.length
    ? await prisma.whaleSignal.findMany({
        where: { marketId: { in: ids } },
        orderBy: { timestamp: 'desc' },
        take: 5,
        include: { market: { select: { title: true } } },
      })
    : [];
  const head = await marketsSummary(team);
  if (!whales.length) return `${head}\n\n_No whale activity on ${team} markets yet._`;
  return [
    head,
    '',
    `*🐋 Recent ${team.toUpperCase()} whales*`,
    ...whales.map((w) => `• ${usd(Number(w.sizeUsd))} · score ${w.score} · ${trunc(w.market?.title)}`),
  ].join('\n');
}

function trunc(s?: string | null, n = 60): string {
  if (!s) return '(untitled)';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
