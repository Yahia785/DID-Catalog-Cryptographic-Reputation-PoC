/**
 * Choose the ~100-venue sample (about 50 conferences, 50 journals) from venues the free
 * sources already cover, in two stages so the matches can be reviewed before the registry changes.
 *
 * Stage 1  npx tsx src/venues/select-sample.ts
 *   Writes data/sample/candidates.json and data/sample/review.md and prints the review table.
 *   Does not touch src/.
 * Stage 2  npx tsx src/venues/select-sample.ts --write-registry
 *   Reads data/sample/candidates.json (may be edited by hand: fix or drop entries) and writes
 *   src/venues/sample-venues.ts, extends VenueEntry, and makes registry.ts export
 *   VENUES = [...test venues, ...SAMPLE_VENUES]. Creates no DIDs.
 *
 * Randomness: a seeded mulberry32 generator, seed 42, consumed in a fixed order: one Fisher-Yates
 * shuffle per conference rank pool (A*, A, B, C) and then one per journal quartile pool (Q1..Q4),
 * all shuffled up front, so the shuffles do not depend on API results. Which candidates are accepted
 * does depend on the live OpenAlex answers; data/sample/candidates.json is the record of the outcome.
 *
 * Conferences: ICORE rows ranked A*, A, B or C; new per rank A* 3, A 6, B 13, C 21 (ICORE's own mix).
 *   A candidate is accepted when the best OpenAlex conference source has word-overlap similarity >= 0.75
 *   and works_count >= 200 (a series-level source, not a stub). Similarity is Jaccard on word sets
 *   (stop words and parenthetical text such as "(SC)" ignored).
 * Journals: SCImago Computer Science journals that matched in OpenAlex, 11 per SJR Best Quartile.
 *
 * Optional env vars: DIDCAL_MAILTO, OPENALEX_API_KEY
 */
import fs from 'node:fs';
import { buildUrl, getJson, mailto } from '../shared/http.js';
import { readCsv } from '../shared/csv.js';
import { VENUES as ALL_VENUES } from './registry.js';

/** The 13 hand-picked test venues (after stage 2 the registry also holds the sample). */
const VENUES = ALL_VENUES.filter((v) => !v.role.startsWith('Sample'));

const OPENALEX_KEY = process.env.OPENALEX_API_KEY ?? '';
const SEED = 42;
const QUOTA: Record<string, number> = { 'A*': 3, A: 6, B: 13, C: 21 };
const JOURNALS_PER_QUARTILE = 11;
const OA_SIM_MIN = 0.75, OA_WORKS_MIN = 200, SCIMAGO_SIM_MIN = 0.6, CHECK_BELOW = 0.9;
const DIR = 'data/sample';
const CANDIDATES = `${DIR}/candidates.json`;
const SAMPLE_FILE = 'src/venues/sample-venues.ts';
const REGISTRY_FILE = 'src/venues/registry.ts';

// ── shared helpers ───────────────────────────────────────────
const stats: Record<string, { ok: number; failed: number }> = {};
/** getJson wrapper: every null counts as a failed request for that source. */
async function get(source: string, url: string): Promise<any | null> {
  const s = (stats[source] ??= { ok: 0, failed: 0 });
  // getJson has no timeout of its own: a stalled connection would hang the run, so give up after 90 s
  const r = await Promise.race([getJson(url), new Promise<null>((res) => setTimeout(() => { console.warn(`  ! timed out: ${url}`); res(null); }, 90_000))]);
  if (r === null) s.failed++; else s.ok++;
  return r;
}
const oa = (path: string, params: Record<string, string | number | undefined>) =>
  buildUrl(`https://api.openalex.org/${path}`, { mailto: mailto(), api_key: OPENALEX_KEY, ...params });

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const STOP = new Set(['the', 'and', 'for', 'of', 'on', 'in', 'a', 'an', 'to']);
const SCIMAGO_STOP = new Set([...STOP, 'proceedings', 'international', 'conference', 'symposium', 'annual', 'ieee', 'acm']);
const OA_STOP = new Set([...STOP, 'international', 'annual']);
const words = (s: string, stop: Set<string>) =>
  new Set(s.replace(/\([^)]*\)/g, ' ').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !stop.has(w)));
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter || 1);
}
const oaSimilarity = (a: string, b: string) => jaccard(words(a, OA_STOP), words(b, OA_STOP));
const normIssn = (s: string) => s.replace(/[^0-9Xx]/g, '').toUpperCase();
export const dashIssn = (n: string) => `${n.slice(0, 4)}-${n.slice(4)}`;
const num = (s: string) => Number(s.replace(',', '.'));
const oaId = (id: string) => id.replace('https://openalex.org/', '');

