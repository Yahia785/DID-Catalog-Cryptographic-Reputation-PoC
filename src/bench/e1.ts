import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadPlatform, saveJson } from '../identity/identity-store.js';
import { cachedResolver } from '../identity/plc-cache.js';
import { onlineResolver, type DidResolver } from '../identity/resolve-did.js';
import { buildCohort, buildInputs1, scoreFromInputs1 } from '../scoring/build-score-1.js';
import { hashFormulaCode } from '../scoring/formula-releases.js';
import { issueScore } from '../scoring/issue-score.js';
import { decodeScoreVC } from '../scoring/read-vc.js';
import { cohortBytesIn } from '../scoring/score-1.js';
import { loadSnapshot, SNAPSHOTS_ROOT } from '../scoring/snapshot-store.js';
import { softwareCommit } from '../scoring/software-commit.js';
import { verifyScoreJwt } from '../verification/verify-score.js';
import { VENUES } from '../venues/registry.js';
import { loadVenueRecords } from '../venues/venue-records.js';
import { cachingResolver, countFetch, netSnapshot } from './score-bench.js';
import { summarize, type Summary } from './stats.js';

/**
 * Benchmark E1: what issuing, checking and the Inputs check cost.
 *
 *   npx tsx src/bench/e1.ts [--reps=10] [--warmup=20] [--l3-runs=10] [--skip-online] [--sources-dir=l3-sources]
 *                           [--creds=output/scores/f1] [--snapshot=f1-2026-10-28b] [--estimate]
 *
 * --estimate measures the network (20 round trips), prints the expected run time for the given options and stops.
 *
 * Every measurement: single user, single process, one operation at a time, sequential. The workload is
 * the 100 credentials in --creds (read only); issuing goes to a temporary folder that is deleted at the
 * end. Politeness waits between plc.directory requests and retry backoff are never part of a timing; they
 * are reported separately. Results: output/bench/e1-<ISO>.json (raw timings) and e1-<ISO>.md (tables).
 *
 *   A issuing        build inputs, compute, sign, write, per venue; wall time and throughput per repetition
 *   B checking, offline (key histories from the saved cache)   each of the five checks, and the total
 *   C checking, online against plc.directory   cold / per-DID cache starting empty / cache already filled
 *   D the Inputs check (L3), in fresh processes (the parse cost is paid once per run)
 *   E credential sizes and the cohort share
 */

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const int = (n: string, d: number) => { const v = Number(arg(n) ?? d); if (!Number.isInteger(v) || v < 0) throw new Error(`--${n} must be a whole number`); return v; };
const REPS = int('reps', 10), WARMUP = int('warmup', 20), L3_RUNS = int('l3-runs', 10);
const SKIP_ONLINE = process.argv.includes('--skip-online');
const SOURCES_DIR = arg('sources-dir') ?? 'l3-sources';
const CREDS = path.resolve(arg('creds') ?? 'output/scores/f1');
const SNAPSHOT = arg('snapshot') ?? 'f1-2026-10-28b';
const GAP_MS = 200;                                   // minimum gap between plc.directory requests
const TMP = path.resolve('output/bench/tmp-e1');
const LABEL = 'Single user, single process, one operation at a time, sequential.';
if (REPS < 1) throw new Error('--reps must be at least 1');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(s);

// ── samples, kept per repetition ─────────────────────────────
type PerRep = number[][];
interface Described extends Summary { sdOfRepMedians: number | null; perRep: PerRep }
/** Pooled summary over all repetitions, plus the SD of the per-repetition medians (null with a single repetition). */
function describe(perRep: PerRep): Described {
  const flat = perRep.flat();
  const s = summarize(flat) ?? { n: 0, mean: NaN, median: NaN, p95: NaN, min: NaN, max: NaN, sd: 0 };
  const medians = perRep.filter((r) => r.length).map((r) => summarize(r)!.median);
  return { ...s, sdOfRepMedians: medians.length > 1 ? summarize(medians)!.sd : null, perRep };
}
class Collector {
  readonly m = new Map<string, PerRep>();
  add(name: string, rep: number, v: number) { const a = this.m.get(name) ?? []; (a[rep] ??= []).push(v); this.m.set(name, a); }
  all(names?: string[]) { return Object.fromEntries([...this.m].filter(([k]) => !names || names.includes(k)).map(([k, v]) => [k, describe(v)])); }
}

