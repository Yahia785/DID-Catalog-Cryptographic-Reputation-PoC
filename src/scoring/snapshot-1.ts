import chalk from 'chalk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseCsv } from '../shared/csv.js';
import { buildUrl, fetchJson, mailto, setRequestObserver, type RequestRecord } from '../shared/http.js';
import { VENUES } from '../venues/registry.js';
import {
  FAILED, SNAPSHOTS_ROOT, fileFor, rel, writeIndex,
  type SnapshotFailure, type SnapshotFile, type SourceDataMap, type SourceId, type SourceInfo, type VenueSlot,
} from './snapshot-store.js';

/**
 * npx tsx src/scoring/snapshot.ts --formula=1.0
 *
 * Collect exactly the inputs formula 1.0 needs for every venue in the registry, once, into
 * data/snapshots/f1-<date>/ (the name does not start with a digit, so `npm run score`, which
 * reads the newest 0.1-demo snapshot, never picks it up):
 *
 *   icore             rank by coreId (data/core.csv)
 *   scimago           SJR, quartile, h-index, citations/doc, categories by Sourceid (data/scimago.csv)
 *   openalex          h-index, citations, works, 2-yr mean citedness, works per year by OpenAlex id,
 *                     50 ids per request
 *   retraction-watch  retractions by rwMatch / rwExclude (data/retraction_watch.csv)
 *
 * A request that fails (after its retries) is never written as "venue not in source". Without
 * --allow-failures the run ends with exit code 1 and the list of failures, and no snapshot is
 * written; with it, those values are marked "failed" and listed in index.json under failures.
 *
 * Every request and every local file read is timed and saved to output/bench/collect-<ISO>.json
 * (benchmark 2: what collection costs). Request durations leave out the per-host politeness wait
 * and the wait before a retry; both are reported separately.
 *
 * Options: --dir=NAME (folder name, default f1-<date>)   --allow-failures
 */

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const BATCH = 50;
const OPENALEX_KEY = () => process.env.OPENALEX_API_KEY ?? '';
const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const num = (s: string | undefined) => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s.replace(',', '.'));   // SCImago uses decimal commas
  return Number.isFinite(n) ? n : null;
};

interface LocalFileBench { source: SourceId; file: string; bytes: number; parseMs: number; processMs: number; venuesQueried: number }
interface SourceWall { source: SourceId; wallMs: number }

