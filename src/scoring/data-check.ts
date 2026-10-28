/**
 * Read-only data check: can the adopted scoring methods be computed from open data?
 *   Conferences: GGS-style rating (ICORE class + h-index rank + citations per paper)
 *   Journals:    Polish ministry method (percentile of SJR and of OpenAlex 2yr mean citedness)
 *
 * Populations are defined from the downloaded files (SCImago, ICORE), not from OpenAlex's field filter.
 * Writes raw data to output/data-check/ and a summary to
 * output/data-check/report-<YYYY-MM-DD>.md (also printed).
 *
 * Run: npx tsx src/scoring/data-check.ts
 * Optional env vars: DIDCAL_MAILTO, OPENALEX_API_KEY, S2_API_KEY
 */
import fs from 'node:fs';
import { buildUrl, getJson, mailto } from '../shared/http.js';
import { readCsv } from '../shared/csv.js';
import { VENUES } from '../venues/registry.js';

const OPENALEX_KEY = process.env.OPENALEX_API_KEY ?? '';
const S2_KEY = process.env.S2_API_KEY ?? '';
const OUT_DIR = 'output/data-check';
const TODAY = new Date().toISOString().slice(0, 10);
const RUN_START = Date.now();
const PART1B_BUDGET_MS = 15 * 60 * 1000;
const PART4_BUDGET_MS = 15 * 60 * 1000;

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── report + request accounting ──────────────────────────────
const lines: string[] = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const h = (s: string) => out(`\n${s}`);

const stats: Record<string, { ok: number; failed: number }> = {};
/** getJson wrapper: every null counts as a failed request for that source. */
async function get(source: string, url: string): Promise<any | null> {
  const s = (stats[source] ??= { ok: 0, failed: 0 });
  const r = await getJson(url);
  if (r === null) s.failed++; else s.ok++;
  return r;
}

const saveRaw = (file: string, data: unknown) =>
  fs.writeFileSync(`${OUT_DIR}/${file}`, JSON.stringify(data, null, 1));

// ── stats helpers ────────────────────────────────────────────
/** 100 × (strictly lower + 0.5 × ties) / N. Ties include the venue itself if it is in the population. */
function percentileRank(value: number, pop: number[]): number {
  let lower = 0, ties = 0;
  for (const v of pop) { if (v < value) lower++; else if (v === value) ties++; }
  return (100 * (lower + 0.5 * ties)) / pop.length;
}
/** Value at percentile p: the smallest population value whose percentile rank is >= p. */
function valueAtPercentile(pop: number[], p: number): number {
  const s = [...pop].sort((a, b) => a - b);
  for (const v of s) if (percentileRank(v, s) >= p) return v;
  return s[s.length - 1];
}
const fmt = (x: number | undefined | null, d = 2) => (x === undefined || x === null || Number.isNaN(x) ? 'n/a' : x.toFixed(d));
const num = (s: string) => Number(s.replace(',', '.'));
const normIssn = (s: string) => s.replace(/[^0-9Xx]/g, '').toUpperCase();
const dashIssn = (n: string) => `${n.slice(0, 4)}-${n.slice(4)}`;
const oaId = (id: string) => id.replace('https://openalex.org/', '');

/** Seeded PRNG (mulberry32) so the conference sample is reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'international', 'annual'].includes(w)));
function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

// ── OpenAlex helpers ─────────────────────────────────────────
interface OaSource {
  id: string; display_name: string; type?: string; issn_l?: string | null; issn?: string[] | null;
  works_count: number; cited_by_count: number;
  summary_stats?: { h_index?: number; '2yr_mean_citedness'?: number; i10_index?: number };
}
const SELECT = 'id,display_name,issn,issn_l,works_count,cited_by_count,summary_stats';
/** Every OpenAlex request carries mailto and api_key (each omitted if unset). */
const oa = (path: string, params: Record<string, string | number | undefined>) =>
  buildUrl(`https://api.openalex.org/${path}`, { mailto: mailto(), api_key: OPENALEX_KEY, ...params });
const hOf = (s: OaSource) => s.summary_stats?.h_index ?? 0;
const citedness = (s: OaSource) => s.summary_stats?.['2yr_mean_citedness'] ?? 0;