// ── candidate records ────────────────────────────────────────
interface OaMatch { id: string; display_name: string; similarity: number; works_count: number; h_index: number | null; cited_by_count: number; two_yr_mean_citedness?: number | null }
interface ScimagoMatch { sourceid: string; title: string; similarity: number; h_index: number | null; citations_per_doc_2y: number | null; sjr?: number | null; quartile?: string }
interface Candidate {
  type: 'conference' | 'journal';
  test: boolean;                 // already in the registry (kept regardless of matches)
  key?: string;                  // test venues: registry key. Others: optional override of the generated key
  slug?: string;                 // optional override of the generated slug
  confirmed?: boolean;           // a human checked a low-similarity match and accepted it
  title: string;
  acronym?: string;              // conferences
  icoreId?: string;
  icoreRank?: string;
  issns?: string[];              // journals, 8 chars no hyphen
  stratum: string;               // 'ICORE B', 'Q2', ...
  openalex: OaMatch | null;
  scimago: ScimagoMatch | null;
}

const SELECT = 'id,display_name,works_count,cited_by_count,summary_stats';
const toOa = (s: any, title: string): OaMatch => ({
  id: oaId(s.id), display_name: s.display_name, similarity: Number(oaSimilarity(title, s.display_name).toFixed(3)),
  works_count: s.works_count ?? 0, h_index: s.summary_stats?.h_index ?? null, cited_by_count: s.cited_by_count ?? 0,
  two_yr_mean_citedness: s.summary_stats?.['2yr_mean_citedness'] ?? null,
});

/** Best OpenAlex conference-source hit: title search first, then acronym if no hit reaches OA_SIM_MIN. */
async function searchConference(title: string, acronym: string): Promise<OaMatch | null> {
  let best: OaMatch | null = null;
  for (const q of [title, acronym]) {
    if (!q) continue;
    const r = await get('openalex', oa('sources', { search: q, filter: 'type:conference', 'per-page': 5, select: SELECT }));
    for (const s of r?.results ?? []) {
      const m = toOa(s, title);
      if (!best || m.similarity > best.similarity) best = m;
    }
    if (best && best.similarity >= OA_SIM_MIN) break;
  }
  return best;
}

// ── SCImago data ─────────────────────────────────────────────
const scim = readCsv('data/scimago.csv', ';');
const SH = scim[0];
const col = (n: string) => SH.indexOf(n);
const C = { cats: col('Categories'), id: col('Sourceid'), title: col('Title'), type: col('Type'), issn: col('Issn'), sjr: col('SJR'), q: col('SJR Best Quartile'), h: col('H index'), cpd: col('Citations / Doc. (2years)'), areas: col('Areas') };
const scimData = scim.slice(1);
const confRows = scimData.filter((r) => r[C.type] === 'conference and proceedings')
  .map((r) => ({ r, w: words(r[C.title], SCIMAGO_STOP) }));

