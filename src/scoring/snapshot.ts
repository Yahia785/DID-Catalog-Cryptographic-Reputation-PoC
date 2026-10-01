import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../shared/csv.js';
import { buildUrl, getJson, mailto } from '../shared/http.js';
import { VENUES, type VenueEntry } from '../venues/registry.js';
import {
  ALL_SOURCES, SNAPSHOTS_ROOT, fileFor, rel, writeIndex,
  type SnapshotFile, type SourceDataMap, type SourceId, type SourceInfo,
} from './snapshot-store.js';

/**
 * npm run snapshot
 *
 * Fetch every input the scoring formula needs, once, and freeze it into
 * data/snapshots/<date>/ (one JSON file per source + index.json with hashes).
 *
 * Options:
 *   --sources=icore,scimago,retraction-watch,openalex,crossref,s2   (default: all)
 *   --reuse       keep source files that already exist in today's folder (resume after a failure)
 *   --dir=NAME    folder name instead of today's date
 *
 * Needs the three downloaded CSVs in data/: core.csv, scimago.csv, retraction_watch.csv
 */

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const today = new Date().toISOString().slice(0, 10);
const DIR = path.join(SNAPSHOTS_ROOT, arg('dir') ?? today);
const REUSE = process.argv.includes('--reuse');
const SELECTED = (arg('sources')?.split(',') ?? ALL_SOURCES) as SourceId[];

// Last 10 full years before the snapshot year
const snapYear = Number((arg('dir') ?? today).slice(0, 4));
const YEARS = Array.from({ length: 10 }, (_, i) => snapYear - 10 + i);
const COHORT_YEAR = snapYear - 3; // papers old enough to have collected citations

const nowIso = () => new Date().toISOString();
const num = (s: string | undefined) => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s.replace(',', '.'));  // SCImago uses decimal commas
  return Number.isFinite(n) ? n : null;
};

function write<K extends SourceId>(id: K, source: SourceInfo, venues: Record<string, SourceDataMap[K] | null>) {
  const file: SnapshotFile<SourceDataMap[K]> = { source, years: YEARS, venues };
  fs.writeFileSync(fileFor(DIR, id), JSON.stringify(file, null, 2));
  const found = Object.values(venues).filter((v) => v !== null).length;
  console.log(chalk.green(`  ✓ ${id}`), chalk.gray(`${found}/${Object.keys(venues).length} venues found → ${rel(fileFor(DIR, id))}`));
}

function csvSource(id: SourceId, name: string, url: string, file: string, edition?: string): SourceInfo {
  return { id, name, access: 'csv', url, edition, retrievedAt: fs.statSync(file).mtime.toISOString(), inputFile: file };
}

// ── ICORE (conferences) ──────────────────────────────────────
function snapIcore() {
  const file = 'data/core.csv';
  const rows = readCsv(file);
  // No header row: id, title, acronym, edition, rank, ...
  const edition = rows[0]?.[3] ?? '';
  const venues: Record<string, SourceDataMap['icore'] | null> = {};
  for (const v of VENUES.filter((x) => x.type === 'conference')) {
    const r = v.coreId ? rows.find((row) => row[0] === v.coreId) : undefined;
    venues[v.key] = r ? { coreId: r[0], title: r[1], acronym: r[2], edition: r[3], rank: r[4] } : null;
  }
  write('icore', csvSource('icore', 'ICORE conference rankings (CSV export)', 'https://portal.core.edu.au/conf-ranks/', file, edition), venues);
}

