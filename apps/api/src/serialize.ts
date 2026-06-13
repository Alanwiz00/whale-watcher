import type { Prisma } from '@whale/db';

/** Prisma Decimal | null → number | null for clean JSON. */
export function dec(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v.toString());
}

/** Parse a positive integer query param with a default + hard cap. */
export function intParam(v: unknown, def: number, max = 500): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