function scimagoConference(title: string): ScimagoMatch | null {
  const w = words(title, SCIMAGO_STOP);
  let best: { r: string[]; sim: number } | null = null;
  for (const c of confRows) { const sim = jaccard(w, c.w); if (!best || sim > best.sim) best = { r: c.r, sim }; }
  if (!best || best.sim < SCIMAGO_SIM_MIN) return null;
  return { sourceid: best.r[C.id], title: best.r[C.title], similarity: Number(best.sim.toFixed(3)), h_index: Number(best.r[C.h]) || null, citations_per_doc_2y: num(best.r[C.cpd]) || null };
}
const scimagoMatchOfRow = (r: string[], title: string): ScimagoMatch => ({
  sourceid: r[C.id], title: r[C.title], similarity: Number(jaccard(words(title, OA_STOP), words(r[C.title], OA_STOP)).toFixed(3)),
  h_index: Number(r[C.h]) || null, citations_per_doc_2y: num(r[C.cpd]) || null, sjr: num(r[C.sjr]), quartile: r[C.q],
});
const issnsOf = (r: string[]) => (r[C.issn] ?? '').split(',').map(normIssn).filter((i) => i.length === 8);

// ── Stage 1 ──────────────────────────────────────────────────
/** One seeded shuffle per rank pool, in the order A*, A, B, C. */
function conferencePools(rand: () => number) {
  const core = readCsv('data/core.csv');
  const testCoreIds = new Set(VENUES.map((v) => v.coreId).filter(Boolean));
  const pools: Record<string, string[][]> = {};
  for (const rank of Object.keys(QUOTA)) pools[rank] = shuffled(core.filter((r) => r[4] === rank && !testCoreIds.has(r[0])), rand);
  return { core, pools };
}

async function selectConferences(rand: () => number): Promise<{ picked: Candidate[]; rejected: unknown[] }> {
  const { core, pools } = conferencePools(rand);

  const picked: Candidate[] = [];
  const rejected: unknown[] = [];
  const usedOa = new Set<string>();

  // test conferences: always kept; record the best OpenAlex hit, whatever its quality
  for (const v of VENUES.filter((x) => x.type === 'conference')) {
    const row = v.coreId ? core.find((r) => r[0] === v.coreId) : undefined;
    const title = row?.[1] ?? v.name, acronym = row?.[2] ?? v.key;
    const match = await searchConference(title, acronym);
    if (match) usedOa.add(match.id);
    picked.push({ type: 'conference', test: true, key: v.key, title, acronym, icoreId: v.coreId, icoreRank: row?.[4],
      stratum: row ? `ICORE ${row[4]}` : 'not in ICORE', openalex: match, scimago: scimagoConference(title) });
  }

  for (const [rank, quota] of Object.entries(QUOTA)) {
    let got = 0, tried = 0;
    for (const row of pools[rank]) {
      if (got >= quota) break;
      tried++;
      const [id, title, acronym] = row;
      const match = await searchConference(title, acronym);
      const why = !match ? 'no OpenAlex hit' : match.similarity < OA_SIM_MIN ? `similarity ${match.similarity} < ${OA_SIM_MIN}`
        : match.works_count < OA_WORKS_MIN ? `works_count ${match.works_count} < ${OA_WORKS_MIN}` : usedOa.has(match.id) ? 'OpenAlex source already used' : '';
      if (why) { rejected.push({ icoreId: id, title, acronym, rank, reason: why, hit: match?.display_name }); continue; }
      usedOa.add(match!.id);
      picked.push({ type: 'conference', test: false, title, acronym, icoreId: id, icoreRank: rank, stratum: `ICORE ${rank}`, openalex: match, scimago: scimagoConference(title) });
      got++;
    }
    console.log(`  ICORE ${rank}: accepted ${got}/${quota} after ${tried} candidates`);
  }
  return { picked, rejected };
}

async function oaJournalPopulation(): Promise<Map<string, any>> {
  // sourceid → OpenAlex source, from the data-check output, else looked up by ISSN in batches of 50
  const byId = new Map<string, any>();
  const file = 'output/data-check/openalex-scimago-cs-journals.json';
  if (fs.existsSync(file)) {
    for (const j of JSON.parse(fs.readFileSync(file, 'utf8')).journals) if (j.oa) byId.set(String(j.sourceid), j.oa);
    console.log(`  journals: ${byId.size} OpenAlex matches read from ${file}`);
    return byId;
  }
  console.log(`  ${file} missing: looking journals up by ISSN`);
  const rows = scimData.filter((r) => r[C.type] === 'journal' && (r[C.areas] ?? '').includes('Computer Science'));
  const issnToRow = new Map<string, string>();
  for (const r of rows) for (const n of issnsOf(r)) if (!issnToRow.has(n)) issnToRow.set(n, r[C.id]);
  const all = [...issnToRow.keys()];
  for (let i = 0; i < all.length; i += 50) {
    const res = await get('openalex', oa('sources', { filter: `issn:${all.slice(i, i + 50).map(dashIssn).join('|')}`, 'per-page': 200, select: `${SELECT},issn,issn_l` }));
    for (const s of res?.results ?? []) for (const n of [s.issn_l, ...(s.issn ?? [])]) {
      const id = n ? issnToRow.get(normIssn(n)) : undefined;
      if (id && !byId.has(id)) byId.set(id, s);
    }
  }
  return byId;
}