// ── SCImago (journals) ───────────────────────────────────────
function snapScimago() {
  const file = 'data/scimago.csv';
  const rows = readCsv(file, ';');
  const h = rows[0].map((x) => x.trim());
  const c = (name: string) => h.findIndex((x) => x.toLowerCase() === name.toLowerCase());
  const [cT, cI, cS, cQ, cH, cD, cC] = [c('Title'), c('Issn'), c('SJR'), c('SJR Best Quartile'), c('H index'), c('Total Docs. (3years)'), c('Citations / Doc. (2years)')];
  const edition = h.find((x) => /^Total Docs\. \(\d{4}\)$/.test(x))?.match(/\d{4}/)?.[0];
  const venues: Record<string, SourceDataMap['scimago'] | null> = {};
  for (const v of VENUES.filter((x) => x.type === 'journal')) {
    const r = v.issn ? rows.slice(1).find((row) => (row[cI] ?? '').includes(v.issn!.replace('-', ''))) : undefined;
    venues[v.key] = r ? { title: r[cT], sjr: num(r[cS]), quartile: r[cQ], hIndex: num(r[cH]), totalDocs3y: num(r[cD]), citesPerDoc2y: num(r[cC]) } : null;
  }
  write('scimago', csvSource('scimago', 'SCImago Journal Rank (CSV export)', 'https://www.scimagojr.com/journalrank.php', file, edition ? `SJR ${edition}` : undefined), venues);
}

// ── Retraction Watch (all venues) ────────────────────────────
function snapRetractionWatch() {
  const file = 'data/retraction_watch.csv';
  const rows = readCsv(file);
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const [cJ, cN, cR, cD] = [h.indexOf('journal'), h.indexOf('retractionnature'), h.indexOf('reason'), h.indexOf('retractiondate')];
  const body = rows.slice(1);
  const venues: Record<string, SourceDataMap['retraction-watch'] | null> = {};
  for (const v of VENUES) {
    if (!v.rwMatch) { venues[v.key] = null; continue; }
    const inc = new RegExp(v.rwMatch, 'i');
    const exc = v.rwExclude ? new RegExp(v.rwExclude, 'i') : null;
    const hits = body.filter((r) => inc.test(r[cJ] ?? '') && !(exc?.test(r[cJ] ?? '')));
    const byYear: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    let retractions = 0;
    for (const r of hits) {
      if (/retraction/i.test(r[cN] ?? '')) retractions++;
      const y = (r[cD] ?? '').match(/(19|20)\d{2}/)?.[0];
      if (y) byYear[y] = (byYear[y] ?? 0) + 1;
      for (const x of (r[cR] ?? '').split(';').map((s) => s.replace(/^\+/, '').trim()).filter(Boolean)) reasons[x] = (reasons[x] ?? 0) + 1;
    }
    const topReasons = Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5));
    // Zero matches is recorded as zero records (the file was checked), not as missing
    venues[v.key] = { records: hits.length, retractions, byYear, topReasons };
  }
  write('retraction-watch', csvSource('retraction-watch', 'Retraction Watch database (CSV)', 'https://gitlab.com/crossref/retraction-watch-data', file), venues);
}

// ── OpenAlex (journals) ──────────────────────────────────────
async function snapOpenAlex() {
  const retrievedAt = nowIso();
  const venues: Record<string, SourceDataMap['openalex'] | null> = {};
  for (const v of VENUES.filter((x) => x.type === 'journal')) {
    const s = await getJson(buildUrl(`https://api.openalex.org/sources/issn:${v.issn}`, { mailto: mailto(), api_key: process.env.OPENALEX_API_KEY }));
    if (!s) { venues[v.key] = null; continue; }
    const worksByYear: Record<string, number> = {};
    for (const y of s.counts_by_year ?? []) if (YEARS.includes(y.year)) worksByYear[y.year] = y.works_count;
    venues[v.key] = {
      worksCount: s.works_count, citedByCount: s.cited_by_count,
      twoYrMeanCitedness: s.summary_stats?.['2yr_mean_citedness'] ?? null, hIndex: s.summary_stats?.h_index ?? null, worksByYear,
    };
  }
  write('openalex', { id: 'openalex', name: 'OpenAlex API (sources by ISSN)', access: 'api', url: 'https://api.openalex.org/sources', retrievedAt }, venues);
}

