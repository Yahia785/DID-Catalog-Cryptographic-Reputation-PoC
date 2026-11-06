import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../shared/csv.js';
import type { InputValue, ScoreCohort } from '../shared/types.js';
import { buildCohort, buildInputs1, journalIssns } from '../scoring/build-score-1.js';
import { computeScore1 } from '../scoring/formula-1.js';
import { decodeScoreVC } from '../scoring/read-vc.js';
import { loadSnapshot, type Snapshot } from '../scoring/snapshot-store.js';
import { VENUES, type VenueEntry } from '../venues/registry.js';
import { CONF_ORDER, JOURNAL_ORDER, drawSubsets, summarizeChanges, type ChangeRow, type ChangeStats, type VenueKind } from './e4-lib.js';

/**
 * E4, sensitivity analysis: how stable are the formula-1.0 grades when the sample, the sources or the scaling change?
 * A pure recomputation from files on disk (no network, no signing, nothing under data/ or output/scores/ is written).
 *
 *   npx tsx src/analysis/e4-sensitivity.ts
 */

const SNAPSHOT = 'data/snapshots/f1-2026-10-28b';
const SCORES_DIR = 'output/scores/f1';
const OUT_DIR = 'output/analysis';
const SEED = 4242;                 // experiment (a): conferences use SEED, journals SEED + 1
const SUBSETS = 30, SUBSET_SIZE = 40;
const JOURNALS_JSON = 'output/data-check/openalex-scimago-cs-journals.json';   // written by src/scoring/data-check.ts (part 1A)

type Scope = 'all' | 'sampled';
const SCOPES: Scope[] = ['all', 'sampled'];
const isTest = (v: VenueEntry) => !v.role.startsWith('Sample');
const inScope = (v: VenueEntry, s: Scope) => s === 'all' || !isTest(v);
const TYPES: VenueKind[] = ['conference', 'journal'];
type PerScope = Record<Scope, ChangeStats>;
type PerType<T> = Record<VenueKind, T>;

// ── baseline ─────────────────────────────────────────────────
const snap: Snapshot = loadSnapshot(SNAPSHOT);
const inputsOf = new Map<string, InputValue[]>(VENUES.map((v) => [v.key, buildInputs1(v, snap)]));
const baseCohort: PerType<ScoreCohort> = { conference: buildCohort(snap, 'conference'), journal: buildCohort(snap, 'journal') };
const venuesOf = (t: VenueKind) => VENUES.filter((v) => v.type === t);
const grade = (v: VenueEntry, inputs: InputValue[], cohort: ScoreCohort) => computeScore1(v.type, inputs, cohort);
const baseline = new Map(VENUES.map((v) => [v.key, grade(v, inputsOf.get(v.key)!, baseCohort[v.type])]));

function sanityCheck() {
  const diffs: string[] = [];
  for (const v of VENUES) {
    const file = path.join(SCORES_DIR, `${v.slug}.vc.jwt`);
    if (!fs.existsSync(file)) { diffs.push(`${v.key}: ${file} missing`); continue; }
    const s = decodeScoreVC(fs.readFileSync(file, 'utf8')).subject;
    const b = baseline.get(v.key)!;
    if (s.class !== b.class || s.score !== b.score || JSON.stringify(s.flags) !== JSON.stringify(b.flags)) {
      diffs.push(`${v.key}: credential ${s.class}/${s.score}/[${s.flags}] vs recomputed ${b.class}/${b.score}/[${b.flags}]`);
    }
  }
  return { checked: VENUES.length, differences: diffs };
}

// ── helpers ──────────────────────────────────────────────────
const classOf = (key: string) => baseline.get(key)!.class as string;
const statsFor = (type: VenueKind, venues: VenueEntry[], to: (v: VenueEntry) => string): PerScope => {
  const out = {} as PerScope;
  for (const s of SCOPES) {
    const rows: ChangeRow[] = venues.filter((v) => inScope(v, s)).map((v) => ({ key: v.key, from: classOf(v.key), to: to(v) }));
    out[s] = summarizeChanges(type, rows);
  }
  return out;
};
const dropMetrics = (inputs: InputValue[], metrics: string[]) => inputs.map((i) => (metrics.includes(i.metric) ? { ...i, value: null } : i));
const cloneCohort = (c: ScoreCohort, o: { drop?: string[]; population?: number } = {}): ScoreCohort => {
  const values: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(c.values)) values[k] = o.drop?.includes(k) ? [] : [...v];
  return { ...c, values, ...(o.population !== undefined ? { populationSize: o.population } : {}) };
};
const num = (s: string | undefined) => Number((s ?? '').replace(',', '.'));
const sortAsc = (xs: number[]) => xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);