/** ASJC 17xx (Computer Science) subject names, as SCImago writes them in the Categories column. */
const CS_CATEGORIES = new Set([
  'Artificial Intelligence', 'Computational Theory and Mathematics', 'Computer Graphics and Computer-Aided Design',
  'Computer Networks and Communications', 'Computer Science (miscellaneous)', 'Computer Science Applications',
  'Computer Vision and Pattern Recognition', 'Hardware and Architecture', 'Human-Computer Interaction',
  'Information Systems', 'Signal Processing', 'Software',
]);
/** True when at least half of the journal's SCImago categories are Computer Science categories. */
function mostlyComputerScience(r: string[]): boolean {
  const cats = (r[C.cats] ?? '').split(';').map((c) => c.replace(/\s*\(Q\d\)\s*$/, '').trim()).filter(Boolean);
  return cats.length > 0 && cats.filter((c) => CS_CATEGORIES.has(c)).length * 2 >= cats.length;
}
const JOURNAL_WORKS_MIN = 50;

async function selectJournals(rand: () => number, keepTest?: Candidate[]): Promise<{ journals: Candidate[]; poolSizes: Record<string, number> }> {
  const oaById = await oaJournalPopulation();
  const testIssns = new Set(VENUES.filter((v) => v.issn).map((v) => normIssn(v.issn!)));
  const pool = scimData.filter((r) => r[C.type] === 'journal' && (r[C.areas] ?? '').includes('Computer Science') && mostlyComputerScience(r)
    && oaById.get(r[C.id])?.summary_stats?.['2yr_mean_citedness'] !== undefined && (oaById.get(r[C.id])?.works_count ?? 0) >= JOURNAL_WORKS_MIN
    && !issnsOf(r).some((n) => testIssns.has(n)));
  const out: Candidate[] = [];
  const poolSizes: Record<string, number> = {};

  if (keepTest) out.push(...keepTest);
  else for (const v of VENUES.filter((x) => x.type === 'journal')) {
    const want = normIssn(v.issn!);
    const row = scimData.find((r) => r[C.type] === 'journal' && issnsOf(r).includes(want));
    let src = row ? oaById.get(row[C.id]) : undefined;
    if (!src) src = await get('openalex', oa(`sources/issn:${v.issn}`, { select: SELECT }));
    out.push({ type: 'journal', test: true, key: v.key, title: v.name, issns: [want], stratum: row ? row[C.q] : 'not in SCImago',
      openalex: src ? toOa(src, v.name) : null, scimago: row ? scimagoMatchOfRow(row, v.name) : null });
  }
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
    const picks = shuffled(pool.filter((r) => r[C.q] === q), rand).slice(0, JOURNALS_PER_QUARTILE);
    poolSizes[q] = pool.filter((r) => r[C.q] === q).length;
    console.log(`  ${q}: ${picks.length}/${JOURNALS_PER_QUARTILE} (pool ${poolSizes[q]})`);
    for (const r of picks) {
      out.push({ type: 'journal', test: false, title: r[C.title], issns: issnsOf(r), stratum: q,
        openalex: toOa(oaById.get(r[C.id]), r[C.title]), scimago: scimagoMatchOfRow(r, r[C.title]) });
    }
  }
  return { journals: out, poolSizes };
}

