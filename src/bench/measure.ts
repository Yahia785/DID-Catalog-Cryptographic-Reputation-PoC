import chalk from 'chalk';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AuditEntry, DidResolver } from '../identity/resolve-did.js';
import { onlineResolver } from '../identity/resolve-did.js';
import { issueScore } from '../scoring/issue-score.js';
import { vcPathFor } from '../scoring/read-vc.js';
import type { Identity, InputValue } from '../shared/types.js';
import { createTestPlatform, createTestVenue, genesisOf, makeScore, memoryResolver, num, str, T_SIGNED, YEARS } from '../testing/fixtures.js';
import { verifyScoreJwt } from '../verification/verify-score.js';
import { VENUES, type VenueEntry } from '../venues/registry.js';

/**
 * Measurements for the paper's "efficient trust" argument. We only measure here; scoring and
 * verification logic are untouched. What each number means:
 *
 *   issue time        how long the platform needs to produce one signed credential
 *                     (run the formula + sign the JWT), in milliseconds.
 *   verify time       how long an outside party needs to check one credential completely
 *                     (all four checks). Split into the signature check (find the key in the
 *                     audit log, check the ES256 signature) and the recompute check (rerun the
 *                     formula and compare every field). mean / p50 (median) / p95 (the slow tail).
 *   credential size   bytes of the signed JWT as it would be sent or stored, per credential
 *                     and in total. This is both the storage and the communication cost of a score.
 *   network requests  how many HTTP requests issuing or verifying needs. Offline the DID
 *                     histories sit in memory, so the expected number is 0.
 *   throughput        credentials fully verified per second, on one core, back to back.
 *   online mode       what verification costs when the DID audit logs must be fetched from
 *                     plc.directory: requests and bytes per verification, with no cache and
 *                     with each DID's log fetched once and reused.
 *
 * The comparison against blockchain-based approaches is not measured here; those numbers will
 * come from the literature and be added to the paper later.
 *
 *   npm run bench                 offline, no network (synthetic venues, throwaway identities)
 *   npm run bench -- --repeat=5   offline, whole sweep 5 times, median of each metric across runs
 *   npm run bench -- --online     real credentials from output/scores/ against plc.directory
 */

// ── helpers ───────────────────────────────────────────────

const ONLINE = process.argv.includes('--online');
const N_VALUES = [1, 10, 100, 1000];
const WARMUP = 20;
const ONLINE_CAP = 100;           // verifications in total over both online cases
const ONLINE_MIN_GAP_MS = 200;    // between plc.directory requests
const REPEAT = Math.max(1, Number(process.argv.find((a) => a.startsWith('--repeat='))?.split('=')[1] ?? 1) || 1);

interface Stats { mean: number; p50: number; p95: number }
function stats(xs: number[]): Stats {
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, p50: q(0.5), p95: q(0.95) };
}
const ms = (x: number) => x.toFixed(3);

/** Deterministic pseudo-random numbers (mulberry32), so every run builds the same venues. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Count every fetch (requests, response body bytes, time spent inside fetch) and optionally space
 * plc.directory requests out. The politeness wait is measured separately (waitMs, never counted as
 * network time) so it can be left out of every reported latency.
 */
const realFetch = globalThis.fetch;
const net = { requests: 0, bytes: 0, fetchMs: 0, waitMs: 0 };
let lastRequestAt = 0;
let minGapMs = 0;

/** Sleep until at least minGapMs have passed since the last request. Returns the time slept. */
async function politeWait(): Promise<number> {
  const wait = lastRequestAt + minGapMs - Date.now();
  if (!minGapMs || wait <= 0) return 0;
  const t = performance.now();
  await new Promise((r) => setTimeout(r, wait));
  return performance.now() - t;
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  net.waitMs += await politeWait(); // only bites when one verification needs two requests in a row
  net.requests++;
  const t = performance.now();
  const res = await realFetch(input, init);
  net.bytes += (await res.clone().arrayBuffer()).byteLength; // body size after decompression
  net.fetchMs += performance.now() - t;
  lastRequestAt = Date.now();
  return res;
}) as typeof fetch;

// ── offline: synthetic venues ─────────────────────────────

const CONFERENCES = VENUES.filter((v) => v.type === 'conference');
const JOURNALS = VENUES.filter((v) => v.type === 'journal');

