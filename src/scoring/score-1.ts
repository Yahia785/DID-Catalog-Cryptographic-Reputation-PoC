import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { cachingResolver, countFetch, printSummaries, runChecks } from '../bench/score-bench.js';
import { summarize, type Summary } from '../bench/stats.js';
import { loadPlatform, saveJson } from '../identity/identity-store.js';
import { cachedResolver } from '../identity/plc-cache.js';
import { onlineResolver } from '../identity/resolve-did.js';
import type { ScoreCohort, ScorePayload, VenueType } from '../shared/types.js';
import { VENUES } from '../venues/registry.js';
import { loadVenueRecords } from '../venues/venue-records.js';
import { buildCohort, buildInputs1, scoreFromInputs1 } from './build-score-1.js';
import { issueScore } from './issue-score.js';
import { SNAPSHOTS_ROOT, loadSnapshot, slot } from './snapshot-store.js';

/**
 * npx tsx src/scoring/score-all.ts --formula=1.0 --snapshot=f1-2026-10-28 [--bench]
 *
 * Issue formula 1.0 credentials for every venue from a formula-1.0 snapshot into output/scores/f1/
 * (the 0.1-demo credentials in output/scores/ are not touched), write output/scores/f1/results.md
 * and, with --bench, measure the cost (benchmark 3: issuing and checking; benchmark 4: sizes) into
 * output/bench/score-run-<ISO>.json.
 *
 * Nothing is published anywhere: the credentials are files.
 */

export const F1_DIR = path.resolve('output/scores/f1');
const ONLINE_GAP_MS = 200;   // between plc.directory requests

interface IssueRow {
  key: string; type: VenueType; buildInputsMs: number; computeMs: number; signMs: number; writeMs: number; totalMs: number;
  jwtBytes: number; cohortBytes: number;
}

const CLASS_ORDER = ['A++', 'A+', 'A', 'A-', 'B', 'B-', 'C', 'Work in progress'];
const BAND_ORDER = ['200', '140', '100', '70', '40', '20', 'Not rated'];
const ms = (x: number) => Math.round(x * 1000) / 1000;

/** Bytes of the cohort inside the signed JWT: the base64url growth it causes in the credential payload. */
function cohortBytesIn(jwt: string): number {
  const [h, p] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const withIt = Buffer.from(JSON.stringify(claims)).toString('base64url').length;
  delete claims.vc.credentialSubject.provenanceManifest.cohort;
  return withIt - Buffer.from(JSON.stringify(claims)).toString('base64url').length;
}