// ── workload ─────────────────────────────────────────────────
interface Item { key: string; jwt: string; type: 'conference' | 'journal' }
function loadWorkload(): Item[] {
  const items = VENUES.map((v) => {
    const f = path.join(CREDS, `${v.slug}.vc.jwt`);
    if (!fs.existsSync(f)) throw new Error(`${f} not found: the workload is the 100 credentials of --creds`);
    return { key: v.key, jwt: fs.readFileSync(f, 'utf8'), type: v.type };
  });
  return items;
}

// ── environment and network ──────────────────────────────────
function batteryState(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!out) return 'no battery found (mains)';
      return ({ 1: 'on battery (discharging)', 2: 'on mains (AC)', 3: 'fully charged, on mains', 6: 'charging (mains)', 7: 'charging (mains)', 8: 'charging (mains)', 9: 'charging (mains)' } as Record<string, string>)[out] ?? `battery status code ${out}`;
    }
    if (process.platform === 'linux') {
      const dir = '/sys/class/power_supply';
      const bat = fs.existsSync(dir) ? fs.readdirSync(dir).find((d) => d.startsWith('BAT')) : undefined;
      return bat ? fs.readFileSync(path.join(dir, bat, 'status'), 'utf8').trim() : 'no battery found (mains)';
    }
  } catch { /* fall through */ }
  return 'not recorded';
}

function environment() {
  const cpus = os.cpus();
  let git: { commit: string; dirty: boolean } | { error: string };
  try { git = softwareCommit(); } catch (e) { git = { error: e instanceof Error ? e.message : String(e) }; }
  return {
    cpu: cpus[0]?.model?.trim() ?? 'unknown', cores: cpus.length, ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    os: `${os.platform()} ${os.release()}`, osVersion: os.version(), arch: os.arch(), node: process.version, power: batteryState(), git,
  };
}

async function networkRtt(did: string) {
  const url = `https://plc.directory/${did}`;
  const samples: number[] = [];
  const errors: string[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    try { const r = await fetch(url, { headers: { Accept: 'application/did+ld+json' } }); await r.arrayBuffer(); if (r.ok) samples.push(performance.now() - t); else errors.push(`HTTP ${r.status}`); }
    catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    await sleep(200);                                   // spacing, not part of a round trip
  }
  return { url, requests: 20, samples, errors, summary: summarize(samples) };
}

// ── part A: issuing ──────────────────────────────────────────
async function partA() {
  log('\nA. Issuing');
  const platform = loadPlatform(), records = loadVenueRecords();
  const snapshot = loadSnapshot(path.join(SNAPSHOTS_ROOT, SNAPSHOT));
  const fingerprint = { codeHash: hashFormulaCode('1.0'), softwareCommit: (() => { try { return softwareCommit(); } catch { return { commit: 'unknown', dirty: true }; } })() };   // once per run, as in the real pipeline
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const issueAll = async (rep: number | null, c?: Collector, wall?: number[], cohortMs?: number[]) => {
    const tRep = performance.now();
    const tCohort = performance.now();
    const cohorts = { conference: buildCohort(snapshot, 'conference'), journal: buildCohort(snapshot, 'journal') };
    cohortMs?.push(performance.now() - tCohort);
    for (const venue of VENUES) {
      const record = records[venue.key];
      const t0 = performance.now();
      const inputs = buildInputs1(venue, snapshot);
      const t1 = performance.now();
      const score = scoreFromInputs1({ venue, venueDID: record.did, platformDID: platform.did, snapshot, inputs, cohort: cohorts[venue.type], computedAt: new Date().toISOString(), fingerprint });
      const t2 = performance.now();
      const vc = await issueScore(platform, score);
      const t3 = performance.now();
      const base = path.join(TMP, venue.slug);
      fs.writeFileSync(`${base}.vc.jwt`, vc.jwt);
      saveJson(`${base}.manifest.json`, vc.manifest);
      saveJson(`${base}.score.json`, vc.payload);
      const t4 = performance.now();
      if (rep !== null && c) {
        c.add('build inputs', rep, t1 - t0); c.add('compute', rep, t2 - t1); c.add('sign', rep, t3 - t2); c.add('write', rep, t4 - t3); c.add('total per credential', rep, t4 - t0);
      }
    }
    if (rep !== null) wall?.push(performance.now() - tRep);
  };
  try {
    for (let w = 0; w < Math.ceil(WARMUP / VENUES.length); w++) await issueAll(null);   // warm-up: not recorded (whole passes of 100)
    const c = new Collector(), wall: number[] = [], cohortMs: number[] = [];
    for (let rep = 0; rep < REPS; rep++) {
      await issueAll(rep, c, wall, cohortMs);
      log(`  repetition ${rep + 1}/${REPS}: ${(wall[rep] / 1000).toFixed(3)} s, ${(VENUES.length / (wall[rep] / 1000)).toFixed(1)} credentials/s`);
    }
    return {
      perVenueMs: c.all(), wallSecondsPerRep: wall.map((w) => w / 1000), throughputPerRep: wall.map((w) => VENUES.length / (w / 1000)),
      cohortBuildMs: cohortMs, warmupPasses: Math.ceil(WARMUP / VENUES.length),
    };
  } finally { fs.rmSync(TMP, { recursive: true, force: true }); }
}

