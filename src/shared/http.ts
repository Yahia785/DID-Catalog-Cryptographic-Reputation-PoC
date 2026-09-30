/**
 * Polite JSON fetching for public APIs: a minimum gap between requests to the
 * same host, and automatic retries when a host says it is busy (429/503),
 * sends an HTML page instead of data, or drops the connection.
 */

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

export async function getJson(url: string, maxTries = 5): Promise<any | null> {
  const host = new URL(url).host;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const wait = (lastRequestAt[host] ?? 0) + (MIN_GAP_MS[host] ?? 500) - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt[host] = Date.now();
    const backoff = 5000 * 2 ** (attempt - 1);
    try {
      const headers: Record<string, string> = { 'User-Agent': `didcal-poc (${MAILTO || 'no-email'})` };
      if (host === 'api.semanticscholar.org' && S2_KEY) headers['x-api-key'] = S2_KEY;
      const res = await fetch(url, { headers });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff);
        continue;
      }
      if (!res.ok) { console.warn(`  ! HTTP ${res.status}: ${url}`); return null; }
      const text = await res.text();
      if (text.trimStart().startsWith('<')) { await sleep(backoff); continue; }
      return JSON.parse(text);
    } catch {
      await sleep(backoff);
    }
  }
  console.warn(`  ! gave up: ${url}`);
  return null;
}