/** Synthetic inputs for venue number i: realistic ranges, a fixed seed per venue. */
function syntheticInputs(venue: VenueEntry, i: number): InputValue[] {
  const rand = rng(1000 + i);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const series = (base: number) => YEARS.map(() => Math.round(base * between(0.7, 1.4)));
  if (venue.type === 'conference') {
    const base = between(30, 300);
    const papers = Math.round(base);
    return [
      str('icore.rank', ['A*', 'A', 'B', 'C'][Math.floor(rand() * 4)], 'icore'),
      ...series(base).map((n, k) => num(`s2.papers.${YEARS[k]}`, n, 's2')),
      num('s2.cohortPapers', papers, 's2'), num('s2.cohortCitations', Math.round(papers * between(2, 60)), 's2'),
      num('rw.retractions', Math.floor(between(0, 25)), 'retraction-watch'),
    ];
  }
  const base = between(200, 3000);
  return [
    str('scimago.quartile', ['Q1', 'Q2', 'Q3', 'Q4'][Math.floor(rand() * 4)], 'scimago'),
    num('openalex.twoYrMeanCitedness', between(0.2, 12), 'openalex'),
    num('openalex.worksCount', Math.round(base * 10), 'openalex'),
    ...series(base).map((n, k) => num(`openalex.works.${YEARS[k]}`, n, 'openalex')),
    num('rw.retractions', Math.floor(between(0, 400)), 'retraction-watch'),
  ];
}

interface SyntheticVenue { entry: VenueEntry; identity: Identity; inputs: InputValue[] }

/**
 * n venues, alternating conference / journal. Each gets its own throwaway DID; the registry entry
 * (and so the handle the Venue check expects) is borrowed from the 13 real venues in turn,
 * so all four checks run for real on every credential.
 */
async function makeVenues(n: number): Promise<SyntheticVenue[]> {
  const out: SyntheticVenue[] = [];
  for (let i = 0; i < n; i++) {
    const e = i % 2 === 0 ? CONFERENCES[(i >> 1) % CONFERENCES.length] : JOURNALS[(i >> 1) % JOURNALS.length];
    out.push({ entry: e, identity: await createTestVenue(e), inputs: syntheticInputs(e, i) });
  }
  return out;
}

const venueCache = new Map<number, { venues: SyntheticVenue[]; resolver: DidResolver }>();

async function offlineRun(platform: Identity, n: number) {
  if (!venueCache.has(n)) {
    const venues = await makeVenues(n);
    venueCache.set(n, { venues, resolver: memoryResolver(Object.fromEntries([platform, ...venues.map((v) => v.identity)].map((i) => [i.did, [genesisOf(i)]]))) });
  }
  const { venues, resolver } = venueCache.get(n)!;
  const issue = (v: SyntheticVenue) => {
    const s = makeScore(v.entry, v.identity.did, platform.did, v.inputs, T_SIGNED);
    return issueScore(platform, s);
  };

  // Warm-up: untimed, so JIT compilation and key setup don't land in the first measurements
  for (let i = 0; i < WARMUP; i++) {
    const vc = await issue(venues[i % n]);
    await verifyScoreJwt(vc.jwt, { resolver });
  }

  const issueMs: number[] = [], jwts: string[] = [];
  const net0 = { ...net };
  for (const v of venues) {
    const t = performance.now();
    const vc = await issue(v);
    issueMs.push(performance.now() - t);
    jwts.push(vc.jwt);
  }
  const issueReq = net.requests - net0.requests;

  const verifyMs: number[] = [], sigMs: number[] = [], recMs: number[] = [];
  const net1 = { ...net };
  let failures = 0;
  const wall0 = performance.now();
  for (const jwt of jwts) {
    const timings: { signatureMs?: number; recomputeMs?: number } = {};
    const t = performance.now();
    const r = await verifyScoreJwt(jwt, { resolver, timings });
    verifyMs.push(performance.now() - t);
    sigMs.push(timings.signatureMs ?? 0);
    recMs.push(timings.recomputeMs ?? 0);
    if (!r.ok) failures++;
  }
  const wallS = (performance.now() - wall0) / 1000;
  const verifyReq = net.requests - net1.requests;
  if (failures) throw new Error(`${failures} of ${n} synthetic credentials failed verification: the benchmark setup is wrong`);

  const sizes = jwts.map((j) => Buffer.byteLength(j));
  return {
    n,
    issueMs: stats(issueMs),
    verifyMs: stats(verifyMs), signatureMs: stats(sigMs), recomputeMs: stats(recMs),
    jwtBytes: { mean: sizes.reduce((a, b) => a + b, 0) / n, min: Math.min(...sizes), max: Math.max(...sizes), total: sizes.reduce((a, b) => a + b, 0) },
    requestsPerIssuance: issueReq / n,
    requestsPerVerification: verifyReq / n,
    verifiedPerSecond: n / wallS,
  };
}

