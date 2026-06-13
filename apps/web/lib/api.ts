const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/** Server-side fetch helper with no caching (dashboard is realtime-ish). */
export async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

export const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
export const fmtPct = (n: number | null | undefined) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
export const short = (a?: string | null) =>
  !a ? '—' : a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