// ── (a) cohort composition ───────────────────────────────────
interface AggA { subsets: number; meanN: number; share: { mean: number; min: number; max: number }; meanShift: number | null; maxShift: number; meanUp: number; meanDown: number }
function experimentA() {
  const result = {} as PerType<{ params: object; aggregate: Record<Scope, AggA>; mostOften: Record<Scope, { key: string; baseline: string; test: boolean; changed: number; included: number }[]> }>;
  for (const type of TYPES) {
    const vs = venuesOf(type);
    const subsets = drawSubsets(vs.map((v) => v.key), SUBSET_SIZE, SUBSETS, type === 'conference' ? SEED : SEED + 1);
    const byKey = new Map(vs.map((v) => [v.key, v]));
    const per: Record<Scope, ChangeStats[]> = { all: [], sampled: [] };
    const changed = new Map<string, number>(), included = new Map<string, number>();
    for (const keys of subsets) {
      const members = keys.map((k) => byKey.get(k)!);
      const cohort = buildCohort(snap, type, members);   // the cohort of these 40 venues only; the population stays 800
      const to = (v: VenueEntry) => grade(v, inputsOf.get(v.key)!, cohort).class as string;
      const st = statsFor(type, members, to);
      for (const s of SCOPES) per[s].push(st[s]);
      for (const c of st.all.changes) changed.set(c.key, (changed.get(c.key) ?? 0) + 1);
      for (const k of keys) included.set(k, (included.get(k) ?? 0) + 1);
    }
    const aggregate = {} as Record<Scope, AggA>;
    const mostOften = {} as Record<Scope, { key: string; baseline: string; test: boolean; changed: number; included: number }[]>;
    for (const s of SCOPES) {
      const xs = per[s], mean = (f: (x: ChangeStats) => number) => xs.reduce((a, x) => a + f(x), 0) / xs.length;
      const shares = xs.map((x) => x.shareChanged);
      const means = xs.map((x) => x.meanAbsShift).filter((x): x is number => x !== null);
      aggregate[s] = {
        subsets: xs.length, meanN: mean((x) => x.n), share: { mean: mean((x) => x.shareChanged), min: Math.min(...shares), max: Math.max(...shares) },
        meanShift: means.length ? means.reduce((a, b) => a + b, 0) / means.length : null, maxShift: Math.max(...xs.map((x) => x.maxShift)),
        meanUp: mean((x) => x.up), meanDown: mean((x) => x.down),
      };
      mostOften[s] = vs.filter((v) => inScope(v, s)).map((v) => ({ key: v.key, baseline: classOf(v.key), test: isTest(v), changed: changed.get(v.key) ?? 0, included: included.get(v.key) ?? 0 }))
        .sort((a, b) => b.changed - a.changed || (b.changed / (b.included || 1)) - (a.changed / (a.included || 1)) || a.key.localeCompare(b.key)).slice(0, 10);
    }
    result[type] = { params: { subsets: SUBSETS, subsetSize: SUBSET_SIZE, seed: type === 'conference' ? SEED : SEED + 1, populationSize: type === 'conference' ? 800 : null }, aggregate, mostOften };
  }
  return result;
}