/**
 * Short readable key (at most 8 characters) from a journal title: the title without any subtitle
 * (after ':' or ' - ') is reduced to its initials; a one-word title is used whole, uppercased.
 */
export function journalAcronym(title: string): string {
  const main = title.split(/\s*[:–-]\s+/)[0];
  const ws = main.replace(/\([^)]*\)/g, ' ').replace(/&/g, ' ').split(/[^A-Za-z0-9]+/).filter((w) => w && !STOP.has(w.toLowerCase()));
  if (ws.length === 1) return ws[0].toUpperCase().slice(0, 8);
  const ini = ws.map((w) => w[0].toUpperCase()).join('');
  return (ini.length >= 2 ? ini : ws[0] ?? 'J').slice(0, 8);
}
const baseKey = (c: Candidate) => c.key ?? (c.type === 'conference' ? c.acronym || c.title.slice(0, 8) : journalAcronym(c.title));

function reviewTable(cands: Candidate[]): string {
  const f = (m: { similarity: number } | null) => (m ? m.similarity.toFixed(2) : '—');
  const rows = ['| type | key | stratum | OpenAlex match (sim, works) | SCImago match (sim) | flag |', '|---|---|---|---|---|---|'];
  for (const c of cands) {
    const low = [c.openalex, c.scimago].some((m) => m && m.similarity < CHECK_BELOW);
    const check = low ? (c.confirmed ? 'confirmed' : 'CHECK') : '';
    rows.push(`| ${c.type}${c.test ? ' (test)' : ''} | ${baseKey(c)} | ${c.stratum} | ` +
      `${c.openalex ? `${c.openalex.display_name} (${f(c.openalex)}, ${c.openalex.works_count})` : 'none'} | ` +
      `${c.scimago ? `${c.scimago.title} (${f(c.scimago)})` : 'not in SCImago'} | ${check} |`);
  }
  return rows.join('\n');
}

async function stage1() {
  fs.mkdirSync(DIR, { recursive: true });
  console.log(`OPENALEX_API_KEY set: ${OPENALEX_KEY ? 'yes' : 'no'}; DIDCAL_MAILTO set: ${mailto() ? 'yes' : 'no'}`);
  const rand = mulberry32(SEED);
  console.log(`Seed ${SEED}. Selecting conferences...`);
  const { picked, rejected } = await selectConferences(rand);
  console.log('Selecting journals...');
  const { journals, poolSizes } = await selectJournals(rand);
  const cands = [...picked, ...journals];
  fs.writeFileSync(CANDIDATES, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), seed: SEED, journalPoolSizes: poolSizes, candidates: cands, rejectedConferences: rejected }, null, 1));
  writeReview(cands, rejected.length, poolSizes);
}

/** Keep the conference candidates (with any hand edits) and the test journals; redraw the sampled journals. */
async function redrawJournals() {
  console.log(`OPENALEX_API_KEY set: ${OPENALEX_KEY ? 'yes' : 'no'}; DIDCAL_MAILTO set: ${mailto() ? 'yes' : 'no'}`);
  const file = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
  const old: Candidate[] = file.candidates;
  const rand = mulberry32(SEED);
  conferencePools(rand);   // advance the generator exactly as the full run did, without any API calls
  const { journals, poolSizes } = await selectJournals(rand, old.filter((c) => c.type === 'journal' && c.test));
  const cands = [...old.filter((c) => c.type === 'conference'), ...journals];
  fs.writeFileSync(CANDIDATES, JSON.stringify({ ...file, generated: new Date().toISOString().slice(0, 10), journalPoolSizes: poolSizes, candidates: cands }, null, 1));
  writeReview(cands, (file.rejectedConferences ?? []).length, poolSizes);
}

/** Rebuild review.md from candidates.json (after hand edits). */
function regenerateReview() {
  const file = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
  writeReview(file.candidates, (file.rejectedConferences ?? []).length, file.journalPoolSizes);
}