// ── online: real credentials ──────────────────────────────

/** Wraps a resolver so each DID's audit log is fetched once and reused. */
function cachingResolver(inner: DidResolver): DidResolver {
  const cache = new Map<string, Promise<AuditEntry[]>>();
  return { via: `${inner.via} (per-DID cache)`, auditLog: (did) => { if (!cache.has(did)) cache.set(did, inner.auditLog(did)); return cache.get(did)!; } };
}

async function onlineCase(label: string, jwts: string[], resolver: DidResolver) {
  const verifyMs: number[] = [], networkMs: number[] = [], otherMs: number[] = [];
  const reqPer: number[] = [], bytesPer: number[] = [];
  let failures = 0;
  for (const jwt of jwts) {
    await politeWait(); // the wait happens here, before the timer starts
    const before = { ...net };
    const t = performance.now();
    const r = await verifyScoreJwt(jwt, { resolver });
    // A verification that needs two requests waits between them inside the call; that sleep is measured
    // in the fetch wrapper and taken out, so the latency reported is work + network only.
    const elapsed = performance.now() - t - (net.waitMs - before.waitMs);
    const network = net.fetchMs - before.fetchMs;
    verifyMs.push(elapsed);
    networkMs.push(network);
    otherMs.push(elapsed - network);
    reqPer.push(net.requests - before.requests);
    bytesPer.push(net.bytes - before.bytes);
    if (!r.ok) failures++;
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    label, verifications: jwts.length, failures,
    verifyMs: stats(verifyMs), networkMs: stats(networkMs), otherMs: stats(otherMs),
    requestsTotal: sum(reqPer), requestsPerVerification: sum(reqPer) / jwts.length,
    bytesTotal: sum(bytesPer), bytesPerVerification: sum(bytesPer) / jwts.length,
  };
}

async function onlineRun() {
  const real = VENUES.filter((v) => fs.existsSync(vcPathFor(v.slug))).map((v) => fs.readFileSync(vcPathFor(v.slug), 'utf8'));
  if (!real.length) throw new Error('no credentials in output/scores/. Run: npm run score');
  const perCase = Math.floor(ONLINE_CAP / 2);
  // cycle through the real credentials; 3 full cycles of 13 per case stays well under the cap
  const take = Math.min(perCase, real.length * 3);
  const jwts = Array.from({ length: take }, (_, i) => real[i % real.length]);
  console.log(chalk.yellow(`\nWARNING: --online sends real requests to https://plc.directory (at most ${ONLINE_CAP} verifications, at least ${ONLINE_MIN_GAP_MS} ms between requests).`));
  console.log(chalk.yellow(`         ${take} verifications without cache + ${take} with a per-DID cache. This takes a while.\n`));
  minGapMs = ONLINE_MIN_GAP_MS;
  const noCache = await onlineCase('no cache', jwts, onlineResolver);
  const cached = await onlineCase('per-DID cache', jwts, cachingResolver(onlineResolver));
  return { credentials: real.length, cases: [noCache, cached] };
}

// ── output ────────────────────────────────────────────────

/** Median across runs of every numeric field, recursively (n is the same in every run). */
function medianOf<T>(runs: T[]): T {
  const first = runs[0] as unknown;
  if (typeof first === 'number') {
    const xs = (runs as unknown as number[]).slice().sort((a, b) => a - b);
    const m = xs.length >> 1;
    return (xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2) as unknown as T;
  }
  if (first && typeof first === 'object') {
    return Object.fromEntries(Object.keys(first).map((k) => [k, medianOf(runs.map((r) => (r as Record<string, unknown>)[k]))])) as T;
  }
  return first as T;
}