// ── part B: checking offline ─────────────────────────────────
const CHECKS = ['Signature', 'Identities', 'Venue', 'Recompute', 'Formula'] as const;

async function partB(items: Item[]) {
  log('\nB. Checking offline (key histories from the saved cache)');
  for (let w = 0; w < WARMUP; w++) await verifyScoreJwt(items[w % items.length].jwt, { resolver: cachedResolver });   // not recorded
  const c = new Collector();
  let failed = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const t = performance.now();
    for (const it of items) {
      const timings: { signatureMs?: number; identitiesMs?: number; venueMs?: number; recomputeMs?: number; formulaMs?: number } = {};
      const t0 = performance.now();
      const r = await verifyScoreJwt(it.jwt, { resolver: cachedResolver, timings });
      const total = performance.now() - t0;
      if (!r.ok || r.checks.some((x) => x.status !== 'pass')) failed++;
      c.add('Signature', rep, timings.signatureMs ?? NaN); c.add('Identities', rep, timings.identitiesMs ?? NaN); c.add('Venue', rep, timings.venueMs ?? NaN);
      c.add('Recompute', rep, timings.recomputeMs ?? NaN); c.add('Formula', rep, timings.formulaMs ?? NaN); c.add('total per credential', rep, total);
    }
    log(`  repetition ${rep + 1}/${REPS}: ${((performance.now() - t) / 1000).toFixed(3)} s for ${items.length} credentials`);
  }
  return { perCheckMs: c.all(), checksNotAllPass: failed, warmupChecks: WARMUP };
}

// ── part C: checking online ──────────────────────────────────
interface OnlineRow { totalMs: number; perCheckMs: Record<string, number>; requests: number; bytes: number; requestsPerCheck: Record<string, number>; bytesPerCheck: Record<string, number>; waitMs: number; ok: boolean; calls: number }

