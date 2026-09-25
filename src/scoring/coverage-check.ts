/**
 * coverage-check.ts  (v3)
 *
 * One-off research script: for each candidate venue, check which scoring
 * inputs actually exist in the public sources.
 *
 * History:
 *   v1  OpenAlex for everything. Journals were complete; conferences were split
 *       into one OpenAlex entry per edition, so no whole-venue numbers.
 *   v2  DBLP for conferences. DBLP's API is now behind a bot-blocker (Anubis)
 *       that requires running JavaScript, so no automated access. We do not
 *       try to get around it.
 *   v3  Semantic Scholar (S2) for ALL venues: papers per year + citations.
 *       Journals also keep OpenAlex + Crossref, which lets us cross-check
 *       S2's paper counts against OpenAlex's.
 *
 * Sources queried live:
 *   - Semantic Scholar  all venues: papers per year (last 10 full years),
 *                       citations per paper for one reference year
 *   - OpenAlex          journals: 2-yr citations, h-index, papers per year
 *   - Crossref          journals: retraction notices per ISSN (approximate)
 *
 * Filled in by hand (no API): CORE rank (conferences), SJR quartile (journals)
 *
 * Run from the didcal-poc folder:   npx tsx src/scoring/coverage-check.ts
 * Takes several minutes: about 1 request per second to Semantic Scholar.
 * Optional: set S2_API_KEY if you have a free Semantic Scholar API key (faster, fewer 429s).
 * Output: tables in the terminal + output/coverage.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────
// 1. Candidate venues
// ─────────────────────────────────────────────────────────────

type VenueType = 'conference' | 'journal';

interface CandidateVenue {
  key: string;
  name: string;
  type: VenueType;
  s2Venues: string[];    // venue name(s) as Semantic Scholar spells them; results are summed
  issn?: string;         // journals: used for OpenAlex + Crossref
  coreRank?: string;     // from portal.core.edu.au (ICORE2026)
  sjrQuartile?: string;  // from scimagojr.com
  note?: string;
}

const VENUES: CandidateVenue[] = [
  // ── Conferences ──
  { key: 'S&P',   type: 'conference', name: 'IEEE Symposium on Security and Privacy', coreRank: 'A*',
    s2Venues: ['IEEE Symposium on Security and Privacy'] },
  { key: 'CCS',   type: 'conference', name: 'ACM Conference on Computer and Communications Security', coreRank: 'A*',
    s2Venues: ['Conference on Computer and Communications Security', 'ACM Conference on Computer and Communications Security'] },
  { key: 'ACNS',  type: 'conference', name: 'Applied Cryptography and Network Security', coreRank: 'B',
    s2Venues: ['International Conference on Applied Cryptography and Network Security', 'Applied Cryptography and Network Security'] },
  { key: 'PST',   type: 'conference', name: 'Annual Conference on Privacy, Security and Trust', coreRank: 'C',
    s2Venues: ['International Conference on Privacy, Security and Trust', 'Annual Conference on Privacy, Security and Trust'] },
  { key: 'WASET', type: 'conference', name: 'World Academy of Science, Engineering and Technology',
    s2Venues: ['World Academy of Science, Engineering and Technology'],
    note: 'documented predatory publisher; not in CORE. "Not found" here is ambiguous: could be absent or named differently' },

  // ── Journals ──
  { key: 'TIFS',   type: 'journal', name: 'IEEE Transactions on Information Forensics and Security', issn: '1556-6013', sjrQuartile: 'Q1',
    s2Venues: ['IEEE Transactions on Information Forensics and Security'] },
  { key: 'Access', type: 'journal', name: 'IEEE Access', issn: '2169-3536', sjrQuartile: 'Q1', note: 'mega-journal',
    s2Venues: ['IEEE Access'] },
  { key: 'IJSN',   type: 'journal', name: 'International Journal of Security and Networks', issn: '1747-8405', sjrQuartile: 'Q4',
    s2Venues: ['International Journal of Security and Networks'] },
  { key: 'SCN',    type: 'journal', name: 'Security and Communication Networks', issn: '1939-0114',
    note: 'Hindawi; delisted from Web of Science 2023; no current quartile',
    s2Venues: ['Security and Communication Networks'] },
  { key: 'CIN',    type: 'journal', name: 'Computational Intelligence and Neuroscience', issn: '1687-5265', sjrQuartile: 'Q2',
    note: 'Hindawi; delisted 2023, closed for paper-mill activity',
    s2Venues: ['Computational Intelligence and Neuroscience'] },
];

// Last complete year. The current year is only partly over, so its counts are low.
const LAST_FULL_YEAR = new Date().getFullYear() - 1;

// Citations need time to accumulate, so we measure them on papers from a
// year that is old enough but not ancient: 3 years before the current year.
const CITATION_YEAR = LAST_FULL_YEAR - 2;

// ─────────────────────────────────────────────────────────────
// 2. Polite fetching: slow down per website, retry when told to
// ─────────────────────────────────────────────────────────────

const MAILTO = process.env.DIDCAL_MAILTO ?? '';
const OPENALEX_KEY = process.env.OPENALEX_API_KEY ?? '';
const S2_KEY = process.env.S2_API_KEY ?? '';

// Minimum gap between two requests to the same website, in milliseconds
const MIN_GAP_MS: Record<string, number> = {
  'api.semanticscholar.org': 1100,
  'api.crossref.org': 1000,
  'api.openalex.org': 200,
};
const lastRequestAt: Record<string, number> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Wait until enough time has passed since the last request to this website. */
async function waitForTurn(host: string) {
  const gap = MIN_GAP_MS[host] ?? 500;
  const wait = (lastRequestAt[host] ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt[host] = Date.now();
}

/**
 * GET a URL and parse JSON. Retries up to 4 times when the website is busy
 * (429/503), sends an HTML error page instead of JSON, or drops the connection.
 * Returns null if it still fails, or immediately on 404 (not found).
 */
async function getJson(url: string): Promise<any | null> {
  const host = new URL(url).host;
  const MAX_TRIES = 4;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await waitForTurn(host);
    const backoffMs = 5000 * 2 ** (attempt - 1); // 5s, 10s, 20s, 40s

    try {
      const headers: Record<string, string> = {
        'User-Agent': `didcal-poc/3.0 (research prototype; ${MAILTO || 'no-email'})`,
      };
      if (host === 'api.semanticscholar.org' && S2_KEY) headers['x-api-key'] = S2_KEY;
      const res = await fetch(url, { headers });

      if (res.status === 404) return null;

      if (res.status === 429 || res.status === 503) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs;
        console.warn(`  … ${host} says busy (HTTP ${res.status}), waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        console.warn(`  ! HTTP ${res.status} for ${url}`);
        return null;
      }

      const text = await res.text();
      if (text.trimStart().startsWith('<')) {
        // Got a web page instead of data — usually a rate-limit or error page
        console.warn(`  … ${host} sent a web page instead of data, waiting ${backoffMs / 1000}s`);
        await sleep(backoffMs);
        continue;
      }
      return JSON.parse(text);
    } catch (err) {
      console.warn(`  … connection to ${host} failed (${(err as Error).message}), waiting ${backoffMs / 1000}s`);
      await sleep(backoffMs);
    }
  }

  console.warn(`  ! gave up after ${MAX_TRIES} tries: ${url}`);
  return null;
}

// ─────────────────────────────────────────────────────────────
// 3. Shared helper: summarize papers-per-year counts
// ─────────────────────────────────────────────────────────────

interface YearSummary {
  countsByYear: Record<number, number>;  // full history we could get
  yearsActive?: string;                  // e.g. "2003–2025"
  latestFullYear?: string;               // e.g. "312 (2025)"
  peakOverMedian?: number;               // exploratory spike indicator, last 10 full years
  yearsWithPapersOf10?: number;          // how many of the last 10 full years had any papers
}

function summarizeYears(countsByYear: Record<number, number>): YearSummary {
  const years = Object.keys(countsByYear).map(Number).filter((y) => countsByYear[y] > 0).sort((a, b) => a - b);
  if (years.length === 0) return { countsByYear };

  const fullYears = years.filter((y) => y <= LAST_FULL_YEAR);
  const latest = fullYears[fullYears.length - 1];

  // Spike indicator: biggest year divided by the typical (median) year, over the last 10 full years.
  // A steady venue is near 1–2. A sudden paper-mill surge shows up as a large number.
  const window = [];
  for (let y = LAST_FULL_YEAR - 9; y <= LAST_FULL_YEAR; y++) window.push(countsByYear[y] ?? 0);
  const active = window.filter((n) => n > 0).sort((a, b) => a - b);
  const median = active.length ? active[Math.floor(active.length / 2)] : 0;
  const peak = Math.max(...window);

  return {
    countsByYear,
    yearsActive: `${years[0]}–${years[years.length - 1]}`,
    yearsWithPapersOf10: (() => {
      let n = 0;
      for (let y = LAST_FULL_YEAR - 9; y <= LAST_FULL_YEAR; y++) if ((countsByYear[y] ?? 0) > 0) n++;
      return n;
    })(),
    latestFullYear: latest !== undefined ? `${countsByYear[latest]} (${latest})` : undefined,
    peakOverMedian: median > 0 ? peak / median : undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// 4. Semantic Scholar — all venues
// ─────────────────────────────────────────────────────────────
// Uses the "bulk search" endpoint filtered by venue name and year.
// Each response reports a `total` (how many papers match), which is all we
// need for papers-per-year. For citations we read every paper of one year.

const S2_BULK = 'https://api.semanticscholar.org/graph/v1/paper/search/bulk';

// Proceedings include non-papers (copyright page, committee lists, ...).
// Totals can't exclude them, but the citation calculation does.
const FRONT_MATTER = /^(copyright|external reviewers|message from|welcome|preface|foreword|table of contents|author index|title page|front matter|committee|organizing committee|program committee|sponsors|index)\b/i;

/** Number of papers S2 lists for this venue name in this year. */
async function s2CountForYear(venue: string, year: number): Promise<number | null> {
  const data = await getJson(buildUrl(S2_BULK, { venue, year, fields: 'year' }));
  return data ? Number(data.total ?? 0) : null;
}

/** Citation counts of every paper this venue name published in `year`. */
async function s2CitationsForYear(venue: string, year: number): Promise<number[] | null> {
  const cites: number[] = [];
  let token: string | undefined;
  do {
    const data = await getJson(buildUrl(S2_BULK, { venue, year, fields: 'title,citationCount', token }));
    if (!data) return cites.length ? cites : null;
    for (const p of data.data ?? []) {
      if (FRONT_MATTER.test(String(p.title ?? '').trim())) continue;
      if (typeof p.citationCount === 'number') cites.push(p.citationCount);
    }
    token = data.token ?? undefined;
  } while (token);
  return cites;
}

const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

interface S2Result {
  perName: Record<string, number>;   // total papers found under each name (last 10 years), to spot naming problems
  summary: YearSummary;
  citationYear: number;
  citedPapers: number;
  meanCites?: number;
  medianCites?: number;
}

async function lookupS2(v: CandidateVenue): Promise<S2Result | null> {
  const counts: Record<number, number> = {};
  const perName: Record<string, number> = {};

  for (const name of v.s2Venues) {
    perName[name] = 0;
    for (let y = LAST_FULL_YEAR - 9; y <= LAST_FULL_YEAR; y++) {
      const n = await s2CountForYear(name, y);
      if (n === null) continue;
      counts[y] = (counts[y] ?? 0) + n;
      perName[name] += n;
    }
    console.log(`    S2 "${name}": ${perName[name]} papers in ${LAST_FULL_YEAR - 9}–${LAST_FULL_YEAR}`);
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const cites: number[] = [];
  for (const name of v.s2Venues) {
    if (perName[name] === 0) continue;
    const c = await s2CitationsForYear(name, CITATION_YEAR);
    if (c) cites.push(...c);
  }

  return {
    perName,
    summary: summarizeYears(counts),
    citationYear: CITATION_YEAR,
    citedPapers: cites.length,
    meanCites: cites.length ? cites.reduce((a, b) => a + b, 0) / cites.length : undefined,
    medianCites: median(cites),
  };
}

// ─────────────────────────────────────────────────────────────
// 5. OpenAlex — journals (exact lookup by ISSN)
// ─────────────────────────────────────────────────────────────

async function lookupOpenAlexJournal(issn: string) {
  const s = await getJson(
    buildUrl(`https://api.openalex.org/sources/issn:${issn}`, { mailto: MAILTO, api_key: OPENALEX_KEY }),
  );
  if (!s) return null;
  const counts: Record<number, number> = {};
  for (const y of s.counts_by_year ?? []) counts[y.year] = y.works_count;
  return {
    id: String(s.id).replace('https://openalex.org/', ''),
    name: s.display_name as string,
    twoYrMeanCitedness: s.summary_stats?.['2yr_mean_citedness'] as number | undefined,
    hIndex: s.summary_stats?.h_index as number | undefined,
    summary: summarizeYears(counts),
  };
}

// ─────────────────────────────────────────────────────────────
// 6. Crossref — retraction notices per ISSN (approximate)
// ─────────────────────────────────────────────────────────────

async function lookupRetractions(issn: string): Promise<{ retractions: number; total: number } | null> {
  const retr = await getJson(
    buildUrl('https://api.crossref.org/works', { filter: `issn:${issn},update-type:retraction`, rows: 0, mailto: MAILTO }),
  );
  const all = await getJson(
    buildUrl('https://api.crossref.org/works', { filter: `issn:${issn}`, rows: 0, mailto: MAILTO }),
  );
  if (!retr || !all) return null;
  return { retractions: retr.message['total-results'], total: all.message['total-results'] };
}

// ─────────────────────────────────────────────────────────────
// 7. Main
// ─────────────────────────────────────────────────────────────

const show = (x: unknown) =>
  x === undefined || x === null ? '—' : typeof x === 'number' ? +x.toFixed(2) : String(x);

async function main() {
  const rows: Record<string, string | number>[] = [];
  const crossCheck: Record<string, string | number>[] = [];
  const raw: any[] = [];

  for (const v of VENUES) {
    console.log(`- ${v.key}: checking…`);
    const s2 = await lookupS2(v);

    rows.push({
      venue: v.key,
      type: v.type,
      'rank tier': show(v.type === 'conference' ? v.coreRank : v.sjrQuartile),
      [`papers (${LAST_FULL_YEAR})`]: show(s2?.summary.countsByYear[LAST_FULL_YEAR]),
      'yrs w/ papers (of 10)': show(s2?.summary.yearsWithPapersOf10),
      'peak ÷ median': show(s2?.summary.peakOverMedian),
      [`mean cites (${CITATION_YEAR} papers)`]: show(s2?.meanCites),
      [`median cites (${CITATION_YEAR} papers)`]: show(s2?.medianCites),
    });

    let oa = null, retr = null;
    if (v.type === 'journal' && v.issn) {
      oa = await lookupOpenAlexJournal(v.issn);
      retr = await lookupRetractions(v.issn);
      crossCheck.push({
        venue: v.key,
        [`S2 papers (${LAST_FULL_YEAR})`]: show(s2?.summary.countsByYear[LAST_FULL_YEAR]),
        [`OpenAlex papers (${LAST_FULL_YEAR})`]: show(oa?.summary.countsByYear[LAST_FULL_YEAR]),
        'S2 peak ÷ median': show(s2?.summary.peakOverMedian),
        'OpenAlex peak ÷ median': show(oa?.summary.peakOverMedian),
        'OA 2yr cites': show(oa?.twoYrMeanCitedness),
        'retract/1k': retr && retr.total > 0 ? show((retr.retractions / retr.total) * 1000) : '—',
      });
    }
    raw.push({ venue: v, s2, openalex: oa, retractions: retr });
  }

  console.log('\nTable 1 — Semantic Scholar, all venues ("—" = not found):');
  console.table(rows);

  console.log('\nTable 2 — Journals: does Semantic Scholar agree with OpenAlex?');
  console.table(crossCheck);

  const metrics = Object.keys(rows[0] ?? {}).filter((k) => !['venue', 'type'].includes(k));
  const summary: Record<string, Record<string, string>> = {};
  for (const t of ['conference', 'journal'] as VenueType[]) {
    const ofType = rows.filter((r) => r.type === t);
    summary[t] = {};
    for (const m of metrics) summary[t][m] = `${ofType.filter((r) => r[m] !== '—').length}/${ofType.length}`;
  }
  console.log('\nTable 3 — Metric coverage by venue type (found / checked):');
  console.table(summary);

  mkdirSync('output', { recursive: true });
  writeFileSync(
    'output/coverage.json',
    JSON.stringify(
      { checkedAt: new Date().toISOString(), lastFullYear: LAST_FULL_YEAR, citationYear: CITATION_YEAR, rows, crossCheck, summary, raw },
      null,
      2,
    ),
  );
  console.log('\nSaved full results to output/coverage.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});