function writeReview(cands: Candidate[], nRejected: number, poolSizes?: Record<string, number>) {
  const confs = cands.filter((c) => c.type === 'conference'), jours = cands.filter((c) => c.type === 'journal');
  const sources = (c: Candidate) => (c.icoreId ? 1 : 0) + (c.openalex ? 1 : 0) + (c.scimago ? 1 : 0);
  const nConf = (n: number) => confs.filter((c) => sources(c) === n).length;
  const summary = [
    `Conferences: ${confs.length} (${confs.filter((c) => c.test).length} test + ${confs.filter((c) => !c.test).length} new). With 3 sources (ICORE + OpenAlex + SCImago): ${nConf(3)}; with 2: ${nConf(2)}; with 1: ${nConf(1)}; with 0 (kept as test venues): ${nConf(0)}.`,
    `Journals: ${jours.length} (${jours.filter((c) => c.test).length} test + ${jours.filter((c) => !c.test).length} new). With both SJR (SCImago) and OpenAlex: ${jours.filter((c) => c.scimago && c.openalex).length}.`,
    poolSizes ? `Journal pool after the category rule (>= half CS categories) and works_count >= ${JOURNAL_WORKS_MIN}: ${Object.entries(poolSizes).map(([k, n]) => `${k} ${n}`).join(', ')}.` : '',
    `Rejected conference candidates (not in sample): ${nRejected}, listed in ${CANDIDATES}.`,
    `Failed requests (every null counts): ${Object.entries(stats).map(([k, s]) => `${k} ${s.failed} of ${s.ok + s.failed}`).join(', ') || 'none made'}.`,
  ].filter(Boolean).join('\n');
  const md = `# Sample review (seed ${SEED})\n\nCHECK = a match similarity below ${CHECK_BELOW}; confirmed = checked by hand. Edit ${CANDIDATES} to fix or drop entries before stage 2.\n\n${reviewTable(cands)}\n\n${summary}\n`;
  fs.writeFileSync(`${DIR}/review.md`, md);
  console.log(`\n${md}`);
}

// ── Stage 2 ──────────────────────────────────────────────────
const SLUG_MAX = 63;   // a DNS label (the handle's first part) may not be longer
const SLUG_DROP = new Set(['of', 'on', 'and', 'the', 'for', 'in', 'at', 'a', 'an']);
/**
 * Handle part from a venue's full name: lowercase, accents removed, "&" → "and", every other
 * non-alphanumeric run → one hyphen. Over 63 characters: drop small words, then cut at the last whole word.
 */