// ── Part 1A: journals (SCImago CS journals → OpenAlex by ISSN) ─
async function part1A() {
  h('### 1A. Journals: SCImago Computer Science journals looked up in OpenAlex');
  const rows = readCsv('data/scimago.csv', ';');
  const hd = rows[0];
  const iType = hd.indexOf('Type'), iAreas = hd.indexOf('Areas'), iIssn = hd.indexOf('Issn'), iTitle = hd.indexOf('Title'), iId = hd.indexOf('Sourceid');
  const pop = rows.slice(1)
    .filter((r) => r[iType] === 'journal' && (r[iAreas] ?? '').includes('Computer Science'))
    .map((r) => ({ sourceid: r[iId], title: r[iTitle], issns: (r[iIssn] ?? '').split(',').map(normIssn).filter((i) => i.length === 8), oa: null as OaSource | null }));
  out(`- population: ${pop.length} SCImago journals with Areas containing "Computer Science" (expected 2,189)`);

  const issnToRow = new Map<string, number>();
  pop.forEach((p, i) => p.issns.forEach((n) => { if (!issnToRow.has(n)) issnToRow.set(n, i); }));
  const allIssns = [...issnToRow.keys()];
  let failedBatches = 0, batches = 0;
  for (let i = 0; i < allIssns.length; i += 50) {
    const batch = allIssns.slice(i, i + 50);
    batches++;
    const r = await get('openalex', oa('sources', { filter: `issn:${batch.map(dashIssn).join('|')}`, 'per-page': 200, select: SELECT }));
    if (r === null) { failedBatches++; continue; }
    for (const s of r.results ?? [] as OaSource[]) {
      for (const n of [s.issn_l, ...(s.issn ?? [])]) {
        const ri = n ? issnToRow.get(normIssn(n)) : undefined;
        if (ri !== undefined && !pop[ri].oa) pop[ri].oa = s;
      }
    }
  }
  const matched = pop.filter((p) => p.oa);
  const withStats = matched.filter((p) => p.oa!.summary_stats?.['2yr_mean_citedness'] !== undefined);
  out(`- ${batches} batches of up to 50 ISSNs (${failedBatches} failed). Matched in OpenAlex: ${matched.length} / ${pop.length} (${fmt((100 * matched.length) / pop.length, 1)}%); with 2yr_mean_citedness: ${withStats.length}`);
  saveRaw('openalex-scimago-cs-journals.json', { retrieved: TODAY, failedBatches, journals: pop });

  const cvals = withStats.map((p) => citedness(p.oa!));
  if (cvals.length) {
    out('\n| percentile | 2yr_mean_citedness |\n|---|---|');
    for (const p of [97, 90, 75, 50, 25]) out(`| ${p} | ${fmt(valueAtPercentile(cvals, p), 3)} |`);
  }

  out('\n| journal | source | OA id | 2yr_mean_citedness | percentile rank vs population |\n|---|---|---|---|---|');
  for (const v of VENUES.filter((x) => x.type === 'journal' && x.issn)) {
    const want = normIssn(v.issn!);
    const row = pop.find((p) => p.issns.includes(want));
    let src = row?.oa ?? null, how = row ? (src ? 'in population' : 'in SCImago set, no OpenAlex match') : 'not in SCImago CS set';
    if (!src) {
      const r = await get('openalex', oa(`sources/issn:${v.issn}`, { select: SELECT }));
      if (r) { src = r; how += ', fetched directly'; }
    }
    out(src
      ? `| ${v.key} | ${how} | ${oaId(src.id)} | ${fmt(citedness(src), 3)} | ${fmt(percentileRank(citedness(src), cvals), 1)} |`
      : `| ${v.key} | ${how} | not found | | |`);
  }
}

// ── Part 1B / 4 shared: ICORE population and conference sample ─
interface Conf { key?: string; icoreId?: string; title: string; acronym: string; rank: string; ours: boolean }
let icorePopulation = 0;
let sample: Conf[] = [];
const bestHit: Record<string, OaSource | undefined> = {};   // sample index → best OpenAlex hit