export async function collectFormula1() {
  const today = new Date().toISOString().slice(0, 10);
  const dirName = arg('dir') ?? `f1-${today}`;
  const DIR = path.join(SNAPSHOTS_ROOT, dirName);
  const allowFailures = process.argv.includes('--allow-failures');
  const snapYear = Number(today.slice(0, 4));
  const YEARS = Array.from({ length: 10 }, (_, i) => snapYear - 10 + i);   // last 10 full years

  const requests: RequestRecord[] = [];
  const localFiles: LocalFileBench[] = [];
  const walls: SourceWall[] = [];
  const failures: SnapshotFailure[] = [];
  const files = new Map<SourceId, SnapshotFile<any>>();
  const runStart = performance.now();
  const startedAt = new Date().toISOString();
  setRequestObserver((r) => requests.push(r));

  console.log(chalk.bold(`\n=== DIDcal: snapshot for formula 1.0 → ${rel(DIR)} ===\n`));
  console.log(chalk.gray(`${VENUES.length} venues; OPENALEX_API_KEY ${OPENALEX_KEY() ? 'set' : 'NOT set'}, DIDCAL_MAILTO ${mailto() ? 'set' : 'NOT set'}\n`));

  /** Read a local CSV, timing the read + parse and hashing the bytes. */
  const readLocal = (source: SourceId, file: string, delim = ',') => {
    const t0 = performance.now();
    const buf = fs.readFileSync(file);
    const rows = parseCsv(buf.toString('utf8').replace(/^﻿/, ''), delim);
    const parseMs = performance.now() - t0;
    return { rows, buf, parseMs, info: (name: string, url: string, edition: string | undefined): SourceInfo => ({
      id: source, name, access: 'csv', url, edition, retrievedAt: fs.statSync(file).mtime.toISOString(), inputFile: file, sha256: sha256(buf), bytes: buf.length,
    }) };
  };
  const finishLocal = (source: SourceId, file: string, bytes: number, parseMs: number, t0: number, venuesQueried: number) => {
    const wallMs = performance.now() - t0;
    localFiles.push({ source, file, bytes, parseMs: round(parseMs, 2), processMs: round(wallMs - parseMs, 2), venuesQueried });
    walls.push({ source, wallMs });
  };
  const keep = <K extends SourceId>(id: K, source: SourceInfo, venues: Record<string, VenueSlot<SourceDataMap[K]>>) => {
    files.set(id, { source, years: YEARS, venues });
    const vals = Object.values(venues);
    console.log(chalk.green(`  ✓ ${id}`), chalk.gray(`${vals.filter((v) => v !== null && v !== FAILED).length} of ${vals.length} venues have data${vals.includes(FAILED) ? `, ${vals.filter((v) => v === FAILED).length} FAILED` : ''}`));
  };

  // ── ICORE ──
  {
    const t0 = performance.now();
    const file = 'data/core.csv';
    const { rows, buf, parseMs, info } = readLocal('icore', file);
    const venues: Record<string, VenueSlot<SourceDataMap['icore']>> = {};
    const byId = new Map(rows.map((r) => [r[0], r]));
    for (const v of VENUES.filter((x) => x.type === 'conference')) {
      const r = v.coreId ? byId.get(v.coreId) : undefined;
      venues[v.key] = r ? { coreId: r[0], title: r[1], acronym: r[2], edition: r[3], rank: r[4] } : null;
    }
    keep('icore', info('ICORE conference rankings (CSV export)', 'https://portal.core.edu.au/conf-ranks/', rows[0]?.[3]), venues);
    finishLocal('icore', file, buf.length, parseMs, t0, VENUES.filter((v) => v.coreId).length);
  }

  // ── SCImago ──
  {
    const t0 = performance.now();
    const file = 'data/scimago.csv';
    const { rows, buf, parseMs, info } = readLocal('scimago', file, ';');
    const h = rows[0].map((x) => x.trim());
    const c = (name: string) => h.findIndex((x) => x.toLowerCase() === name.toLowerCase());
    const [cId, cT, cS, cQ, cH, cD, cC, cCat] = [c('Sourceid'), c('Title'), c('SJR'), c('SJR Best Quartile'), c('H index'), c('Total Docs. (3years)'), c('Citations / Doc. (2years)'), c('Categories')];
    const edition = h.find((x) => /^Total Docs\. \(\d{4}\)$/.test(x))?.match(/\d{4}/)?.[0];
    const byId = new Map(rows.slice(1).map((r) => [r[cId], r]));
    const venues: Record<string, VenueSlot<SourceDataMap['scimago']>> = {};
    for (const v of VENUES) {
      const r = v.scimagoId ? byId.get(v.scimagoId) : undefined;
      venues[v.key] = r ? { sourceid: r[cId], title: r[cT], sjr: num(r[cS]), quartile: r[cQ], hIndex: num(r[cH]), totalDocs3y: num(r[cD]), citesPerDoc2y: num(r[cC]), categories: r[cCat] } : null;
    }
    keep('scimago', info('SCImago Journal Rank (CSV export)', 'https://www.scimagojr.com/journalrank.php', edition ? `SJR ${edition}` : undefined), venues);
    finishLocal('scimago', file, buf.length, parseMs, t0, VENUES.filter((v) => v.scimagoId).length);
  }

  // ── Retraction Watch ──
  {
    const t0 = performance.now();
    const file = 'data/retraction_watch.csv';
    const { rows, buf, parseMs, info } = readLocal('retraction-watch', file);
    const h = rows[0].map((x) => x.trim().toLowerCase());
    const [cJ, cN, cR, cD] = [h.indexOf('journal'), h.indexOf('retractionnature'), h.indexOf('reason'), h.indexOf('retractiondate')];
    const body = rows.slice(1);
    const venues: Record<string, VenueSlot<SourceDataMap['retraction-watch']>> = {};
    for (const v of VENUES) {
      if (!v.rwMatch) { venues[v.key] = null; continue; }
      const inc = new RegExp(v.rwMatch, 'i');
      const exc = v.rwExclude ? new RegExp(v.rwExclude, 'i') : null;
      const hits = body.filter((r) => inc.test(r[cJ] ?? '') && !(exc?.test(r[cJ] ?? '')));
      const byYear: Record<string, number> = {}, reasons: Record<string, number> = {};
      let retractions = 0;
      for (const r of hits) {
        if (/retraction/i.test(r[cN] ?? '')) retractions++;
        const y = (r[cD] ?? '').match(/(19|20)\d{2}/)?.[0];
        if (y) byYear[y] = (byYear[y] ?? 0) + 1;
        for (const x of (r[cR] ?? '').split(';').map((s) => s.replace(/^\+/, '').trim()).filter(Boolean)) reasons[x] = (reasons[x] ?? 0) + 1;
      }
      // Zero matches is recorded as zero records (the file was checked), not as missing
      venues[v.key] = { records: hits.length, retractions, byYear, topReasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5)) };
    }
    const fileDate = fs.statSync(file).mtime.toISOString().slice(0, 10);
    keep('retraction-watch', info('Retraction Watch database (CSV)', 'https://gitlab.com/crossref/retraction-watch-data', `file dated ${fileDate}`), venues);
    finishLocal('retraction-watch', file, buf.length, parseMs, t0, VENUES.filter((v) => v.rwMatch).length);
  }

  // ── OpenAlex: 50 ids per request ──
  {
    const t0 = performance.now();
    const retrievedAt = new Date().toISOString();
    const venues: Record<string, VenueSlot<SourceDataMap['openalex']>> = {};
    const asked = VENUES.filter((v) => v.openalexId);
    for (const v of VENUES) if (!v.openalexId) venues[v.key] = null;
    for (let i = 0; i < asked.length; i += BATCH) {
      const batch = asked.slice(i, i + BATCH);
      const url = buildUrl('https://api.openalex.org/sources', {
        filter: `openalex:${batch.map((v) => v.openalexId).join('|')}`, 'per-page': BATCH,
        select: 'id,display_name,works_count,cited_by_count,summary_stats,counts_by_year', mailto: mailto(), api_key: OPENALEX_KEY(),
      });
      const r = await fetchJson(url, { tag: { source: 'openalex', venues: batch.length } });
      if (r.status !== 'ok') {
        const reason = r.status === 'failed' ? r.reason : 'HTTP 404 for a batch request';
        for (const v of batch) { venues[v.key] = FAILED; failures.push({ source: 'openalex', venue: v.key, reason }); }
        console.log(chalk.red(`  ✗ openalex batch ${i / BATCH + 1}: ${reason}`));
        continue;
      }
      const byId = new Map<string, any>((r.data.results ?? []).map((s: any) => [String(s.id).replace('https://openalex.org/', ''), s]));
      for (const v of batch) {
        const s = byId.get(v.openalexId!);
        if (!s) { venues[v.key] = null; continue; }   // the request worked and OpenAlex does not return this id
        const worksByYear: Record<string, number> = {};
        for (const y of s.counts_by_year ?? []) if (YEARS.includes(y.year)) worksByYear[y.year] = y.works_count;
        venues[v.key] = {
          openalexId: v.openalexId, displayName: s.display_name, worksCount: s.works_count, citedByCount: s.cited_by_count,
          twoYrMeanCitedness: s.summary_stats?.['2yr_mean_citedness'] ?? null, hIndex: s.summary_stats?.h_index ?? null, worksByYear,
        };
      }
    }
    keep('openalex', { id: 'openalex', name: 'OpenAlex API (sources by id, 50 per request)', access: 'api', url: 'https://api.openalex.org/sources', retrievedAt }, venues);
    walls.push({ source: 'openalex', wallMs: performance.now() - t0 });
  }

  setRequestObserver(null);
  const wallMs = performance.now() - runStart;

  // ── benchmark ──
  const sourceOrder: SourceId[] = ['icore', 'scimago', 'retraction-watch', 'openalex'];
  const summary = sourceOrder.map((source) => {
    const reqs = requests.filter((r) => r.tag?.source === source);
    const local = localFiles.find((f) => f.source === source);
    const venuesQueried = local?.venuesQueried ?? reqs.reduce((n, r) => n + Number(r.tag?.venues ?? 0), 0);
    const requestMs = reqs.reduce((n, r) => n + r.durationMs, 0);
    const bytes = local ? local.bytes : reqs.reduce((n, r) => n + r.bytes, 0);
    const seconds = local ? (local.parseMs + local.processMs) / 1000 : requestMs / 1000;
    return {
      source, kind: local ? 'local file' : 'api', requests: reqs.length, venuesQueried,
      totalSeconds: round(seconds, 3), secondsPerVenue: venuesQueried ? round(seconds / venuesQueried, 4) : null,
      totalBytes: bytes, bytesPerVenue: venuesQueried ? Math.round(bytes / venuesQueried) : null,
      failedRequests: reqs.filter((r) => r.outcome === 'failed').length, notFound: reqs.filter((r) => r.outcome === 'not-found').length,
      retries: reqs.reduce((n, r) => n + (r.attempts - 1), 0),
      politenessWaitSeconds: round(reqs.reduce((n, r) => n + r.politenessWaitMs, 0) / 1000, 3),
      backoffWaitSeconds: round(reqs.reduce((n, r) => n + r.backoffMs, 0) / 1000, 3),
      wallSeconds: round((walls.find((w) => w.source === source)?.wallMs ?? 0) / 1000, 3),
    };
  });
  const bench = { startedAt, wallSeconds: round(wallMs / 1000, 3), mode: 'formula 1.0', venues: VENUES.length, allowFailures, summary, localFiles, requests, failures };
  fs.mkdirSync('output/bench', { recursive: true });
  const benchFile = `output/bench/collect-${startedAt.replace(/:/g, '-')}.json`;
  fs.writeFileSync(benchFile, JSON.stringify(bench, null, 1));

  console.log(chalk.bold('\nCollection cost (request durations exclude the politeness wait and retry backoff)'));
  const cols: [string, (s: (typeof summary)[number]) => string][] = [
    ['source', (s) => s.source], ['kind', (s) => s.kind], ['requests', (s) => String(s.requests)], ['venues', (s) => String(s.venuesQueried)],
    ['total s', (s) => String(s.totalSeconds)], ['s/venue', (s) => String(s.secondsPerVenue ?? '-')], ['total bytes', (s) => String(s.totalBytes)],
    ['bytes/venue', (s) => String(s.bytesPerVenue ?? '-')], ['failed', (s) => String(s.failedRequests)], ['retries', (s) => String(s.retries)],
    ['polite wait s', (s) => String(s.politenessWaitSeconds)], ['backoff s', (s) => String(s.backoffWaitSeconds)],
  ];
  const widths = cols.map(([h, f]) => Math.max(h.length, ...summary.map((s) => f(s).length)));
  console.log('  ' + cols.map(([h], i) => h.padEnd(widths[i])).join('  '));
  for (const s of summary) console.log('  ' + cols.map(([, f], i) => f(s).padEnd(widths[i])).join('  '));
  console.log(chalk.gray(`  whole run: ${round(wallMs / 1000, 2)} s wall time → ${benchFile}\n`));

  // ── failures: never saved as "no data" ──
  if (failures.length) {
    console.log(chalk.red(`${failures.length} value(s) failed to collect:`));
    for (const f of failures) console.log(chalk.red(`  ${f.source} / ${f.venue}: ${f.reason}`));
    if (!allowFailures) {
      console.log(chalk.red('\nNo snapshot written. Run again, or use --allow-failures to save them marked "failed".\n'));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.yellow('--allow-failures: saved as "failed" and listed in index.json under failures.\n'));
  }

  fs.mkdirSync(DIR, { recursive: true });
  for (const [id, file] of files) fs.writeFileSync(fileFor(DIR, id), JSON.stringify(file, null, 2));
  const index = writeIndex(DIR, { formula: '1.0', ...(failures.length ? { failures } : {}) });
  console.log(chalk.bold('Snapshot index'));
  for (const f of index.files) console.log(`  ${f.id.padEnd(17)} ${chalk.gray(f.file)}`);
  console.log();
}