// ── (b) one source removed ───────────────────────────────────
const SCENARIOS_B: Record<VenueKind, { name: string; metrics: string[]; cohortKeys: string[] }[]> = {
  conference: [
    { name: 'without ICORE', metrics: ['icore.rank'], cohortKeys: [] },
    { name: 'without OpenAlex', metrics: ['openalex.hIndex', 'openalex.citedByCount'], cohortKeys: ['conf.openalex.hIndex'] },
    { name: 'without SCImago', metrics: ['scimago.hIndex'], cohortKeys: ['conf.scimago.hIndex'] },
  ],
  journal: [
    { name: 'without SJR', metrics: ['scimago.sjr'], cohortKeys: ['journal.scimago.sjr'] },
    { name: 'without OpenAlex citedness', metrics: ['openalex.twoYrMeanCitedness'], cohortKeys: ['journal.openalex.twoYrMeanCitedness'] },
  ],
};
function experimentB() {
  const out: { type: VenueKind; scenario: string; stats: PerScope }[] = [];
  for (const type of TYPES) for (const sc of SCENARIOS_B[type]) {
    const cohort = cloneCohort(baseCohort[type], { drop: sc.cohortKeys });
    out.push({ type, scenario: sc.name, stats: statsFor(type, venuesOf(type), (v) => grade(v, dropMetrics(inputsOf.get(v.key)!, sc.metrics), cohort).class as string) });
  }
  return out;
}

// ── (c) population size ──────────────────────────────────────
function experimentC() {
  return [600, 1000].map((population) => {
    const cohort = cloneCohort(baseCohort.conference, { population });
    return { type: 'conference' as const, scenario: `population ${population}`, stats: statsFor('conference', venuesOf('conference'), (v) => grade(v, inputsOf.get(v.key)!, cohort).class as string) };
  });
}

// ── (d) journals against the full SCImago Computer Science population ──
// The criteria below are copied from src/venues/select-sample.ts (that file cannot be imported: it runs on import).
const CS_CATEGORIES = new Set([
  'Artificial Intelligence', 'Computational Theory and Mathematics', 'Computer Graphics and Computer-Aided Design',
  'Computer Networks and Communications', 'Computer Science (miscellaneous)', 'Computer Science Applications',
  'Computer Vision and Pattern Recognition', 'Hardware and Architecture', 'Human-Computer Interaction',
  'Information Systems', 'Signal Processing', 'Software',
]);
const JOURNAL_WORKS_MIN = 50;
interface PopRow { sourceid: string; issns: string[]; sjr: number | null; citedness: number | null; worksCount: number | null; tight: boolean }

function loadPopulation() {
  const rows = readCsv('data/scimago.csv', ';'), hd = rows[0];
  const col = (n: string) => hd.indexOf(n);
  const iId = col('Sourceid'), iType = col('Type'), iAreas = col('Areas'), iSjr = col('SJR'), iCats = col('Categories'), iIssn = col('Issn');
  const normIssn = (s: string) => s.replace(/[^0-9Xx]/g, '').toUpperCase();
  const saved = JSON.parse(fs.readFileSync(JOURNALS_JSON, 'utf8')) as { retrieved: string; journals: { sourceid: string; oa: { works_count?: number; summary_stats?: Record<string, number> } | null }[] };
  const oaById = new Map(saved.journals.map((j) => [String(j.sourceid), j.oa]));
  const mostlyCs = (r: string[]) => {
    const cats = (r[iCats] ?? '').split(';').map((c) => c.replace(/\s*\(Q\d\)\s*$/, '').trim()).filter(Boolean);
    return cats.length > 0 && cats.filter((c) => CS_CATEGORIES.has(c)).length * 2 >= cats.length;
  };
  const pop: PopRow[] = rows.slice(1).filter((r) => r[iType] === 'journal' && (r[iAreas] ?? '').includes('Computer Science')).map((r) => {
    const oa = oaById.get(r[iId]);
    const cit = oa?.summary_stats?.['2yr_mean_citedness'];
    const sjr = num(r[iSjr]);
    return {
      sourceid: r[iId], issns: (r[iIssn] ?? '').split(',').map(normIssn).filter((i) => i.length === 8),
      sjr: Number.isFinite(sjr) && (r[iSjr] ?? '').trim() !== '' ? sjr : null, citedness: typeof cit === 'number' ? cit : null, worksCount: oa?.works_count ?? null,
      tight: mostlyCs(r) && typeof cit === 'number' && (oa?.works_count ?? 0) >= JOURNAL_WORKS_MIN,
    };
  });
  return { pop, retrieved: saved.retrieved, savedJournals: saved.journals.length };
}