/** One credential checked through `resolver`, with the politeness wait taken out of every time. */
async function onlineCheck(it: Item, resolver: DidResolver): Promise<OnlineRow> {
  // The verifier asks for a DID's audit log in a fixed order: the issuer's (Signature), the venue's (Venue), the platform's (Formula).
  const calls: { wait: number; requests: number; bytes: number }[] = [];
  const tracked: DidResolver = {
    via: resolver.via,
    async auditLog(did) {
      const b = netSnapshot();
      try { return await resolver.auditLog(did); }
      finally { const a = netSnapshot(); calls.push({ wait: a.waitMs - b.waitMs, requests: a.requests - b.requests, bytes: a.bytes - b.bytes }); }
    },
  };
  const timings: { signatureMs?: number; identitiesMs?: number; venueMs?: number; recomputeMs?: number; formulaMs?: number } = {};
  const t0 = performance.now();
  const r = await verifyScoreJwt(it.jwt, { resolver: tracked, timings });
  const wall = performance.now() - t0;
  const w = (i: number) => calls[i]?.wait ?? 0;
  const waitMs = calls.reduce((a, x) => a + x.wait, 0);
  return {
    totalMs: wall - waitMs,
    perCheckMs: { Signature: (timings.signatureMs ?? NaN) - w(0), Identities: timings.identitiesMs ?? NaN, Venue: (timings.venueMs ?? NaN) - w(1), Recompute: timings.recomputeMs ?? NaN, Formula: (timings.formulaMs ?? NaN) - w(2) },
    requests: calls.reduce((a, x) => a + x.requests, 0), bytes: calls.reduce((a, x) => a + x.bytes, 0),
    requestsPerCheck: { Signature: calls[0]?.requests ?? 0, Venue: calls[1]?.requests ?? 0, Formula: calls[2]?.requests ?? 0 },
    bytesPerCheck: { Signature: calls[0]?.bytes ?? 0, Venue: calls[1]?.bytes ?? 0, Formula: calls[2]?.bytes ?? 0 },
    waitMs, ok: r.ok && r.checks.every((x) => x.status === 'pass'), calls: calls.length,
  };
}

async function partC(items: Item[]) {
  log('\nC. Checking online against plc.directory (three cache conditions)');
  const restore = countFetch(GAP_MS);
  const waitBefore = netSnapshot().waitMs, reqBefore = netSnapshot().requests;
  try {
    for (let i = 0; i < 2; i++) await verifyScoreJwt(items[i].jwt, { resolver: onlineResolver });       // connection warm-up (TLS), not recorded
    const conditions: Record<string, { label: string; make: (rep: number) => DidResolver; prepare?: () => Promise<void> }> = {};
    const shared = cachingResolver(onlineResolver);
    conditions.cold = { label: 'cold: no cache, every key history is fetched', make: () => onlineResolver };
    conditions.perDidCacheEmpty = { label: 'per-DID cache, empty at the start of each repetition', make: () => cachingResolver(onlineResolver) };
    conditions.cacheFilled = {
      label: 'cache already filled', make: () => shared,
      prepare: async () => { for (const it of items) await onlineCheck(it, shared); },                // one unrecorded pass fills it
    };
    const out: Record<string, unknown> = {};
    for (const [name, cond] of Object.entries(conditions)) {
      if (cond.prepare) { log(`  ${name}: filling the cache (not recorded)`); await cond.prepare(); }
      const c = new Collector();
      const waitStart = netSnapshot().waitMs;
      let notAllPass = 0, anomalies = 0, requests = 0, bytes = 0;
      for (let rep = 0; rep < REPS; rep++) {
        const resolver = cond.make(rep);
        const t = performance.now(), w0 = netSnapshot().waitMs;
        for (const it of items) {
          const row = await onlineCheck(it, resolver);
          if (!row.ok) notAllPass++;
          if (row.calls !== 3) anomalies++;
          requests += row.requests; bytes += row.bytes;
          for (const k of CHECKS) c.add(k, rep, row.perCheckMs[k]);
          c.add('total per credential', rep, row.totalMs);
          c.add('requests per credential', rep, row.requests); c.add('bytes per credential', rep, row.bytes);
          for (const k of ['Signature', 'Venue', 'Formula']) { c.add(`requests: ${k}`, rep, row.requestsPerCheck[k]); c.add(`bytes: ${k}`, rep, row.bytesPerCheck[k]); }
        }
        log(`  ${name} repetition ${rep + 1}/${REPS}: ${((performance.now() - t - (netSnapshot().waitMs - w0)) / 1000).toFixed(2)} s without waits, ${((netSnapshot().waitMs - w0) / 1000).toFixed(1)} s of politeness waits`);
      }
      out[name] = { label: cond.label, metrics: c.all(), notAllPass, anomaliesNotThreeLogCalls: anomalies, requests, bytes, politenessWaitSeconds: (netSnapshot().waitMs - waitStart) / 1000 };
    }
    return { conditions: out, politenessGapMs: GAP_MS, politenessWaitSecondsTotal: (netSnapshot().waitMs - waitBefore) / 1000, requestsTotal: netSnapshot().requests - reqBefore };
  } finally { restore(); }
}

