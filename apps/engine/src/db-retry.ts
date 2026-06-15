import { logger } from '@whale/core';

const log = logger.child({ svc: 'engine', mod: 'db-retry' });

/**
 * Prisma error codes for *transient* connectivity problems (not data errors):
 *   P1001 can't reach DB · P1002 reached but timed out · P1008 op timed out ·
 *   P1017 server closed the connection.
 * On WSL2 / docker, idle pooled connections get dropped by the port-forward;
 * the next query fails with one of these, then reconnects. Retrying absorbs it.
 */
const TRANSIENT_DB_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code != null && TRANSIENT_DB_CODES.has(code);
}

/**
 * Run `fn`, retrying on transient DB-connection errors with short backoff. The
 * worker bodies are idempotent (upserts / ON CONFLICT DO NOTHING), so re-running
 * after a dropped connection is safe.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      log.warn({ code: (err as { code?: string }).code, attempt: i + 1 }, 'transient DB error — retrying');
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}