function experimentD() {
  const { pop, retrieved, savedJournals } = loadPopulation();
  const defs = [
    { name: 'all SCImago CS-area journals', rows: pop },
    { name: 'tightened pool (>= half CS categories, OpenAlex citedness, >= 50 works)', rows: pop.filter((p) => p.tight) },
  ];
  const sizes = defs.map((d) => ({ name: d.name, journals: d.rows.length, withSjr: d.rows.filter((r) => r.sjr !== null).length, withCitedness: d.rows.filter((r) => r.citedness !== null).length }));
  const journals = venuesOf('journal');
  const ownRow = (v: VenueEntry, rows: PopRow[]) => {
    if (v.scimagoId) return v.scimagoId;
    const issns = journalIssns(v, snap);
    return pop.find((p) => p.issns.some((i) => issns.includes(i)))?.sourceid;   // not in SCImago at all: undefined
  };
  const notInPop: Record<string, string[]> = {};
  const results = defs.map((d) => {
    notInPop[d.name] = [];
    const stats = statsFor('journal', journals, (v) => {
      // The journal's own snapshot value replaces its population entry (or is added if it is not in the population), so it is ranked within a population that contains it exactly once.
      const own = ownRow(v, d.rows);
      if (!own || !d.rows.some((r) => r.sourceid === own)) notInPop[d.name].push(v.key);
      const mine = new Map(inputsOf.get(v.key)!.map((i) => [i.metric, i.value]));
      const others = d.rows.filter((r) => r.sourceid !== own);
      const sjr = mine.get('scimago.sjr'), cit = mine.get('openalex.twoYrMeanCitedness');
      const cohort: ScoreCohort = { id: `e4/${d.name}`, values: {
        'journal.scimago.sjr': sortAsc([...others.map((r) => r.sjr), ...(typeof sjr === 'number' ? [sjr] : [])].filter((x): x is number => x !== null)),
        'journal.openalex.twoYrMeanCitedness': sortAsc([...others.map((r) => r.citedness), ...(typeof cit === 'number' ? [cit] : [])].filter((x): x is number => x !== null)),
      } };
      return grade(v, inputsOf.get(v.key)!, cohort).class as string;
    });
    return { population: d.name, stats };
  });
  return { dataCheckFile: JOURNALS_JSON, dataCheckRetrieved: retrieved, savedJournals, citednessAvailable: true, sizes, notInPopulation: notInPop, results };
}

// ── report ───────────────────────────────────────────────────
const sortedCounts = (m: Record<string, number>, order: string[]) => Object.entries(m).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
const pct = (x: number) => `${x.toFixed(1)}%`;
const f2 = (x: number | null) => (x === null ? 'n/a' : x.toFixed(2));
const testKeys = new Set(VENUES.filter(isTest).map((v) => v.key));
const mark = (k: string) => (testKeys.has(k) ? `${k}*` : k);
const changeList = (s: ChangeStats) => (s.changes.length ? s.changes.map((c) => `${mark(c.key)} (${c.from}→${c.to})`).join(', ') : 'none');

function statsTable(rows: { scenario: string; type: VenueKind; stats: PerScope }[], withUnrated: boolean) {
  const head = `| Scenario | Type | Scope | Venues | Changed | Mean abs. shift | Largest | Up | Down |${withUnrated ? ' To/from Not rated | Unrated before → after |' : ''}\n|---|---|---|---:|---:|---:|---:|---:|---:|${withUnrated ? '---:|---:|' : ''}`;
  const body = rows.flatMap((r) => SCOPES.map((s) => {
    const x = r.stats[s];
    return `| ${r.scenario} | ${r.type} | ${s === 'all' ? 'all 100' : '87 sampled'} | ${x.n} | ${x.changed} (${pct(x.shareChanged)}) | ${f2(x.meanAbsShift)} | ${x.maxShift} | ${x.up} | ${x.down} |${withUnrated ? ` ${x.notRatedChanges} | ${x.unrated.before} → ${x.unrated.after} |` : ''}`;
  }));
  return [head, ...body].join('\n');
}
const changedLists = (rows: { scenario: string; type: VenueKind; stats: PerScope }[]) =>
  rows.map((r) => `- **${r.scenario}, ${r.type}s** — ${changeList(r.stats.all)}`).join('\n');

