/**
 * Polite JSON fetching for public APIs: a minimum gap between requests to the
 * same host, and automatic retries when a host says it is busy (429/503/5xx),
 * sends an HTML page instead of data, or drops the connection.
 *
 * fetchJson tells "not found" (404: the thing does not exist) apart from "failed"
 * (the host could not be reached or kept refusing): a failure is never "no data".
 * getJson is the older, simpler form that returns null for both.
 */

// Load .env (OPENALEX_API_KEY, DIDCAL_MAILTO, S2_API_KEY) before anything reads process.env.
// Modules that import this file run their own top-level code after it, so they see the values too.
try { process.loadEnvFile('.env'); } catch {}

const MAILTO = process.env.DIDCAL_MAILTO ?? '';
const S2_KEY = process.env.S2_API_KEY ?? '';

const MIN_GAP_MS: Record<string, number> = {
  'api.semanticscholar.org': 1100,
  'api.crossref.org': 1000,
  'api.openalex.org': 200,
};
const lastRequestAt: Record<string, number> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  return url.toString();
}

export const mailto = () => MAILTO;

export type FetchResult =
  | { status: 'ok'; data: any; bytes: number }
  | { status: 'not-found' }
  | { status: 'failed'; reason: string };

/** One logical request (all its attempts), for benchmarks. */
export interface RequestRecord {
  url: string;
  host: string;
  tag?: Record<string, unknown>;   // whatever the caller passed in FetchOptions.tag (e.g. source, venues)
  startedAt: string;               // ISO time of the first attempt
  durationMs: number;              // time spent in the requests themselves (all attempts), without any waiting below
  politenessWaitMs: number;        // waiting for the per-host minimum gap
  backoffMs: number;               // waiting after a busy / failed attempt before retrying
  attempts: number;
  bytes: number;                   // response body of the final attempt (0 when none)
  outcome: 'ok' | 'not-found' | 'failed';
  reason?: string;
}

let observer: ((r: RequestRecord) => void) | null = null;
/** Get a RequestRecord for every fetchJson call (pass null to stop). */
export const setRequestObserver = (fn: ((r: RequestRecord) => void) | null) => { observer = fn; };

export interface FetchOptions { maxTries?: number; tag?: Record<string, unknown> }

export async function fetchJson(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const maxTries = opts.maxTries ?? 5;
  const host = new URL(url).host;
  const rec: RequestRecord = { url, host, tag: opts.tag, startedAt: new Date().toISOString(), durationMs: 0, politenessWaitMs: 0, backoffMs: 0, attempts: 0, bytes: 0, outcome: 'failed' };
  const done = (result: FetchResult): FetchResult => {
    rec.outcome = result.status;
    if (result.status === 'failed') rec.reason = result.reason;
    if (result.status === 'ok') rec.bytes = result.bytes;
    observer?.(rec);
    return result;
  };
  let reason = 'no attempt made';
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const wait = (lastRequestAt[host] ?? 0) + (MIN_GAP_MS[host] ?? 500) - Date.now();
    if (wait > 0) { await sleep(wait); rec.politenessWaitMs += wait; }
    lastRequestAt[host] = Date.now();
    const backoff = 5000 * 2 ** (attempt - 1);
    // no point waiting after the last attempt: nothing follows it
    const retryAfter = async (ms: number) => { if (attempt >= maxTries) return; await sleep(ms); rec.backoffMs += ms; };
    const t0 = performance.now();
    rec.attempts = attempt;
    try {
      const headers: Record<string, string> = { 'User-Agent': `didcal-poc (${MAILTO || 'no-email'})` };
      if (host === 'api.semanticscholar.org' && S2_KEY) headers['x-api-key'] = S2_KEY;
      const res = await fetch(url, { headers });
      if (res.status === 404) { rec.durationMs += performance.now() - t0; return done({ status: 'not-found' }); }
      if (res.status === 429 || res.status >= 500) {
        rec.durationMs += performance.now() - t0;
        reason = `HTTP ${res.status}`;
        const ra = Number(res.headers.get('retry-after'));
        await retryAfter(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff);
        continue;
      }
      if (!res.ok) { rec.durationMs += performance.now() - t0; return done({ status: 'failed', reason: `HTTP ${res.status}` }); }
      const text = await res.text();
      rec.durationMs += performance.now() - t0;
      if (text.trimStart().startsWith('<')) { reason = 'got an HTML page instead of JSON'; await retryAfter(backoff); continue; }
      return done({ status: 'ok', data: JSON.parse(text), bytes: Buffer.byteLength(text) });
    } catch (e) {
      rec.durationMs += performance.now() - t0;
      reason = e instanceof Error ? e.message : String(e);
      await retryAfter(backoff);
    }
  }
  return done({ status: 'failed', reason: `gave up after ${maxTries} tries: ${reason}` });
}

/** The simple form: the JSON, or null when the thing was not found OR the request failed. */
export async function getJson(url: string, maxTries = 5): Promise<any | null> {
  const r = await fetchJson(url, { maxTries });
  if (r.status === 'ok') return r.data;
  if (r.status === 'failed') console.warn(`  ! ${r.reason}: ${url}`);
  return null;
}