export function slugOf(name: string): { slug: string; shortened: boolean } {
  let w = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  let slug = w.join('-');
  if (slug.length <= SLUG_MAX) return { slug: slug || 'venue', shortened: false };
  w = w.filter((x) => !SLUG_DROP.has(x));
  slug = w.join('-');
  if (slug.length > SLUG_MAX) {
    const kept: string[] = [];
    for (const x of w) { if ([...kept, x].join('-').length > SLUG_MAX) break; kept.push(x); }
    slug = kept.join('-') || w[0].slice(0, SLUG_MAX);
  }
  return { slug, shortened: true };
}
const escapeRegex =(s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function stage2() {
  if (!fs.existsSync(CANDIDATES)) throw new Error(`${CANDIDATES} missing: run stage 1 first`);
  const cands: Candidate[] = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8')).candidates;
  const keys = new Set(VENUES.map((v) => v.key.toLowerCase()));
  const slugs = new Set(VENUES.map((v) => v.slug));

  const entries: string[] = [];
  const shortened: string[] = [];
  let nConf = 0, nJour = 0;
  for (const c of cands.filter((x) => !x.test)) {
    let key = baseKey(c), k = key, n = 2;
    while (keys.has(k.toLowerCase())) k = `${key}-${n++}`;
    keys.add(k.toLowerCase());
    const made = c.slug ? { slug: c.slug, shortened: false } : slugOf(c.title);
    let slug = made.slug; n = 2;
    while (slugs.has(slug)) slug = `${made.slug.slice(0, SLUG_MAX - String(n).length - 1).replace(/-+$/, '')}-${n++}`;
    slugs.add(slug);
    if (made.shortened) shortened.push(`${k}: ${slug}`);
    const f: string[] = [`key: ${q(k)}`, `slug: ${q(slug)}`, `type: ${q(c.type)}`, `name: ${q(c.title)}`];
    if (c.type === 'conference' && c.icoreId) f.push(`coreId: ${q(c.icoreId)}`);
    if (c.type === 'journal' && c.issns?.[0]) f.push(`issn: ${q(dashIssn(c.issns[0]))}`);
    f.push(`rwMatch: ${q(escapeRegex(c.title.toLowerCase()))}`);
    if (c.openalex) f.push(`openalexId: ${q(c.openalex.id)}`);
    if (c.scimago) f.push(`scimagoId: ${q(c.scimago.sourceid)}`);
    f.push(`sampleStratum: ${q(c.stratum)}`, `role: ${q(`Sample (${c.stratum})`)}`);
    entries.push(`  { ${f.join(', ')} },`);
    if (c.type === 'conference') nConf++; else nJour++;
  }
  fs.writeFileSync(SAMPLE_FILE, `import type { VenueEntry } from './registry.js';

/**
 * Generated by src/venues/select-sample.ts --write-registry from data/sample/candidates.json
 * (seed ${SEED}). ${nConf} conferences, ${nJour} journals. Edit candidates.json and regenerate rather than this file.
 */
export const SAMPLE_VENUES: VenueEntry[] = [
${entries.join('\n')}
];
`);
  console.log(`wrote ${SAMPLE_FILE}: ${nConf} conferences, ${nJour} journals`);
  console.log(`slugs shortened to fit ${SLUG_MAX} characters (${shortened.length}):${shortened.map((s) => `\n  ${s}`).join('')}`);

  // registry.ts: new optional fields, test entries enriched, VENUES = [...test, ...sample]
  const original = fs.readFileSync(REGISTRY_FILE, 'utf8');
  const crlf = original.includes('\r\n');   // edit with LF endings, write back in the file's own style
  let reg = original.replace(/\r\n/g, '\n');
  if (!reg.includes('openalexId?:')) {
    reg = reg.replace('  rwExclude?: string;\n', '  rwExclude?: string;\n  openalexId?: string;    // OpenAlex source id, e.g. S4210233669\n  scimagoId?: string;     // SCImago Sourceid\n  sampleStratum?: string; // e.g. "ICORE B", "Q2"\n');
  }
  for (const c of cands.filter((x) => x.test && x.key)) {
    const extra = [c.openalex && `openalexId: ${q(c.openalex.id)}`, c.scimago && `scimagoId: ${q(c.scimago.sourceid)}`, `sampleStratum: ${q(c.stratum)}`].filter(Boolean).join(', ');
    const head = `key: ${q(c.key!)},`;
    if (reg.includes(`${head} openalexId`) || reg.includes(`${head} scimagoId`) || reg.includes(`${head} sampleStratum`)) continue;
    reg = reg.replace(head, `${head} ${extra},`);
  }
  if (!reg.includes('SAMPLE_VENUES')) {
    reg = reg.replace("import type { VenueType } from '../shared/types.js';", "import type { VenueType } from '../shared/types.js';\nimport { SAMPLE_VENUES } from './sample-venues.js';");
    reg = reg.replace('export const VENUES: VenueEntry[] = [', 'const TEST_VENUES: VenueEntry[] = [');
    reg = reg.replace('\n/** The "area code" part', '\n/** The 13 test venues followed by the sampled venues (src/venues/sample-venues.ts). */\nexport const VENUES: VenueEntry[] = [...TEST_VENUES, ...SAMPLE_VENUES];\n\n/** The "area code" part');
  }
  fs.writeFileSync(REGISTRY_FILE, crlf ? reg.replace(/\n/g, '\r\n') : reg);
  console.log(`updated ${REGISTRY_FILE}`);
}

if (process.argv.includes('--write-registry')) stage2();
else if (process.argv.includes('--review')) regenerateReview();
else if (process.argv.includes('--redraw-journals')) redrawJournals().catch((e) => { console.error(e); process.exit(1); });
else stage1().catch((e) => { console.error(e); process.exit(1); });