function buildSample() {
  const rows = readCsv('data/core.csv');
  const pop = rows.filter((r) => !/journal published/i.test(r[4] ?? ''));
  icorePopulation = pop.length;
  const ours: Conf[] = VENUES.filter((v) => v.type === 'conference').map((v) => {
    const r = v.coreId ? rows.find((x) => x[0] === v.coreId) : undefined;
    return { key: v.key, icoreId: v.coreId, title: r?.[1] ?? v.name, acronym: r?.[2] ?? v.key, rank: r?.[4] ?? 'n/a (not in ICORE)', ours: true };
  });
  const ourIds = new Set(ours.map((o) => o.icoreId).filter(Boolean));
  const rand = rng(42);
  const pick = (ranks: string[]) => {
    const cand = pop.filter((r) => ranks.includes(r[4]) && !ourIds.has(r[0]));
    for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
    return cand.slice(0, 10).map((r): Conf => ({ icoreId: r[0], title: r[1], acronym: r[2], rank: r[4], ours: false }));
  };
  const hi = pick(['A*', 'A']), lo = pick(['B', 'C']);
  const others: Conf[] = [];
  for (let i = 0; i < 10; i++) others.push(hi[i], lo[i]);   // interleaved so a time cap still covers both groups
  sample = [...ours, ...others.filter(Boolean)];
}

// ── Part 1B: conferences ─────────────────────────────────────
async function part1B() {
  h('### 1B. Conferences: ICORE population and OpenAlex source structure');
  out(`- population: ${icorePopulation} ICORE rows (rows with rank containing "journal published" excluded)`);
  out(`- sample: ${sample.length} conferences = ${sample.filter((c) => c.ours).length} ours + ${sample.filter((c) => !c.ours).length} random (seed 42; 10 from A*/A, 10 from B/C)`);
  const deadline = Date.now() + PART1B_BUDGET_MS;
  let done = 0;
  const rawSample: unknown[] = [];
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (Date.now() > deadline) { out(`\n! Part 1B time cap hit after ${done}/${sample.length} conferences`); break; }
    out(`\n**${c.key ?? c.acronym}** — ${c.title} (ICORE ${c.icoreId ?? 'n/a'}, rank ${c.rank})`);
    const attempts: { query: string; hits: { s: OaSource; sim: number }[] }[] = [];
    for (const q of [c.title, c.acronym]) {
      const r = await get('openalex', oa('sources', { search: q, filter: 'type:conference', 'per-page': 5, select: SELECT }));
      const hits = (r?.results ?? []).map((s: OaSource) => ({ s, sim: similarity(c.title, s.display_name) })).sort((a: any, b: any) => b.sim - a.sim);
      attempts.push({ query: q, hits });
      out(`- search="${q}": ${r === null ? 'REQUEST FAILED' : `${hits.length} hits`}`);
      for (const x of hits.slice(0, 3)) {
        out(`  - ${oaId(x.s.id)} | ${x.s.display_name} | works ${x.s.works_count} | h_index ${x.s.summary_stats?.h_index ?? 'n/a'} | cited_by ${x.s.cited_by_count} | sim ${x.sim.toFixed(2)}`);
      }
      if (hits[0] && hits[0].sim >= 0.5) break;   // title search was good enough; skip the acronym query
    }
    const all = attempts.flatMap((a) => a.hits).sort((a, b) => b.sim - a.sim);
    bestHit[String(i)] = all[0]?.s;
    rawSample.push({ ...c, attempts: attempts.map((a) => ({ query: a.query, hits: a.hits.map((x) => ({ ...x.s, sim: x.sim })) })) });
    done++;
  }
  saveRaw('openalex-conference-sample.json', { retrieved: TODAY, icorePopulation, sample: rawSample });
}

async function part1() {
  h('## Part 1. OpenAlex');
  try { await part1A(); } catch (e) { out(`\n! 1A crashed: ${(e as Error).message}`); }
  try { buildSample(); await part1B(); } catch (e) { out(`\n! 1B crashed: ${(e as Error).message}`); }
}