export async function scoreFormula1(snapshotName: string, bench: boolean) {
  const runStart = performance.now();
  const startedAt = new Date().toISOString();
  const snapshot = loadSnapshot(path.join(SNAPSHOTS_ROOT, snapshotName));
  if (snapshot.index.formula !== '1.0') throw new Error(`${snapshot.dir} is not a formula 1.0 snapshot (make one with: npx tsx src/scoring/snapshot.ts --formula=1.0)`);
  if (snapshot.index.failures?.length) throw new Error(`${snapshot.dir} has ${snapshot.index.failures.length} failed value(s); collect it again before scoring`);
  const platform = loadPlatform();
  const records = loadVenueRecords();

  console.log(chalk.bold(`\n=== DIDcal: formula 1.0 credentials ===`));
  console.log(chalk.gray(`snapshot ${snapshot.dir}   issuer ${platform.did}   output ${path.relative('.', F1_DIR)}\n`));

  // one cohort per venue type, shared by every credential of that type
  const cohorts = {} as Record<VenueType, ScoreCohort>;
  const cohortBuildMs = {} as Record<VenueType, number>;
  for (const type of ['conference', 'journal'] as const) {
    const t = performance.now();
    cohorts[type] = buildCohort(snapshot, type);
    cohortBuildMs[type] = ms(performance.now() - t);
    const sizes = Object.entries(cohorts[type].values).map(([k, v]) => `${k.split('.').slice(1).join('.')} ${v.length}`).join(', ');
    console.log(chalk.gray(`  cohort ${cohorts[type].id}  (${sizes}; built in ${cohortBuildMs[type]} ms)`));
  }
  console.log();

  fs.mkdirSync(F1_DIR, { recursive: true });
  const computedAt = new Date().toISOString();
  const rows: IssueRow[] = [];
  const summary: unknown[] = [];
  const jwts: { key: string; jwt: string }[] = [];
  const payloads = new Map<string, ScorePayload>();

  for (const venue of VENUES) {
    const record = records[venue.key];
    if (!record?.published) throw new Error(`${venue.key} has no published DID in output/venues.json`);
    const t0 = performance.now();
    const inputs = buildInputs1(venue, snapshot);
    const t1 = performance.now();
    const score = scoreFromInputs1({ venue, venueDID: record.did, platformDID: platform.did, snapshot, inputs, cohort: cohorts[venue.type], computedAt });
    const t2 = performance.now();
    const vc = await issueScore(platform, score);
    const t3 = performance.now();
    const base = path.join(F1_DIR, venue.slug);
    fs.writeFileSync(`${base}.vc.jwt`, vc.jwt);
    saveJson(`${base}.manifest.json`, vc.manifest);
    saveJson(`${base}.score.json`, vc.payload);
    const t4 = performance.now();

    rows.push({
      key: venue.key, type: venue.type, buildInputsMs: ms(t1 - t0), computeMs: ms(t2 - t1), signMs: ms(t3 - t2), writeMs: ms(t4 - t3), totalMs: ms(t4 - t0),
      jwtBytes: Buffer.byteLength(vc.jwt), cohortBytes: cohortBytesIn(vc.jwt),
    });
    jwts.push({ key: venue.key, jwt: vc.jwt });
    payloads.set(venue.key, vc.payload);
    summary.push({ key: venue.key, slug: venue.slug, type: venue.type, did: record.did, score: vc.payload.score, class: vc.payload.class, confidence: vc.payload.confidence, flags: vc.payload.flags });
    console.log(`  ${chalk.green('✓')} ${venue.key.padEnd(10)} ${String(vc.payload.class).padEnd(17)} ${vc.payload.score === null ? '  —  ' : vc.payload.score.toFixed(1).padStart(5)}  ${vc.payload.confidence.present}/${vc.payload.confidence.total}  ${chalk.gray(vc.payload.flags.join(' · '))}`);
  }
  const issueWallMs = performance.now() - runStart;

  saveJson(path.join(F1_DIR, 'index.json'), {
    computedAt, snapshot: snapshot.dir, formulaVersion: '1.0', issuer: platform.did,
    cohorts: { conference: cohorts.conference.id, journal: cohorts.journal.id }, venues: summary,
  });
  writeResults(snapshot, payloads);
  console.log(chalk.gray(`\nSigned credentials, index.json and results.md saved to ${path.relative('.', F1_DIR)}${path.sep}\n`));

  if (!bench) return;

  // ── benchmark 3: issuing ──
  const col = (f: (r: IssueRow) => number, type?: VenueType) => summarize(rows.filter((r) => !type || r.type === type).map(f));
  const issue: Record<string, Summary | null> = {
    buildInputsMs: col((r) => r.buildInputsMs), computeMs: col((r) => r.computeMs), signMs: col((r) => r.signMs), writeMs: col((r) => r.writeMs), totalMs: col((r) => r.totalMs),
  };
  printSummaries('Issuing, per venue (ms)', issue);
  console.log(chalk.gray(`  cohort build once per type: conference ${cohortBuildMs.conference} ms, journal ${cohortBuildMs.journal} ms; issuing wall time ${(issueWallMs / 1000).toFixed(2)} s`));

  // ── benchmark 4: sizes ──
  const sizeSummary = (type?: VenueType) => ({
    jwtBytes: col((r) => r.jwtBytes, type), cohortBytes: col((r) => r.cohortBytes, type),
    cohortShare: col((r) => r.cohortBytes / r.jwtBytes, type),
  });
  const sizes = { all: sizeSummary(), conference: sizeSummary('conference'), journal: sizeSummary('journal') };
  for (const [name, s] of Object.entries(sizes)) printSummaries(`Credential size, ${name} (bytes; cohortShare = fraction of the JWT)`, s as Record<string, Summary | null>, { cohortShare: 3, jwtBytes: 0, cohortBytes: 0 });

  // ── benchmark 3: checking ──
  const items = jwts;
  const offline = await runChecks('offline (cached audit logs)', items, cachedResolver);
  printSummaries(`Checking offline, per credential (ms) — ${offline.credentials} checked, ${offline.failed} failed`, offline.summary as Record<string, Summary | null>);

  const restore = countFetch(ONLINE_GAP_MS);
  let online, onlineCached, onlineWarm;
  try {
    online = await runChecks('online (plc.directory, no cache)', items, onlineResolver);
    const cache = cachingResolver(onlineResolver);
    onlineCached = await runChecks('online with a per-DID cache (starts empty)', items, cache);
    onlineWarm = await runChecks('online with the cache already filled', items, cache);
  } finally { restore(); }
  for (const run of [online, onlineCached, onlineWarm]) {
    printSummaries(`Checking ${run.label}, per credential — ${run.credentials} checked, ${run.failed} failed`, run.summary as Record<string, Summary | null>, { requestsPerCheck: 2, bytesPerCheck: 0 });
    console.log(chalk.gray(`  ${run.requests} requests, ${run.bytes} bytes in total; wall ${run.wallSeconds.toFixed(1)} s of which ${run.politenessWaitSeconds.toFixed(1)} s politeness waits (not in the times above)`));
  }

  fs.mkdirSync('output/bench', { recursive: true });
  const file = `output/bench/score-run-${startedAt.replace(/:/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({
    startedAt, formula: '1.0', snapshot: snapshot.dir, venues: VENUES.length, cohorts: { conference: cohorts.conference.id, journal: cohorts.journal.id },
    issue: { wallSeconds: issueWallMs / 1000, cohortBuildMs, summary: issue, rows },
    sizes: { summary: sizes },
    checkOffline: offline, checkOnline: online, checkOnlineCached: onlineCached, checkOnlineWarmCache: onlineWarm,
    politenessGapMs: ONLINE_GAP_MS,
    wallSecondsTotal: (performance.now() - runStart) / 1000,
  }, null, 1));
  console.log(chalk.gray(`\nbenchmark saved to ${file}\n`));
}

// ── results.md ───────────────────────────────────────────────
function crossTab(rowLabels: string[], colLabels: string[], pairs: [string, string][]): string {
  const n = (r: string, c: string) => pairs.filter(([a, b]) => a === r && b === c).length;
  const head = `| | ${colLabels.join(' | ')} | total |\n|---|${colLabels.map(() => '---:').join('|')}|---:|`;
  const body = rowLabels.filter((r) => pairs.some(([a]) => a === r)).map((r) => `| **${r}** | ${colLabels.map((c) => n(r, c)).join(' | ')} | ${pairs.filter(([a]) => a === r).length} |`);
  const total = `| **total** | ${colLabels.map((c) => pairs.filter(([, b]) => b === c).length).join(' | ')} | ${pairs.length} |`;
  return [head, ...body, total].join('\n');
}

function writeResults(snapshot: ReturnType<typeof loadSnapshot>, payloads: Map<string, ScorePayload>) {
  const s = snapshot.sources;
  const cls = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
  const flagText = (p: ScorePayload) => (p.flags.length ? p.flags.join('; ') : '');
  const rank = (p: ScorePayload) => p.score ?? -1;

  const confs = VENUES.filter((v) => v.type === 'conference').map((v) => ({ v, p: payloads.get(v.key)!, icore: slot(s.icore, v.key)?.rank ?? 'not in ICORE' }));
  confs.sort((a, b) => CLASS_ORDER.indexOf(a.p.class!) - CLASS_ORDER.indexOf(b.p.class!) || rank(b.p) - rank(a.p) || a.v.key.localeCompare(b.v.key));
  const jours = VENUES.filter((v) => v.type === 'journal').map((v) => ({ v, p: payloads.get(v.key)!, quartile: slot(s.scimago, v.key)?.quartile ?? 'not in SCImago' }));
  jours.sort((a, b) => BAND_ORDER.indexOf(a.p.class!) - BAND_ORDER.indexOf(b.p.class!) || rank(b.p) - rank(a.p) || a.v.key.localeCompare(b.v.key));

  const confRows = confs.map(({ v, p, icore }) =>
    `| ${v.key} | ${v.name} | ${icore} | ${p.class} | ${p.score ?? '—'} | ${cls(p.breakdown.icoreClass)} / ${cls(p.breakdown.openalexClass)} / ${cls(p.breakdown.scimagoClass)} | ${flagText(p)} |`);
  const jourRows = jours.map(({ v, p, quartile }) =>
    `| ${v.key} | ${v.name} | ${quartile} | ${p.class} | ${p.score ?? '—'} | ${cls(p.breakdown.sjrPercentile)} / ${cls(p.breakdown.citednessPercentile)} | ${flagText(p)} |`);

  const flagCounts = (list: { p: ScorePayload }[]) => {
    const m = new Map<string, number>();
    for (const { p } of list) for (const f of p.flags) m.set(f, (m.get(f) ?? 0) + 1);
    const none = list.filter(({ p }) => p.flags.length === 0).length;
    return [...[...m].sort((a, b) => b[1] - a[1]).map(([f, n]) => `| ${f} | ${n} |`), `| (no flag) | ${none} |`].join('\n');
  };

  const icoreCols = ['A*', 'A', 'B', 'C', 'not in ICORE'];
  const quartileCols = ['Q1', 'Q2', 'Q3', 'Q4', 'not in SCImago'];
  const md = `# Formula 1.0 results

Snapshot \`${snapshot.dir}\`; ${VENUES.length} venues (${confs.length} conferences, ${jours.length} journals). Conferences: GGS conference rating, points = sum of the class scores (A++=7 … C=1); journals: Polish 2019 method, class = band, points = the higher percentile. All ranks are within this sample.

## Conferences (by class, then points)

| Key | Name | ICORE | Class | Points | Classes: ICORE / OpenAlex / SCImago | Flags |
|---|---|---|---|---:|---|---|
${confRows.join('\n')}

## Journals (by band, then points)

| Key | Name | SCImago quartile | Class (band) | Points | Percentiles: SJR / 2-yr citedness | Flags |
|---|---|---|---|---:|---|---|
${jourRows.join('\n')}

## GGS class vs ICORE rank (conferences)

${crossTab(CLASS_ORDER, icoreCols, confs.map(({ p, icore }) => [p.class!, icoreCols.includes(icore) ? icore : icore]))}

## Polish band vs SCImago quartile (journals)

${crossTab(BAND_ORDER, quartileCols, jours.map(({ p, quartile }) => [p.class!, quartile]))}

## Flags

Conferences:

| Flag | Venues |
|---|---:|
${flagCounts(confs)}

Journals:

| Flag | Venues |
|---|---:|
${flagCounts(jours)}
`;
  fs.writeFileSync(path.join(F1_DIR, 'results.md'), md);
}
