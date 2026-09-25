/**
 * explore-sources.ts
 *
 * Exploration only: collect RAW metrics for each test venue from every
 * source in the lit-review data inventory. No derived values (no means,
 * ratios, or scores). Totals and counts are reported exactly as the source
 * gives them, or summed where the source only reports per paper.
 *
 * Sources:
 *   API (live)            OpenAlex, Semantic Scholar, Crossref
 *   CSV (download once)   ICORE (CORE), SCImago, Retraction Watch
 *   Not queried           DBLP (API behind a bot-blocker; monthly snapshot is multi-GB)
 *
 * Put the three downloaded CSVs here (any missing file is skipped):
 *   data/core.csv               ICORE conference rankings export
 *   data/scimago.csv            SCImago journal rank export (semicolon-separated)
 *   data/retraction_watch.csv   Retraction Watch database
 *
 * Run from the didcal-poc folder:  npx tsx src/scoring/explore-sources.ts
 * Optional env vars: DIDCAL_MAILTO, OPENALEX_API_KEY, S2_API_KEY
 *
 * Output:
 *   output/explore/raw-metrics.csv   one row per metric, one column per venue (open in Excel)
 *   output/explore/raw.json          everything each source returned, for inspection
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────
// 1. Venues
// ─────────────────────────────────────────────────────────────

type VenueType = 'conference' | 'journal';

interface Venue {
  key: string;
  name: string;
  type: VenueType;
  issn?: string;               // journals
  coreAcronym?: string;        // conferences: acronym as ICORE lists it
  s2Candidates: string[];      // venue names to try in Semantic Scholar (no commas: S2 treats a comma as a separator)
  rwMatch: RegExp;             // matches the Retraction Watch "Journal" field
  rwExclude?: RegExp;          // excludes look-alike venues
  sciMatch?: RegExp;           // conferences: matches SCImago titles (proceedings entries)
}

const VENUES: Venue[] = [
  { key: 'S&P', type: 'conference', name: 'IEEE Symposium on Security and Privacy', coreAcronym: 'SP',
    s2Candidates: ['IEEE Symposium on Security and Privacy'],
    rwMatch: /symposium on security and privacy/i, rwExclude: /european|workshop/i,
    sciMatch: /symposium on security and privacy/i },
  { key: 'CCS', type: 'conference', name: 'ACM Conference on Computer and Communications Security', coreAcronym: 'CCS',
    s2Candidates: ['Conference on Computer and Communications Security'],
    rwMatch: /conference on computer and communications? security/i, rwExclude: /asia/i,
    sciMatch: /conference on computer and communications security/i },
  { key: 'ACNS', type: 'conference', name: 'Applied Cryptography and Network Security', coreAcronym: 'ACNS',
    s2Candidates: ['International Conference on Applied Cryptography and Network Security'],
    rwMatch: /applied cryptography and network security/i,
    sciMatch: /applied cryptography and network security/i },
  { key: 'PST', type: 'conference', name: 'Annual Conference on Privacy, Security and Trust', coreAcronym: 'PST',
    s2Candidates: ['Annual Conference on Privacy Security and Trust', 'International Conference on Privacy Security and Trust', 'PST'],
    rwMatch: /privacy,? security,? and trust/i,
    sciMatch: /privacy,? security,? and trust/i },
  { key: 'WASET', type: 'conference', name: 'World Academy of Science, Engineering and Technology',
    s2Candidates: ['World Academy of Science Engineering and Technology'],
    rwMatch: /world academy of science/i,
    sciMatch: /world academy of science/i },
  // Indexed but compromised: ACM proceedings, 323 retractions in 2022 (compromised peer review)
  { key: 'ICIMTech', type: 'conference', name: 'International Conference on Information Management and Technology',
    s2Candidates: ['International Conference on Information Management and Technology', 'ICIMTech'],
    rwMatch: /international conference on information management and technology/i,
    sciMatch: /international conference on information management and technology/i },
  // Indexed but compromised, security-adjacent: ACM proceedings, 24 retractions in 2022
  { key: 'IHIP', type: 'conference', name: 'International Conference on Information Hiding and Image Processing',
    s2Candidates: ['International Conference on Information Hiding and Image Processing', 'IHIP'],
    rwMatch: /information hiding and image processing/i,
    sciMatch: /information hiding and image processing/i },

  { key: 'TIFS', type: 'journal', name: 'IEEE Transactions on Information Forensics and Security', issn: '1556-6013',
    s2Candidates: ['IEEE Transactions on Information Forensics and Security'],
    rwMatch: /^ieee transactions on information forensics and security/i },
  { key: 'Access', type: 'journal', name: 'IEEE Access', issn: '2169-3536',
    s2Candidates: ['IEEE Access'], rwMatch: /^ieee access\b/i },
  { key: 'IJSN', type: 'journal', name: 'International Journal of Security and Networks', issn: '1747-8405',
    s2Candidates: ['International Journal of Security and Networks'], rwMatch: /^international journal of security and networks/i },
  { key: 'SCN', type: 'journal', name: 'Security and Communication Networks', issn: '1939-0114',
    s2Candidates: ['Security and Communication Networks'], rwMatch: /^security and communication networks/i },
  { key: 'CIN', type: 'journal', name: 'Computational Intelligence and Neuroscience', issn: '1687-5265',
    s2Candidates: ['Computational Intelligence and Neuroscience'], rwMatch: /^computational intelligence and neuroscience/i },
  // OMICS International: court-ruled deceptive ("predatory") publisher, FTC v. OMICS (2019)
  { key: 'JITSE', type: 'journal', name: 'Journal of Information Technology & Software Engineering', issn: '2165-7866',
    s2Candidates: ['Journal of Information Technology & Software Engineering', 'Journal of Information Technology and Software Engineering'],
    rwMatch: /^journal of information technology (&|and) software engineering/i },
];

const CURRENT_YEAR = new Date().getFullYear();
const YEARS: number[] = [];
for (let y = CURRENT_YEAR - 10; y <= CURRENT_YEAR - 1; y++) YEARS.push(y); // last 10 full years
const COHORT_YEAR = CURRENT_YEAR - 3; // one year of papers, old enough to have citations

// ─────────────────────────────────────────────────────────────
// 2. Results table: metric name → venue → raw value
// ─────────────────────────────────────────────────────────────

const table = new Map<string, Record<string, string | number>>();
const raw: Record<string, any> = {};

function put(metric: string, venue: string, value: unknown) {
  if (value === undefined || value === null || value === '') return;
  if (!table.has(metric)) table.set(metric, {});
  table.get(metric)![venue] = typeof value === 'number' ? value : String(value);
}

// ─────────────────────────────────────────────────────────────
// 3. Polite fetching (same approach as coverage-check.ts)
// ─────────────────────────────────────────────────────────────

const MAILTO = process.env.DIDCAL_MAILTO ?? '';
const OPENALEX_KEY = process.env.OPENALEX_API_KEY ?? '';
const S2_KEY = process.env.S2_API_KEY ?? '';
const MIN_GAP_MS: Record<string, number> = {
  'api.semanticscholar.org': S2_KEY ? 1000 : 1100,
  'api.crossref.org': 1000,
  'api.openalex.org': 200,
};
const lastRequestAt: Record<string, number> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  return url.toString();
}

async function getJson(url: string): Promise<any | null> {
  const host = new URL(url).host;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = (lastRequestAt[host] ?? 0) + (MIN_GAP_MS[host] ?? 500) - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt[host] = Date.now();
    const backoff = 5000 * 2 ** (attempt - 1);
    try {
      const headers: Record<string, string> = { 'User-Agent': `didcal-poc/explore (${MAILTO || 'no-email'})` };
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

// ─────────────────────────────────────────────────────────────
// 4. Small CSV reader (handles quoted fields)
// ─────────────────────────────────────────────────────────────

function parseCsv(text: string, delim = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readCsv(path: string, delim = ','): string[][] | null {
  if (!existsSync(path)) { console.log(`  (skipped: ${path} not found)`); return null; }
  return parseCsv(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''), delim);
}

// ─────────────────────────────────────────────────────────────
// 5. ICORE (CORE) — data/core.csv
// ─────────────────────────────────────────────────────────────

function exploreCore() {
  console.log('ICORE (data/core.csv)');
  const rows = readCsv('data/core.csv');
  if (!rows) return;
  // The export may or may not have a header row. Without one, columns are:
  // id, title, acronym, edition, rank, (yes/no flag), field-of-research codes...
  const hasHeader = rows[0].some((c) => /title/i.test(c));
  const body = hasHeader ? rows.slice(1) : rows;
  const col = (name: RegExp, fallback: number) => {
    const i = hasHeader ? rows[0].findIndex((c) => name.test(c)) : -1;
    return i >= 0 ? i : fallback;
  };
  const cTitle = col(/title/i, 1), cAcr = col(/acronym/i, 2), cSrc = col(/source/i, 3), cRank = col(/rank/i, 4);
  raw.core = { hasHeader, header: hasHeader ? rows[0] : null, matches: {} };

  for (const v of VENUES) {
    if (v.type !== 'conference' || !v.coreAcronym) continue;
    const hit = body.find((r) => (r[cAcr] ?? '').trim().toLowerCase() === v.coreAcronym!.toLowerCase());
    if (!hit) continue;
    raw.core.matches[v.key] = hit;
    put('CORE: rank', v.key, hit[cRank]);
    put('CORE: edition', v.key, hit[cSrc]);
    put('CORE: listed title', v.key, hit[cTitle]);
    hit.forEach((val, i) => put(`CORE: column ${i}${hasHeader ? ` (${rows[0][i]})` : ''}`, v.key, val));
  }
}

// ─────────────────────────────────────────────────────────────
// 6. SCImago — data/scimago.csv (semicolon-separated, decimal commas)
// ─────────────────────────────────────────────────────────────

function exploreScimago() {
  console.log('SCImago (data/scimago.csv)');
  const rows = readCsv('data/scimago.csv', ';');
  if (!rows) return;
  const header = rows[0];
  const body = rows.slice(1);
  const cTitle = header.findIndex((c) => /^title$/i.test(c.trim()));
  const cIssn = header.findIndex((c) => /^issn$/i.test(c.trim()));
  raw.scimago = { header, matches: {} };

  for (const v of VENUES) {
    if (v.type === 'journal' && v.issn) {
      const digits = v.issn.replace('-', '');
      const hit = body.find((r) => (r[cIssn] ?? '').includes(digits));
      if (!hit) continue;
      raw.scimago.matches[v.key] = hit;
      header.forEach((h, i) => put(`SCImago: ${h.trim()}`, v.key, hit[i]));
    } else if (v.sciMatch) {
      // Conferences only appear as separate proceedings entries, if at all
      const hits = body.filter((r) => v.sciMatch!.test(r[cTitle] ?? ''));
      raw.scimago.matches[v.key] = hits.map((r) => r[cTitle]);
      put('SCImago: proceedings entries matching name', v.key, hits.length);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 7. Retraction Watch — data/retraction_watch.csv
// ─────────────────────────────────────────────────────────────

function exploreRetractionWatch() {
  console.log('Retraction Watch (data/retraction_watch.csv)');
  const rows = readCsv('data/retraction_watch.csv');
  if (!rows) return;
  const header = rows[0].map((h) => h.trim());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const cJournal = find(/^journal$/i), cNature = find(/retractionnature/i), cReason = find(/^reason$/i);
  const cDate = find(/^retractiondate$/i), cType = find(/^articletype$/i);
  console.log(`  columns: ${header.join(' | ')}`);
  if (cJournal < 0) { console.log('  ! no "Journal" column found; send me the column list above'); return; }
  const body = rows.slice(1);
  raw.retractionWatch = { header, totalRecords: body.length, venues: {} };

  for (const v of VENUES) {
    const hits = body.filter((r) => v.rwMatch.test(r[cJournal] ?? '') && !(v.rwExclude?.test(r[cJournal] ?? '')));
    const tally = (col: number, split = false) => {
      const t: Record<string, number> = {};
      if (col < 0) return t;
      for (const r of hits) {
        const vals = split ? (r[col] ?? '').split(';').map((s) => s.replace(/^\+/, '').trim()).filter(Boolean) : [(r[col] ?? '').trim()];
        for (const x of vals) t[x] = (t[x] ?? 0) + 1;
      }
      return t;
    };
    const byNature = tally(cNature);
    const byReason = tally(cReason, true);
    const byType = tally(cType, true);
    const byYear: Record<string, number> = {};
    if (cDate >= 0) for (const r of hits) {
      const y = (r[cDate] ?? '').match(/(19|20)\d{2}/)?.[0];
      if (y) byYear[y] = (byYear[y] ?? 0) + 1;
    }
    raw.retractionWatch.venues[v.key] = {
      matchedJournalNames: [...new Set(hits.map((r) => r[cJournal]))].slice(0, 30),
      byNature, byReason, byType, byYear,
    };
    put('RW: records matched', v.key, hits.length);
    for (const [k, n] of Object.entries(byNature)) put(`RW: nature = ${k || '(blank)'}`, v.key, n);
    for (const [k, n] of Object.entries(byType)) put(`RW: article type = ${k || '(blank)'}`, v.key, n);
    for (const y of YEARS) if (byYear[y]) put(`RW: retracted in ${y}`, v.key, byYear[y]);
  }
}

// ─────────────────────────────────────────────────────────────
// 8. OpenAlex — journals by ISSN (conferences are split per edition there)
// ─────────────────────────────────────────────────────────────

async function exploreOpenAlex() {
  console.log('OpenAlex (API)');
  raw.openalex = {};
  for (const v of VENUES) {
    if (v.type !== 'journal' || !v.issn) continue;
    const s = await getJson(buildUrl(`https://api.openalex.org/sources/issn:${v.issn}`, { mailto: MAILTO, api_key: OPENALEX_KEY }));
    if (!s) continue;
    raw.openalex[v.key] = s;
    put('OpenAlex: works_count', v.key, s.works_count);
    put('OpenAlex: cited_by_count', v.key, s.cited_by_count);
    put('OpenAlex: 2yr_mean_citedness', v.key, s.summary_stats?.['2yr_mean_citedness']);
    put('OpenAlex: h_index', v.key, s.summary_stats?.h_index);
    put('OpenAlex: i10_index', v.key, s.summary_stats?.i10_index);
    put('OpenAlex: is_oa', v.key, s.is_oa);
    put('OpenAlex: is_in_doaj', v.key, s.is_in_doaj);
    put('OpenAlex: apc_usd', v.key, s.apc_usd);
    put('OpenAlex: country_code', v.key, s.country_code);
    put('OpenAlex: host_organization_name', v.key, s.host_organization_name);
    put('OpenAlex: type', v.key, s.type);
    const byYear = new Map<number, any>((s.counts_by_year ?? []).map((y: any) => [y.year, y]));
    for (const y of YEARS) {
      put(`OpenAlex: works in ${y}`, v.key, byYear.get(y)?.works_count);
      put(`OpenAlex: citations received in ${y}`, v.key, byYear.get(y)?.cited_by_count);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 9. Semantic Scholar — all venues, by venue name
// ─────────────────────────────────────────────────────────────

const S2_BULK = 'https://api.semanticscholar.org/graph/v1/paper/search/bulk';

async function exploreSemanticScholar() {
  console.log('Semantic Scholar (API) — the slow one');
  raw.s2 = {};
  for (const v of VENUES) {
    // Probe each candidate name on the last full year; use the first that returns papers
    let chosen: string | null = null;
    const probes: Record<string, number | null> = {};
    for (const name of v.s2Candidates) {
      const d = await getJson(buildUrl(S2_BULK, { venue: name, year: YEARS[YEARS.length - 1], fields: 'year' }));
      probes[name] = d ? Number(d.total ?? 0) : null;
      if (d && d.total > 0) { chosen = name; break; }
    }
    console.log(`  ${v.key}: ${chosen ? `using "${chosen}"` : 'no name matched'}`);
    raw.s2[v.key] = { probes, chosen };
    if (!chosen) continue;
    put('S2: venue name used', v.key, chosen);

    for (const y of YEARS) {
      const d = await getJson(buildUrl(S2_BULK, { venue: chosen, year: y, fields: 'year' }));
      if (d) put(`S2: papers in ${y}`, v.key, Number(d.total ?? 0));
    }

    // One cohort year, paper by paper; report raw totals only
    let token: string | undefined;
    let n = 0, cites = 0, influential = 0, refs = 0, openAccess = 0;
    const pubTypes: Record<string, number> = {};
    do {
      const d = await getJson(buildUrl(S2_BULK, {
        venue: chosen, year: COHORT_YEAR, token,
        fields: 'title,citationCount,influentialCitationCount,referenceCount,isOpenAccess,publicationTypes',
      }));
      if (!d) break;
      for (const p of d.data ?? []) {
        n++;
        cites += p.citationCount ?? 0;
        influential += p.influentialCitationCount ?? 0;
        refs += p.referenceCount ?? 0;
        if (p.isOpenAccess) openAccess++;
        for (const t of p.publicationTypes ?? ['(none)']) pubTypes[t] = (pubTypes[t] ?? 0) + 1;
      }
      token = d.token ?? undefined;
    } while (token);
    put(`S2: ${COHORT_YEAR} papers read`, v.key, n);
    put(`S2: ${COHORT_YEAR} papers, total citations`, v.key, cites);
    put(`S2: ${COHORT_YEAR} papers, total influential citations`, v.key, influential);
    put(`S2: ${COHORT_YEAR} papers, total references`, v.key, refs);
    put(`S2: ${COHORT_YEAR} papers, open access`, v.key, openAccess);
    for (const [t, c] of Object.entries(pubTypes)) put(`S2: ${COHORT_YEAR} papers, type = ${t}`, v.key, c);
  }
}

// ─────────────────────────────────────────────────────────────
// 10. Crossref — journals by ISSN
// ─────────────────────────────────────────────────────────────

async function exploreCrossref() {
  console.log('Crossref (API)');
  raw.crossref = {};
  for (const v of VENUES) {
    if (v.type !== 'journal' || !v.issn) continue;
    const j = await getJson(buildUrl(`https://api.crossref.org/journals/${v.issn}`, { mailto: MAILTO }));
    const m = j?.message;
    if (m) {
      raw.crossref[v.key] = m;
      put('Crossref: publisher', v.key, m.publisher);
      put('Crossref: total DOIs', v.key, m.counts?.['total-dois']);
      put('Crossref: current DOIs', v.key, m.counts?.['current-dois']);
      put('Crossref: backfile DOIs', v.key, m.counts?.['backfile-dois']);
      for (const [k, val] of Object.entries(m.coverage ?? {})) {
        if (typeof val === 'number') put(`Crossref: coverage ${k}`, v.key, val);
      }
      const byYear = new Map<number, number>((m.breakdowns?.['dois-by-issued-year'] ?? []).map((p: number[]) => [p[0], p[1]]));
      for (const y of YEARS) put(`Crossref: DOIs issued in ${y}`, v.key, byYear.get(y));
    }
    const r = await getJson(buildUrl('https://api.crossref.org/works', { filter: `issn:${v.issn},update-type:retraction`, rows: 0, mailto: MAILTO }));
    if (r) put('Crossref: retraction notices under ISSN', v.key, r.message?.['total-results']);
  }
}

// ─────────────────────────────────────────────────────────────
// 11. Main: run everything, write the metric × venue CSV
// ─────────────────────────────────────────────────────────────

const csvCell = (x: unknown) => {
  const s = x === undefined ? '' : String(x);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  exploreCore();
  exploreScimago();
  exploreRetractionWatch();
  await exploreOpenAlex();
  await exploreCrossref();
  await exploreSemanticScholar();

  const conf = VENUES.filter((v) => v.type === 'conference').map((v) => v.key);
  const jour = VENUES.filter((v) => v.type === 'journal').map((v) => v.key);
  const header = ['metric', ...conf, ...jour, 'conferences found', 'journals found'];
  const lines = [header.map(csvCell).join(',')];
  for (const [metric, vals] of [...table.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cf = conf.filter((k) => vals[k] !== undefined).length;
    const jf = jour.filter((k) => vals[k] !== undefined).length;
    lines.push([metric, ...conf.map((k) => vals[k]), ...jour.map((k) => vals[k]), `${cf}/${conf.length}`, `${jf}/${jour.length}`].map(csvCell).join(','));
  }
  mkdirSync('output/explore', { recursive: true });
  writeFileSync('output/explore/raw-metrics.csv', lines.join('\n'));
  writeFileSync('output/explore/raw.json', JSON.stringify({ exploredAt: new Date().toISOString(), years: YEARS, cohortYear: COHORT_YEAR, raw }, null, 2));

  // Short terminal summary: which metrics exist for all conferences / all journals
  console.log('\nMetrics found for ALL conferences:');
  for (const [m, vals] of table) if (conf.every((k) => vals[k] !== undefined)) console.log(`  ${m}`);
  console.log('\nMetrics found for ALL journals:');
  for (const [m, vals] of table) if (jour.every((k) => vals[k] !== undefined)) console.log(`  ${m}`);
  console.log(`\n${table.size} metrics total. Full grid: output/explore/raw-metrics.csv`);
}

main().catch((e) => { console.error(e); process.exit(1); });