// ── part D: the Inputs check, fresh processes ────────────────
async function partD() {
  log('\nD. Inputs check (L3), one fresh process per run');
  const tsx = path.resolve('node_modules/tsx/dist/cli.mjs');
  const child = path.resolve('src/bench/e1-l3-child.ts');
  const runs: any[] = [];
  for (let i = 0; i < L3_RUNS; i++) {
    const t = performance.now();
    const res = spawnSync(process.execPath, [tsx, child, `--sources-dir=${SOURCES_DIR}`, `--creds-dir=${CREDS}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const processMs = performance.now() - t;
    const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('E1JSON:'));
    if (res.status !== 0 || !line) throw new Error(`Inputs run ${i + 1} failed (exit ${res.status}): ${(res.stderr ?? '').slice(0, 400)}`);
    const r = JSON.parse(line.slice('E1JSON:'.length));
    runs.push({ ...r, processMs });
    log(`  run ${i + 1}/${L3_RUNS}: ${(r.wallMs / 1000).toFixed(2)} s (load + check), process ${(processMs / 1000).toFixed(2)} s, ${r.failedCredentials} credential(s) with a failing source`);
  }
  return { runs };
}

function describeD(runs: any[]) {
  const one = (f: (r: any) => number | null | undefined) => describe(runs.map((r) => { const v = f(r); return v == null ? [] : [v]; }));
  const perSourceLoad: Record<string, Record<string, Described>> = {};
  const sources = ['icore', 'scimago', 'retraction-watch'];
  for (const s of sources) {
    perSourceLoad[s] = {
      'file size (MiB)': one((r) => (r.loads[s] ? r.loads[s].bytes / 1024 / 1024 : null)),
      'read (ms)': one((r) => r.loads[s]?.readMs), 'SHA-256 (ms)': one((r) => r.loads[s]?.hashMs), 'parse (ms)': one((r) => r.loads[s]?.parseMs),
      'content hash (ms), when needed': one((r) => r.loads[s]?.contentHashMs),
    };
  }
  const extraction: Record<string, Described> = {};
  for (const s of new Set(runs.flatMap((r) => Object.keys(r.extractMs)))) extraction[s] = describe(runs.map((r) => r.extractMs[s] ?? []));
  const statuses: Record<string, Record<string, number>> = {};
  for (const r of runs) for (const [s, st] of Object.entries<any>(r.statuses)) for (const [k, n] of Object.entries<number>(st)) { statuses[s] ??= {}; statuses[s][k] = (statuses[s][k] ?? 0) + n; }
  return {
    perSourceLoad, extraction,
    perCredentialMs: describe(runs.map((r) => r.perCredentialMs)),
    wallSeconds: one((r) => r.wallMs / 1000), processSeconds: one((r) => r.processMs / 1000),
    memoryMB: { 'heap used after loading': one((r) => r.memory.heapAfterLoadMB), 'heap used at the end': one((r) => r.memory.heapEndMB), 'resident set at the end': one((r) => r.memory.rssEndMB), 'peak resident set': one((r) => r.memory.maxRssMB) },
    statusesSummedOverRuns: statuses,
    runsWithNoFailingSource: runs.filter((r) => r.failedCredentials === 0).length, runs: runs.length,
    credentialsPerRun: runs[0]?.credentials ?? 0,
  };
}

// ── part E: sizes ────────────────────────────────────────────
function partE(items: Item[]) {
  const rows = items.map((it) => ({ type: it.type, jwtBytes: Buffer.byteLength(it.jwt.trim()), cohortBytes: cohortBytesIn(it.jwt.trim()) }));
  const of = (f: (r: (typeof rows)[number]) => number, type?: string) => summarize(rows.filter((r) => !type || r.type === type).map(f));
  const group = (type?: string) => ({ credentials: rows.filter((r) => !type || r.type === type).length, jwtBytes: of((r) => r.jwtBytes, type), cohortBytes: of((r) => r.cohortBytes, type), cohortShare: of((r) => r.cohortBytes / r.jwtBytes, type) });
  return { all: group(), conference: group('conference'), journal: group('journal') };
}

// ── markdown ─────────────────────────────────────────────────
const fmt = (x: number | null | undefined, d?: number) => {
  if (x === null || x === undefined || Number.isNaN(x)) return 'n/a';
  if (d !== undefined) return x.toFixed(d);
  const a = Math.abs(x);
  return a >= 1000 ? x.toFixed(0) : a >= 100 ? x.toFixed(1) : a >= 10 ? x.toFixed(2) : a >= 1 ? x.toFixed(3) : x.toFixed(4);
};
function table(rows: [string, Described | Summary | null | undefined][], d?: number): string {
  const head = '| Metric | n | mean | median | p95 | min | max | SD | SD of rep. medians |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const body = rows.filter(([, s]) => s && s.n > 0).map(([name, s]) => {
    const x = s as Described;
    return `| ${name} | ${x.n} | ${fmt(x.mean, d)} | ${fmt(x.median, d)} | ${fmt(x.p95, d)} | ${fmt(x.min, d)} | ${fmt(x.max, d)} | ${x.n > 1 ? fmt(x.sd, d) : 'n/a'} | ${x.sdOfRepMedians === undefined ? '' : fmt(x.sdOfRepMedians, d)} |`;
  });
  return [head, ...body].join('\n');
}
const entries = (o: Record<string, Described>) => Object.entries(o) as [string, Described][];

function markdown(r: any): string {
  const e = r.environment, n = r.network;
  const L: string[] = [];
  L.push(`# Benchmark E1: issuing, checking and the Inputs check`, '', `Run started ${r.startedAt}. **${LABEL}** Parameters: ${r.params.reps} repetitions, ${r.params.warmup} warm-up operations, ${r.params.l3Runs} fresh-process Inputs runs, online part ${r.params.skipOnline ? 'skipped' : 'included'}. Workload: the 100 credentials in \`${r.params.creds}\` (read only). All times in milliseconds unless stated. p95 is the nearest-rank percentile; SD is the sample standard deviation (n-1); "SD of rep. medians" is the SD of the per-repetition medians.`, '');
  L.push('## Environment', '', '| | |', '|---|---|', `| CPU | ${e.cpu}, ${e.cores} logical cores |`, `| RAM | ${e.ramGB} GB |`, `| OS | ${e.os} (${e.osVersion}), ${e.arch} |`, `| Node | ${e.node} |`, `| Power | ${e.power} |`, `| Git | ${'commit' in e.git ? `${e.git.commit.slice(0, 10)}${e.git.dirty ? ' (scoring code has uncommitted changes)' : ''}` : e.git.error} |`, '');
  L.push('## Network', '', `20 HTTPS round trips to plc.directory (GET of the platform DID document, 200 ms apart): median ${fmt(n.summary?.median)} ms, p95 ${fmt(n.summary?.p95)} ms, min ${fmt(n.summary?.min)} ms, max ${fmt(n.summary?.max)} ms${n.errors.length ? `; ${n.errors.length} failed` : ''}.`, '');

  const A = r.partA;
  L.push('## A. Issuing', '', `Per credential, ${r.params.reps} repetitions over ${VENUES.length} venues, written to a temporary folder. Throughput = credentials issued and written to disk per second, one process, sequential.`, '', table(entries(A.perVenueMs)), '');
  L.push('| Per repetition | n | mean | median | p95 | min | max | SD |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [name, xs, d] of [['wall time (s)', A.wallSecondsPerRep, 3], ['throughput (credentials/s)', A.throughputPerRep, 1], ['cohort build (ms)', A.cohortBuildMs, 3]] as [string, number[], number][]) {
    const s = summarize(xs)!; L.push(`| ${name} | ${s.n} | ${fmt(s.mean, d)} | ${fmt(s.median, d)} | ${fmt(s.p95, d)} | ${fmt(s.min, d)} | ${fmt(s.max, d)} | ${s.n > 1 ? fmt(s.sd, d) : 'n/a'} |`);
  }
  L.push('');

  const B = r.partB;
  L.push('## B. Checking offline', '', `Key histories from the saved cache, no network. Time of each check and of the whole verification of one credential (the total also includes decoding the credential).${B.checksNotAllPass ? ` **${B.checksNotAllPass} verification(s) had a check that did not pass.**` : ''}`, '', table(entries(B.perCheckMs)), '');

  if (r.partC) {
    const C = r.partC;
    L.push('## C. Checking online (plc.directory)', '', `Politeness gap between requests ${C.politenessGapMs} ms; the waits (${fmt(C.politenessWaitSecondsTotal, 1)} s in total) and retry backoff are not in any time below. Requests and bytes are per credential checked; the per-check split is in the JSON.`, '');
    for (const [name, cond] of Object.entries<any>(C.conditions)) {
      const m = cond.metrics;
      L.push(`### ${cond.label}`, '', table([...CHECKS.map((k) => [k, m[k]] as [string, Described]), ['total per credential', m['total per credential']]]), '');
      L.push(table([['requests per credential', m['requests per credential']], ['bytes per credential', m['bytes per credential']]], 1), '', `${cond.requests} requests and ${cond.bytes} bytes in total over all repetitions; ${fmt(cond.politenessWaitSeconds, 1)} s of politeness waits.${cond.notAllPass ? ` **${cond.notAllPass} verification(s) did not pass all checks.**` : ''}${cond.anomaliesNotThreeLogCalls ? ` ${cond.anomaliesNotThreeLogCalls} verification(s) did not ask for exactly three key histories.` : ''}`, '');
    }
  }

  const D = r.partD;
  L.push('## D. Inputs check (L3), fresh processes', '', `${D.runs} separate processes, each loads the three provider files from \`${r.params.sourcesDir}\` and checks all ${D.credentialsPerRun} credentials. ${D.runsWithNoFailingSource} of ${D.runs} runs had no failing source for any credential (sanity check; warnings and "not verifiable" are allowed). Statistics are over runs for the file loading, wall time and memory, and over all credentials of all runs for the per-venue rows.`, '');
  for (const [s, p] of Object.entries<any>(D.perSourceLoad)) {
    if (!p['read (ms)'].n) { L.push(`**${s}**: file not found in the sources folder.`, ''); continue; }
    L.push(`### File loading: ${s}`, '', table(entries(p).filter(([k]) => k !== 'file size (MiB)'), 2), '', `File size ${fmt(p['file size (MiB)'].mean, 1)} MiB.`, '');
  }
  L.push('### Per-venue extraction', '', table(entries(D.extraction).map(([k, v]) => [`${k} (ms)`, v] as [string, Described]), 4), '');
  L.push('### Per credential and whole run', '', table([['Inputs check per credential, files already loaded (ms)', D.perCredentialMs], ['whole run: load + decode + check (s)', D.wallSeconds], ['whole process incl. start-up (s)', D.processSeconds]], 3), '');
  L.push('### Memory (MiB)', '', table(entries(D.memoryMB), 0), '');
  L.push('### Results of the checks', '', '| Source | pass | warn | fail | not verifiable |', '|---|---:|---:|---:|---:|');
  for (const [s, st] of Object.entries<any>(D.statusesSummedOverRuns)) L.push(`| ${s} | ${st.pass ?? 0} | ${st.warn ?? 0} | ${st.fail ?? 0} | ${st['not-verifiable'] ?? 0} |`);
  L.push('', `(counts summed over the ${D.runs} runs)`, '');

  const E = r.partE;
  L.push('## E. Credential size', '', 'Bytes of the signed JWT as stored and sent, and the share of it that is the cohort. Deterministic, one pass.', '', '| | credentials | JWT bytes: mean | median | min | max | cohort bytes (mean) | cohort share of the JWT (mean) |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [name, g] of Object.entries<any>(E)) L.push(`| ${name} | ${g.credentials} | ${fmt(g.jwtBytes.mean, 0)} | ${fmt(g.jwtBytes.median, 0)} | ${fmt(g.jwtBytes.min, 0)} | ${fmt(g.jwtBytes.max, 0)} | ${fmt(g.cohortBytes.mean, 0)} | ${(g.cohortShare.mean * 100).toFixed(1)}% |`);
  L.push('', `Total run time ${(r.wallSeconds / 60).toFixed(1)} min.`, '');
  return L.join('\n');
}

// ── expected run time ────────────────────────────────────────
/**
 * Planning numbers, calibrated on a tiny run on this laptop: a pass of 100 credentials takes about 0.4 s to
 * issue and 0.8 s to check offline; a cold online pass makes 300 requests, a per-DID-cache pass 101; one
 * Inputs process takes about 9 s (start-up, loading the three files, checking 100 credentials).
 */
function estimate(rttMs: number, p: { reps: number; warmup: number; l3Runs: number; online: boolean }) {
  const req = 0.2 + rttMs / 1000;                           // seconds per online request, gap included
  const warmPasses = Math.ceil(p.warmup / 100);
  const A = (warmPasses + p.reps) * 0.4 + 1;
  const B = p.warmup * 0.008 + p.reps * 0.8;
  const C = p.online ? p.reps * (100 * 3 * req) + p.reps * (101 * req) + 101 * req + p.reps * 0.4 + 5 : 0;
  const D = p.l3Runs * 9;
  return { A, B, C, D, total: A + B + C + D + 10 };         // 10 s for the environment, network and report
}

async function main() {
  const wall0 = performance.now();
  const startedAt = new Date().toISOString();
  const items = loadWorkload();
  const platformDid = loadPlatform().did;
  log(`E1 benchmark. ${LABEL}`);
  log(`workload: ${items.length} credentials in ${path.relative('.', CREDS)}; --reps=${REPS} --warmup=${WARMUP} --l3-runs=${L3_RUNS}${SKIP_ONLINE ? ' --skip-online' : ''} --sources-dir=${SOURCES_DIR}`);

  const env = environment();
  log(`environment: ${env.cpu}, ${env.cores} cores, ${env.ramGB} GB, ${env.os}, node ${env.node}, power: ${env.power}`);
  log('network: 20 round trips to plc.directory ...');
  const network = await networkRtt(platformDid);
  log(`  median ${fmt(network.summary?.median)} ms, p95 ${fmt(network.summary?.p95)} ms, min ${fmt(network.summary?.min)} ms, max ${fmt(network.summary?.max)} ms`);
  const est = estimate(network.summary?.median ?? 50, { reps: REPS, warmup: WARMUP, l3Runs: L3_RUNS, online: !SKIP_ONLINE });
  log(`expected run time: about ${(est.total / 60).toFixed(1)} min (A ${(est.A).toFixed(0)} s, B ${est.B.toFixed(0)} s, C ${est.C.toFixed(0)} s, D ${est.D.toFixed(0)} s)`);
  if (process.argv.includes('--estimate')) return;

  const partA_ = await partA();
  const partB_ = await partB(items);
  const partC_ = SKIP_ONLINE ? null : await partC(items);
  const partD_ = describeD((await partD()).runs);
  const partE_ = partE(items);

  const result = {
    startedAt, label: LABEL, params: { reps: REPS, warmup: WARMUP, l3Runs: L3_RUNS, skipOnline: SKIP_ONLINE, sourcesDir: SOURCES_DIR, creds: path.relative('.', CREDS), snapshot: SNAPSHOT },
    environment: env, network, expectedSeconds: est, partA: partA_, partB: partB_, partC: partC_, partD: partD_, partE: partE_,
    wallSeconds: (performance.now() - wall0) / 1000,
  };
  fs.mkdirSync('output/bench', { recursive: true });
  const stamp = startedAt.replace(/:/g, '-');
  fs.writeFileSync(`output/bench/e1-${stamp}.json`, JSON.stringify(result, null, 1));
  fs.writeFileSync(`output/bench/e1-${stamp}.md`, markdown(result));
  log(`\ndone in ${(result.wallSeconds / 60).toFixed(1)} min (expected ${(est.total / 60).toFixed(1)}). Saved output/bench/e1-${stamp}.json and .md`);
}

main().catch((e) => { fs.rmSync(TMP, { recursive: true, force: true }); console.error(e instanceof Error ? e.message : e); process.exit(1); });