function main() {
  console.log(`E4 sensitivity analysis, snapshot ${SNAPSHOT}`);
  const nSampled = VENUES.filter((v) => !isTest(v)).length;
  if (VENUES.length !== 100 || nSampled !== 87) throw new Error(`expected 100 venues (87 sampled), found ${VENUES.length} (${nSampled})`);

  const sanity = sanityCheck();
  if (sanity.differences.length) {
    console.error(`SANITY CHECK FAILED: ${sanity.differences.length} of ${sanity.checked} differ from the signed credentials`);
    for (const d of sanity.differences) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log(`sanity check: all ${sanity.checked} recomputed grades (class, points, flags) equal the signed credentials in ${SCORES_DIR}`);

  const baselineCounts = Object.fromEntries(TYPES.map((t) => {
    const m: Record<string, number> = {};
    for (const v of venuesOf(t)) m[classOf(v.key)] = (m[classOf(v.key)] ?? 0) + 1;
    return [t, m];
  }));
  const A = experimentA(), B = experimentB(), C = experimentC(), D = experimentD();
  const startedAt = new Date().toISOString();

  const json = {
    experiment: 'E4 sensitivity', generatedAt: startedAt, snapshot: SNAPSHOT, formulaVersion: '1.0',
    baseCohorts: { conference: baseCohort.conference.id, journal: baseCohort.journal.id },
    venues: { all: VENUES.length, sampled: nSampled, test: VENUES.length - nSampled },
    sanityCheck: { ...sanity, result: 'passed' }, baselineCounts, a: A, b: B, c: C, d: D,
  };

  // markdown
  const aAgg = (t: VenueKind, s: Scope) => A[t].aggregate[s];
  const row = (scenario: string, type: VenueKind, stats: PerScope) => ({ scenario, type, stats });
  const bRows = B.map((r) => row(r.scenario, r.type, r.stats)), cRows = C.map((r) => row(r.scenario, r.type, r.stats));
  const dRows = D.results.map((r) => row(r.population, 'journal', r.stats));
  const summary = [
    `**Baseline.** All ${VENUES.length} recomputed grades equal the signed credentials (class, points, flags).`,
    `**(a) Different sample.** Ranking each venue within a random 40 of its 50 peers changes the class of ${pct(aAgg('conference', 'all').share.mean)} of conferences on average (range ${pct(aAgg('conference', 'all').share.min)}–${pct(aAgg('conference', 'all').share.max)}, mean shift ${f2(aAgg('conference', 'all').meanShift)} classes) and ${pct(aAgg('journal', 'all').share.mean)} of journals (range ${pct(aAgg('journal', 'all').share.min)}–${pct(aAgg('journal', 'all').share.max)}, mean shift ${f2(aAgg('journal', 'all').meanShift)} bands).`,
    `**(b) One source removed.** ${bRows.map((r) => `${r.scenario} (${r.type}s): ${pct(r.stats.all.shareChanged)} changed`).join('; ')}.`,
    `**(c) Population size.** For conferences, 600 instead of 800 changes ${pct(cRows[0].stats.all.shareChanged)}; 1,000 changes ${pct(cRows[1].stats.all.shareChanged)}.`,
    `**(d) Full journal population.** Ranking the 50 journals against ${dRows.map((r, i) => `${D.sizes[i].journals.toLocaleString('en')} journals (${r.scenario})`).join(' or against ')} changes ${dRows.map((r) => pct(r.stats.all.shareChanged)).join(' and ')} of them, respectively${dRows.every((r) => r.stats.all.down >= r.stats.all.up) ? ' (more moves down than up)' : ''}. 2-year citedness was available (read from the data-check file), so both indicators were used.`,
  ];

  const aTable = ['| Type | Scope | Subsets | Venues per subset | Share changed: mean | min | max | Mean abs. shift | Largest shift | Mean up per subset | Mean down per subset |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...TYPES.flatMap((t) => SCOPES.map((s) => { const x = aAgg(t, s); return `| ${t} | ${s === 'all' ? 'all 100' : '87 sampled'} | ${x.subsets} | ${x.meanN.toFixed(1)} | ${pct(x.share.mean)} | ${pct(x.share.min)} | ${pct(x.share.max)} | ${f2(x.meanShift)} | ${x.maxShift} | ${x.meanUp.toFixed(2)} | ${x.meanDown.toFixed(2)} |`; }))].join('\n');
  const topTables = TYPES.flatMap((t) => SCOPES.map((s) =>
    `**Ten venues that changed most often — ${t}s, ${s === 'all' ? 'all 100' : '87 sampled'}** (* = test venue)\n\n| Venue | Baseline class | Changed in | of subsets containing it |\n|---|---|---:|---:|\n${A[t].mostOften[s].map((m) => `| ${m.test ? `${m.key}*` : m.key} | ${m.baseline} | ${m.changed} | ${m.included} |`).join('\n')}`));

  const dSizes = ['| Population | Journals | With SJR | With 2-year citedness |', '|---|---:|---:|---:|', ...D.sizes.map((s) => `| ${s.name} | ${s.journals} | ${s.withSjr} | ${s.withCitedness} |`)].join('\n');

  const md = `# E4 — Sensitivity of the formula 1.0 grades

Snapshot \`${SNAPSHOT}\`, formula 1.0, generated ${startedAt}. A grade "changes" when its class differs from the baseline. Shifts are measured in steps (conferences: A++, A+, A, A-, B, B-, C, Work in progress; journals: bands 200, 140, 100, 70, 40, 20). "Not rated" journals count as changed but are left out of the step statistics (column "To/from Not rated"). The mean absolute shift is taken over all venues in the row (unchanged ones count 0). * marks a test venue; the sampled-only lists are the same lists without the starred venues. Up = better class.

## Summary

${summary.map((s) => `- ${s}`).join('\n')}

## Baseline

All ${VENUES.length} recomputed grades equal the signed credentials in \`${SCORES_DIR}\` (class, points and flags). Conferences: ${sortedCounts(baselineCounts.conference, CONF_ORDER).map(([k, n]) => `${k} ${n}`).join(', ')}. Journals: ${sortedCounts(baselineCounts.journal, [...JOURNAL_ORDER, 'Not rated']).map(([k, n]) => `${k} ${n}`).join(', ')}.

## (a) Cohort composition: 30 random subsets of 40 of the 50 venues of each type

Seed ${SEED} for conferences and ${SEED + 1} for journals (mulberry32, partial Fisher–Yates). The cohort is rebuilt from the 40 venues only and only those 40 are re-graded; the conference population stays 800. Under "87 sampled" the test venues are left out of each subset's statistics.

${aTable}

${topTables.join('\n\n')}

## (b) One source removed at a time

The source's inputs are set to missing for every venue and its values are removed from the cohort. "Unrated" = Work in progress (conferences) or Not rated (journals).

${statsTable(bRows, true)}

Venues that changed (all 100):

${changedLists(bRows)}

## (c) Population size (conferences)

r = ceil(p / N × M) with M = 600 or 1,000 instead of 800.

${statsTable(cRows, false)}

Venues that changed (all 100):

${changedLists(cRows)}

## (d) Journals against the full SCImago Computer Science population

Population data from the data check (\`${JOURNALS_JSON}\`, retrieved ${D.dataCheckRetrieved}); SJR from \`data/scimago.csv\`; 2-year citedness as saved by the data check (no download). Each journal's own snapshot value replaces its entry in the population (or is added if it is not in it), so it is ranked within a population that contains it once. The tightened pool applies the rules of \`src/venues/select-sample.ts\`.

${dSizes}

${statsTable(dRows, true)}

Journals that changed (all 100 venues; only the 50 journals are affected):

${changedLists(dRows)}

Journals not found in the population: ${Object.entries(D.notInPopulation).map(([k, v]) => `${k}: ${v.length ? v.join(', ') : 'none'}`).join('; ')}.
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = startedAt.replace(/:/g, '-');
  fs.writeFileSync(path.join(OUT_DIR, `e4-${stamp}.json`), JSON.stringify(json, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, `e4-${stamp}.md`), md);
  console.log(`\n${md}\nwritten: ${OUT_DIR}/e4-${stamp}.json and .md`);
}

main();