// ── Part 2: SCImago ──────────────────────────────────────────
const sjrByKey: Record<string, number | undefined> = {};
function part2() {
  h('## Part 2. SCImago (data/scimago.csv)');
  if (!fs.existsSync('data/scimago.csv')) { out('- data/scimago.csv missing'); return; }
  const rows = readCsv('data/scimago.csv', ';');
  const header = rows[0], data = rows.slice(1);
  out(`- header: ${header.join(' | ')}`);
  out(`- first data row: ${data[0].join(' | ')}`);
  out(`- total rows: ${data.length}`);
  const years = new Set<string>();
  for (const c of header) for (const m of c.match(/\b(19|20)\d{2}\b/g) ?? []) years.add(m);
  const covMax = Math.max(...data.slice(0, 2000).flatMap((r) => (r[header.indexOf('Coverage')] ?? '').match(/\b20\d{2}\b/g) ?? ['0']).map(Number));
  out(`- years visible in header: ${[...years].join(', ') || 'none'}; latest coverage year in first 2000 rows: ${covMax}. No explicit edition field.`);

  const col = (n: string) => header.indexOf(n);
  const iAreas = col('Areas'), iSjr = col('SJR'), iQ = col('SJR Best Quartile'), iIssn = col('Issn'), iType = col('Type'), iTitle = col('Title');
  const cs = data.filter((r) => (r[iAreas] ?? '').includes('Computer Science'));
  const csOnly = cs.filter((r) => (r[iAreas] ?? '').split(';').map((a) => a.trim()).filter(Boolean).length === 1);
  out(`- rows with "Computer Science" in Areas: ${cs.length} (${cs.length - csOnly.length} also list other areas, ${csOnly.length} CS only)`);
  const types: Record<string, number> = {};
  for (const r of cs) types[r[iType]] = (types[r[iType]] ?? 0) + 1;
  out(`- CS subset by Type: ${Object.entries(types).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const sjrOf = (r: string[]) => num(r[iSjr] ?? '');
  const pop = cs.map(sjrOf).filter((x) => Number.isFinite(x));
  const popJ = cs.filter((r) => r[iType] === 'journal').map(sjrOf).filter((x) => Number.isFinite(x));
  out(`- CS subset with numeric SJR: ${pop.length} (journals only: ${popJ.length})`);
  saveRaw('scimago-cs-summary.json', { retrieved: TODAY, rows: data.length, csRows: cs.length, csOnly: csOnly.length, types });

  out('\n| journal | in file | SJR | pct SJR in CS (all types) | pct SJR in CS (journals) | quartile in file | areas |\n|---|---|---|---|---|---|---|');
  for (const v of VENUES.filter((x) => x.type === 'journal' && x.issn)) {
    const want = normIssn(v.issn!);
    const r = data.find((d) => (d[iIssn] ?? '').split(',').some((i) => normIssn(i) === want));
    if (!r) { out(`| ${v.key} | no | | | | | |`); continue; }
    const sjr = sjrOf(r);
    sjrByKey[v.key] = sjr;
    const inCs = (r[iAreas] ?? '').includes('Computer Science');
    out(`| ${v.key} | yes (${r[iTitle]}) | ${fmt(sjr, 3)} | ${inCs ? fmt(percentileRank(sjr, pop), 1) : 'n/a (not CS)'} | ${inCs ? fmt(percentileRank(sjr, popJ), 1) : 'n/a'} | ${r[iQ]} | ${r[iAreas]} |`);
  }
}

// ── Part 3: ICORE ────────────────────────────────────────────
function part3() {
  h('## Part 3. ICORE (data/core.csv)');
  if (!fs.existsSync('data/core.csv')) { out('- data/core.csv missing'); return; }
  const rows = readCsv('data/core.csv');
  // no header row: id, title, acronym, source, rank, ?, FoR codes
  out(`- total rows: ${rows.length} (file has no header; first row: ${rows[0].join(' | ')})`);
  const count = (i: number) => { const m: Record<string, number> = {}; for (const r of rows) m[r[i]] = (m[r[i]] ?? 0) + 1; return m; };
  out(`- rank (col 5) counts: ${JSON.stringify(count(4))}`);
  out(`- source/edition (col 4) values: ${JSON.stringify(count(3))}`);
  out('\n| venue | coreId | row |\n|---|---|---|');
  for (const v of VENUES.filter((x) => x.coreId)) {
    const r = rows.find((x) => x[0] === v.coreId);
    out(`| ${v.key} | ${v.coreId} | ${r ? r.join(' , ') : 'NOT FOUND'} |`);
  }
}


// ── Part 4: Semantic Scholar on the conference sample ────────
function hIndex(cites: number[]): number {
  const s = [...cites].sort((a, b) => b - a);
  let hh = 0; while (hh < s.length && s[hh] >= hh + 1) hh++;
  return hh;
}

const MAX_CALLS_PER_VENUE = 40;
async function s2Bulk(venue: string): Promise<{ total: number; cites: number[]; calls: number; complete: boolean }> {
  const cites: number[] = [];
  let token: string | undefined, calls = 0, total = 0, complete = true;
  do {
    if (Date.now() > s2Deadline || calls >= MAX_CALLS_PER_VENUE) { complete = false; break; }
    const r = await get('semanticscholar', buildUrl('https://api.semanticscholar.org/graph/v1/paper/search/bulk', { venue, fields: 'citationCount', token }));
    calls++;
    if (r === null) { complete = false; break; }
    if (calls === 1) total = r.total ?? 0;
    for (const p of r.data ?? []) cites.push(p.citationCount ?? 0);
    token = r.token ?? undefined;
    if (calls === 1 && total === 0) break;
  } while (token);
  return { total, cites, calls, complete };
}
let s2Deadline = 0;

async function part4() {
  h('## Part 4. Semantic Scholar on the conference sample');
  out(`- S2_API_KEY set: ${S2_KEY ? 'yes' : 'no'}`);
  s2Deadline = Date.now() + PART4_BUDGET_MS;
  out('\n| conf | rank | name matched | papers | total cites | h-index (S2) | cites/paper | API calls | seconds | complete | OpenAlex top-hit h_index |\n|---|---|---|---|---|---|---|---|---|---|---|');
  const raw: any[] = [];
  let attempted = 0;
  const completed: { calls: number; secs: number }[] = [];
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (Date.now() > s2Deadline) break;
    attempted++;
    const t0 = Date.now();
    let used = c.title, r = await s2Bulk(c.title), calls = r.calls;
    if (r.total === 0 && Date.now() <= s2Deadline) { used = c.acronym; r = await s2Bulk(c.acronym); calls += r.calls; }
    const secs = (Date.now() - t0) / 1000;
    const total = r.cites.reduce((a, b) => a + b, 0);
    const oaH = bestHit[String(i)]?.summary_stats?.h_index;
    out(`| ${c.key ?? c.acronym} | ${c.rank} | ${r.cites.length ? (used === c.title ? 'title' : 'acronym') : 'none'} (${used}) | ${r.cites.length} | ${total} | ${hIndex(r.cites)} | ${fmt(r.cites.length ? total / r.cites.length : 0)} | ${calls} | ${fmt(secs, 1)} | ${r.complete ? 'yes' : 'NO'} | ${oaH ?? 'n/a'} |`);
    raw.push({ ...c, usedName: used, papers: r.cites.length, total, h: hIndex(r.cites), calls, secs, complete: r.complete });
    if (r.complete) completed.push({ calls, secs });
  }
  if (attempted < sample.length) out(`\n! Part 4 time cap hit: ${attempted}/${sample.length} conferences attempted`);
  saveRaw('s2-conference-sample.json', { retrieved: TODAY, keySet: !!S2_KEY, results: raw });

  if (completed.length) {
    const avgCalls = completed.reduce((a, b) => a + b.calls, 0) / completed.length;
    const avgSecs = completed.reduce((a, b) => a + b.secs, 0) / completed.length;
    const total = avgSecs * icorePopulation;
    out(`\n- over ${completed.length} completed venues: avg ${fmt(avgCalls, 1)} calls and ${fmt(avgSecs, 1)} s per venue (includes the acronym retry where it happened)`);
    out(`- full ICORE population (${icorePopulation} venues): ~${fmt(total / 3600, 1)} h (~${fmt(total / 86400, 2)} days)`);
  } else out('\n- no venue completed; no estimate possible');

  const rel = await get('semanticscholar-datasets', 'https://api.semanticscholar.org/datasets/v1/release/latest');
  if (!rel) { out('- datasets release/latest: request FAILED'); return; }
  out(`\n- latest dataset release: ${rel.release_id}`);
  for (const d of rel.datasets ?? []) {
    const size = Object.entries(d).filter(([k]) => /size|bytes|files/i.test(k)).map(([k, x]) => `${k}=${JSON.stringify(x)}`).join(' ');
    out(`  - ${d.name}${size ? ` (${size})` : ''}`);
  }
}

// ── Part 5: GGS class-assignment rules ───────────────────────
async function part5() {
  h('## Part 5. GGS class-assignment rules');
  const url = 'https://scie.lcc.uma.es/gii-grin-scie-rating/conferenceRating.jsf';
  const st = (stats['ggs-page'] ??= { ok: 0, failed: 0 });
  let html = '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': `didcal-poc (${mailto() || 'no-email'})` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
    st.ok++;
  } catch (e) { st.failed++; out(`- download FAILED: ${(e as Error).message}`); return; }
  fs.mkdirSync('data/ggs', { recursive: true });
  const htmlFile = `data/ggs/ggs-method-page-${TODAY}.html`;
  fs.writeFileSync(htmlFile, html);
  out(`- saved ${htmlFile} (${html.length} bytes)`);

  const at = html.indexOf('Class-Assignment Rules');
  const tableEnd = at < 0 ? -1 : html.indexOf('</table>', at);
  if (at < 0 || tableEnd < 0) { out('- "Class-Assignment Rules" table NOT FOUND in page'); return; }
  const rules: { original: string[]; raw: string; final: string }[] = [];
  for (const m of html.slice(at, tableEnd).matchAll(/<tr>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<\/tr>/gs)) {
    const strip = (s: string) => s.replace(/<[^>]*>/g, '').trim();
    const raw = strip(m[1]);
    rules.push({ original: raw.split(',').map((x) => x.trim()), raw, final: strip(m[2]) });
  }
  fs.writeFileSync('data/ggs/ggs-class-rules.json', JSON.stringify({ retrieved: TODAY, source: url, rules }, null, 1));
  out(`- extracted ${rules.length} rows to data/ggs/ggs-class-rules.json`);

  // Same combination = same multiset of classes, regardless of order.
  const byCombo = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const r of rules) {
    const k = [...r.original].sort().join(', ');
    counts.set(k, (counts.get(k) ?? 0) + 1);
    (byCombo.get(k) ?? byCombo.set(k, new Set()).get(k)!).add(r.final);
  }
  const dupes = [...counts].filter(([, n]) => n > 1);
  const conflicts = [...byCombo].filter(([, f]) => f.size > 1);
  out(`- combinations listed more than once: ${dupes.length}; with different final classes: ${conflicts.length}`);
  for (const [k, f] of conflicts) out(`  - [${k}] → ${[...f].join(' vs ')}`);
}

// ── run ──────────────────────────────────────────────────────
async function main() {
  out(`# Data check report ${TODAY}`);
  out(`Env vars set: DIDCAL_MAILTO=${process.env.DIDCAL_MAILTO ? 'yes' : 'NO'}, OPENALEX_API_KEY=${OPENALEX_KEY ? 'yes' : 'NO'}, S2_API_KEY=${S2_KEY ? 'yes' : 'NO'}`);
  const parts: [string, () => unknown][] = [['part1', part1], ['part2', part2], ['part3', part3], ['part4', part4], ['part5', part5]];
  for (const [name, fn] of parts) {
    try { await fn(); } catch (e) { out(`\n! ${name} crashed: ${(e as Error).message}`); }
  }
  h('## Failed requests per source (every null from getJson counts, incl. 404)');
  out('| source | ok | failed |\n|---|---|---|');
  for (const [k, s] of Object.entries(stats)) out(`| ${k} | ${s.ok} | ${s.failed} |`);
  out(`\nTotal run time: ${((Date.now() - RUN_START) / 60000).toFixed(1)} min`);
  fs.writeFileSync(`${OUT_DIR}/report-${TODAY}.md`, lines.join('\n') + '\n');
}
main();
