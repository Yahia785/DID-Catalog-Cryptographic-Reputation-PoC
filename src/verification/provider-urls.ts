import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Where the provider files come from, and a polite downloader. Used by the snapshot (to pin Retraction
 * Watch to a commit) and by fetch-sources.ts (the helper that fetches the files for a reader).
 */

export const RW_PROJECT = 'crossref/retraction-watch-data';
export const RW_API = 'https://gitlab.com/api/v4/projects/crossref%2Fretraction-watch-data';
/** The Retraction Watch CSV exactly as it was at one commit of the Crossref repository. */
export const rwRawUrl = (commit: string) => `https://gitlab.com/${RW_PROJECT}/-/raw/${commit}/retraction_watch.csv`;
/** The ICORE portal's CSV export of one edition ("ICORE2026"), all ranks. */
export const icoreExportUrl = (edition: string) => `https://portal.core.edu.au/conf-ranks/?search=&by=all&source=${encodeURIComponent(edition)}&page=1&do=Export`;
export const SCIMAGO_PAGE = 'https://www.scimagojr.com/journalrank.php';

export interface Download { url: string; file: string; bytes: number; ms: number; sha256: string; status: number; attempts: number }

/** Download a URL to a file; waits and retries when the host says it is busy (429/503). The timing is the transfer only. */
export async function downloadTo(url: string, file: string, maxTries = 4): Promise<Download> {
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const t0 = performance.now();
    const res = await fetch(url, { headers: { 'User-Agent': 'didcal-poc' } });
    if (res.status === 429 || res.status === 503) {
      const wait = Number(res.headers.get('retry-after'));
      await res.arrayBuffer();
      await new Promise((r) => setTimeout(r, (Number.isFinite(wait) && wait > 0 ? wait : 30) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = performance.now() - t0;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return { url, file, bytes: buf.length, ms, sha256: crypto.createHash('sha256').update(buf).digest('hex'), status: res.status, attempts: attempt };
  }
  throw new Error(`${url} stayed busy after ${maxTries} tries`);
}
