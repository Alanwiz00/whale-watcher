import { logger } from '@whale/core';

const log = logger.child({ svc: 'collectors', mod: 'http' });

export interface FetchJsonOpts {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/**
 * JSON fetch with timeout, bounded retries with exponential backoff + jitter,
 * and 429/5xx awareness. Returns parsed JSON typed as T.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOpts = {}): Promise<T> {
  const { timeoutMs = 12_000, retries = 3, headers = {}, query } = opts;
  const full = query ? `${url}${url.includes('?') ? '&' : '?'}${qs(query)}` : url;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(full, {
        headers: { accept: 'application/json', 'user-agent': 'WhaleWatcher/0.1', ...headers },
        signal: ac.signal,
      });
      if (!res.ok) {
        const body = await safeText(res);
        // Retry on transient statuses; bail on hard client errors.
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await backoff(attempt, res.headers.get('retry-after'));
          attempt++;
          continue;
        }
        throw new HttpError(res.status, full, body.slice(0, 500));
      }
      return (await res.json()) as T;
    } catch (err) {
      const transient =
        err instanceof HttpError === false && attempt < retries; // network/abort errors
      if (transient) {
        // Debug-level: these self-heal on retry, so they shouldn't spam logs.
        // `cause` surfaces the real reason (ECONNRESET / connect timeout / DNS).
        log.debug({ url: full, attempt, reason: causeOf(err) }, 'fetch retry');
        await backoff(attempt);
        attempt++;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function qs(query: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Extract the underlying cause of a `fetch failed` TypeError for diagnostics. */
function causeOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return cause.code;
    if (cause?.message) return cause.message;
    return err.message;
  }
  return String(err);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
  let ms = Math.min(1_000 * 2 ** attempt, 15_000);
  if (retryAfter) {
    const ra = Number(retryAfter);
    if (Number.isFinite(ra)) ms = Math.max(ms, ra * 1000);
  }
  await new Promise((r) => setTimeout(r, ms + Math.random() * 250));
}