function printOffline(rows: Awaited<ReturnType<typeof offlineRun>>[]) {
  const line = (title: string, cells: string[]) => console.log(`  ${title.padEnd(34)}${cells.map((c) => c.padStart(12)).join('')}`);
  console.log(chalk.bold(`\nOffline benchmark (in-memory resolver, no network)${REPEAT > 1 ? `, median of ${REPEAT} runs` : ''}`));
  line('n (credentials)', rows.map((r) => String(r.n)));
  console.log(chalk.gray('  ' + '─'.repeat(34 + 12 * rows.length)));
  const triple = (name: string, pick: (r: (typeof rows)[number]) => Stats) => {
    line(`${name} mean (ms)`, rows.map((r) => ms(pick(r).mean)));
    line(`${name} p50 (ms)`, rows.map((r) => ms(pick(r).p50)));
    line(`${name} p95 (ms)`, rows.map((r) => ms(pick(r).p95)));
  };
  triple('issue (compute+sign)', (r) => r.issueMs);
  triple('verify (all checks)', (r) => r.verifyMs);
  triple('  of which signature', (r) => r.signatureMs);
  triple('  of which recompute', (r) => r.recomputeMs);
  line('verified per second', rows.map((r) => r.verifiedPerSecond.toFixed(0)));
  line('JWT bytes mean', rows.map((r) => r.jwtBytes.mean.toFixed(0)));
  line('JWT bytes min', rows.map((r) => String(r.jwtBytes.min)));
  line('JWT bytes max', rows.map((r) => String(r.jwtBytes.max)));
  line('JWT bytes total', rows.map((r) => String(r.jwtBytes.total)));
  line('requests per issuance', rows.map((r) => String(r.requestsPerIssuance)));
  line('requests per verification', rows.map((r) => String(r.requestsPerVerification)));
  console.log();
}

function printOnline(o: Awaited<ReturnType<typeof onlineRun>>) {
  console.log(chalk.bold(`\nOnline benchmark (${o.credentials} real credentials, plc.directory)`));
  const head = ['case', 'verifs', 'mean ms', 'p50 ms', 'p95 ms', 'net mean', 'non-net mean', 'req/verif', 'bytes/verif', 'failed'];
  console.log('  ' + head.map((h, i) => (i ? h.padStart(12) : h.padEnd(16))).join(''));
  for (const c of o.cases) {
    const cells = [String(c.verifications), ms(c.verifyMs.mean), ms(c.verifyMs.p50), ms(c.verifyMs.p95), ms(c.networkMs.mean), ms(c.otherMs.mean), c.requestsPerVerification.toFixed(2), c.bytesPerVerification.toFixed(0), String(c.failures)];
    console.log('  ' + c.label.padEnd(16) + cells.map((x) => x.padStart(12)).join(''));
  }
  console.log(chalk.gray('  latency excludes the 200 ms politeness wait; net = time inside fetch, non-net = the rest of verification; bytes = response bodies after decompression\n'));
}

function gitCommit() {
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}

async function main() {
  const mode = ONLINE ? 'online' : 'offline';
  const result: Record<string, unknown> = {};
  if (ONLINE) {
    const o = await onlineRun();
    printOnline(o);
    result.online = o;
  } else {
    const platform = await createTestPlatform();
    console.log(chalk.gray(`warm-up ${WARMUP} iterations per n; building up to ${Math.max(...N_VALUES)} throwaway venue identities, this takes a moment…`));
    const runs: Awaited<ReturnType<typeof offlineRun>>[][] = [];
    for (let k = 0; k < REPEAT; k++) {
      runs.push([]);
      for (const n of N_VALUES) runs[k].push(await offlineRun(platform, n));
      if (REPEAT > 1) console.log(chalk.gray(`  run ${k + 1} of ${REPEAT} done`));
    }
    const rows = N_VALUES.map((_, i) => medianOf(runs.map((r) => r[i])));
    printOffline(rows);
    result.offline = rows;
    if (REPEAT > 1) result.offlineRuns = runs;
  }
  const meta = {
    mode, repeat: ONLINE ? null : REPEAT, nValues: ONLINE ? null : N_VALUES, warmup: ONLINE ? null : WARMUP, timestamp: new Date().toISOString(),
    node: process.version, cpu: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length,
    os: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`, gitCommit: gitCommit(),
  };
  const file = path.resolve('output/bench', `${meta.timestamp.replace(/:/g, '-')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...meta, ...result }, null, 2));
  console.log(chalk.gray(`saved ${path.relative('.', file)}`));
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