// ── Crossref (journals) ──────────────────────────────────────
async function snapCrossref() {
  const retrievedAt = nowIso();
  const venues: Record<string, SourceDataMap['crossref'] | null> = {};
  for (const v of VENUES.filter((x) => x.type === 'journal')) {
    const j = await getJson(buildUrl(`https://api.crossref.org/journals/${v.issn}`, { mailto: mailto() }));
    const r = await getJson(buildUrl('https://api.crossref.org/works', { filter: `issn:${v.issn},update-type:retraction`, rows: 0, mailto: mailto() }));
    if (!j && !r) { venues[v.key] = null; continue; }
    const doisByYear: Record<string, number> = {};
    for (const [y, n] of j?.message?.breakdowns?.['dois-by-issued-year'] ?? []) if (YEARS.includes(y)) doisByYear[y] = n;
    venues[v.key] = { totalDois: j?.message?.counts?.['total-dois'] ?? null, doisByYear, retractionNotices: r?.message?.['total-results'] ?? null };
  }
  write('crossref', { id: 'crossref', name: 'Crossref REST API (journals by ISSN)', access: 'api', url: 'https://api.crossref.org', retrievedAt }, venues);
}

// ── Semantic Scholar (all venues with a known S2 name) ───────
async function snapS2() {
  const retrievedAt = nowIso();
  const BULK = 'https://api.semanticscholar.org/graph/v1/paper/search/bulk';
  const venues: Record<string, SourceDataMap['s2'] | null> = {};
  for (const v of VENUES) {
    if (!v.s2Venue) { venues[v.key] = null; continue; }
    process.stdout.write(chalk.gray(`    s2 ${v.key}…`));
    const papersByYear: Record<string, number> = {};
    for (const y of YEARS) {
      const d = await getJson(buildUrl(BULK, { venue: v.s2Venue, year: y, fields: 'year' }));
      if (d) papersByYear[y] = Number(d.total ?? 0);
    }
    if (Object.values(papersByYear).every((n) => n === 0)) { venues[v.key] = null; console.log(' not found'); continue; }
    let token: string | undefined, cohortPapers = 0, cohortCitations = 0;
    do {
      const d = await getJson(buildUrl(BULK, { venue: v.s2Venue, year: COHORT_YEAR, fields: 'citationCount', token }));
      if (!d) break;
      for (const p of d.data ?? []) { cohortPapers++; cohortCitations += p.citationCount ?? 0; }
      token = d.token ?? undefined;
    } while (token);
    venues[v.key] = { venueName: v.s2Venue, papersByYear, cohortYear: COHORT_YEAR, cohortPapers, cohortCitations };
    console.log(' done');
  }
  write('s2', { id: 's2', name: 'Semantic Scholar Graph API (bulk search by venue)', access: 'api', url: 'https://api.semanticscholar.org/graph/v1/paper/search/bulk', retrievedAt }, venues);
}

const RUNNERS: Record<SourceId, () => void | Promise<void>> = {
  icore: snapIcore, scimago: snapScimago, 'retraction-watch': snapRetractionWatch,
  openalex: snapOpenAlex, crossref: snapCrossref, s2: snapS2,
};

async function main() {
  console.log(chalk.bold(`\n=== DIDcal: data snapshot → ${rel(DIR)} ===\n`));
  fs.mkdirSync(DIR, { recursive: true });
  for (const id of SELECTED) {
    if (REUSE && fs.existsSync(fileFor(DIR, id))) { console.log(chalk.gray(`  • ${id}: kept existing file`)); continue; }
    try {
      await RUNNERS[id]();
    } catch (e) {
      console.log(chalk.red(`  ✗ ${id}: ${e instanceof Error ? e.message : e}`));
    }
  }
  const index = writeIndex(DIR);
  console.log(chalk.bold('\nSnapshot index'));
  for (const f of index.files) console.log(`  ${f.id.padEnd(17)} ${chalk.gray(f.file)}`);
  console.log(chalk.gray(`\nSaved ${rel(path.join(DIR, 'index.json'))}. Next: npm run score\n`));
}

main().catch((e) => { console.error(e); process.exit(1); });
