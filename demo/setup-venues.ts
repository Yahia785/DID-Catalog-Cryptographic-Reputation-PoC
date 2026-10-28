import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { summarize, type Summary } from '../src/bench/stats.js';
import { createIdentity, type CreateTimings } from '../src/identity/create-identity.js';
import { loadOrCreateControlKeys, CONTROL_KEYS_FILE } from '../src/identity/key-store.js';
import {
  PLATFORM_FILE, loadJson, saveJson, serializeIdentity, serializeKeyPair,
} from '../src/identity/identity-store.js';
import { VENUES, handleOf, groupOf } from '../src/venues/registry.js';
import { VENUES_FILE, type VenueRecord } from '../src/venues/venue-records.js';
import type { VenueType } from '../src/shared/types.js';

/**
 * Set up all identities for the scoring demo:
 *   1. Platform DID   — its own rotation key and its own signing key
 *   2. Control keys   — one for conferences, one for journals (platform-held)
 *   3. Venue DIDs     — one unique DID per venue, controlled by its group key
 *
 * Safe to run again: anything that already exists is reused, not recreated.
 * Use --dry-run to build everything locally without publishing to plc.directory.
 *
 * Use --bench to time every venue DID it creates (already published venues are skipped and not timed):
 *   key generation, building and signing the genesis operation, the POST (status and bytes), then -
 *   after the POST - polling GET plc.directory/<did> every 250 ms (max 30 s) until it answers 200
 *   (time to resolve, number of polls), then one GET of /<did>/log/audit (its bytes). It waits 500 ms
 *   between venues to be polite to plc.directory; that wait is never part of a timing and is reported
 *   separately. Saved to output/bench/did-setup-<ISO>.json (marked "resumed" when an earlier run had
 *   already published some of the sampled venues).
 */

const dryRun = process.argv.includes('--dry-run');
const bench = process.argv.includes('--bench');
const POLL_MS = 250, POLL_MAX_MS = 30_000, POLITENESS_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BenchRow extends Partial<CreateTimings> {
  key: string; did?: string; handle: string; type: VenueType;
  resolveMs?: number | null; polls?: number | null; auditLogBytes?: number | null;
  failure?: string;
}
const benchRows: BenchRow[] = [];
let politenessMs = 0;

/** After the POST: wait until the DID resolves, then fetch its audit log once. */
async function measureResolve(did: string, row: BenchRow) {
  const t0 = performance.now();
  let polls = 0;
  for (;;) {
    polls++;
    const res = await fetch(`https://plc.directory/${did}`, { headers: { Accept: 'application/json' } });
    await res.arrayBuffer();
    if (res.ok) break;
    if (performance.now() - t0 > POLL_MAX_MS) { Object.assign(row, { resolveMs: null, polls, failure: `did not resolve within ${POLL_MAX_MS / 1000} s (last status ${res.status})` }); return; }
    await sleep(POLL_MS);
  }
  Object.assign(row, { resolveMs: performance.now() - t0, polls });
  const audit = await fetch(`https://plc.directory/${did}/log/audit`, { headers: { Accept: 'application/json' } });
  row.auditLogBytes = audit.ok ? Buffer.byteLength(await audit.text()) : null;
  if (!audit.ok) row.failure = `audit log answered ${audit.status}`;
}

function writeBench(startedAt: string, wallMs: number, resumed: boolean, complete: boolean) {
  const pick = (f: (r: BenchRow) => number | null | undefined) => benchRows.map(f).filter((x): x is number => typeof x === 'number');
  const phases: Record<string, Summary | null> = {
    keyGenMs: summarize(pick((r) => r.keyGenMs)), buildMs: summarize(pick((r) => r.buildMs)), signMs: summarize(pick((r) => r.signMs)),
    publishMs: summarize(pick((r) => r.publishMs)), resolveMs: summarize(pick((r) => r.resolveMs)), polls: summarize(pick((r) => r.polls)),
    requestBytes: summarize(pick((r) => r.requestBytes)), responseBytes: summarize(pick((r) => r.responseBytes)), auditLogBytes: summarize(pick((r) => r.auditLogBytes)),
  };
  const failures = benchRows.filter((r) => r.failure || r.error).map((r) => ({ key: r.key, did: r.did, reason: r.failure ?? r.error }));
  const out = {
    startedAt, mode: dryRun ? 'dry run (nothing published)' : 'live', resumed, complete, venuesTimed: benchRows.length,
    wallSecondsWithPoliteness: wallMs / 1000, wallSecondsWithoutPoliteness: (wallMs - politenessMs) / 1000, politenessWaitSeconds: politenessMs / 1000,
    summary: phases, failures, rows: benchRows,
  };
  fs.mkdirSync('output/bench', { recursive: true });
  const file = `output/bench/did-setup-${startedAt.replace(/:/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify(out, null, 1));

  console.log(chalk.bold(`\nDID setup cost (${benchRows.length} venue DID(s)${dryRun ? ', dry run: no POST' : ''}${resumed ? ', RESUMED run' : ''})`));
  const f = (x: number | undefined, d: number) => (x === undefined ? '-' : x.toFixed(d));
  console.log('  ' + 'phase'.padEnd(16) + ['n', 'mean', 'median', 'p95', 'min', 'max'].map((h) => h.padStart(10)).join(''));
  for (const [name, s] of Object.entries(phases)) {
    if (!s) continue;
    const d = name.endsWith('Bytes') || name === 'polls' ? 0 : 1;
    console.log('  ' + name.padEnd(16) + [String(s.n), f(s.mean, d), f(s.median, d), f(s.p95, d), f(s.min, d), f(s.max, d)].map((x) => x.padStart(10)).join(''));
  }
  console.log(chalk.gray(`  wall time ${(wallMs / 1000).toFixed(1)} s with the ${(politenessMs / 1000).toFixed(1)} s of politeness waits, ${((wallMs - politenessMs) / 1000).toFixed(1)} s without; ${failures.length} failure(s)`));
  console.log(chalk.gray(`  saved to ${file}\n`));
  return file;
}

async function main() {
  console.log(chalk.bold('\n=== DIDcal: identity setup ===\n'));
  console.log(chalk.gray(`Mode: ${dryRun ? 'DRY RUN (nothing published)' : 'LIVE (publishing to plc.directory)'}\n`));

  // ── 1. Platform ─────────────────────────────────────────────
  type PlatformFile = ReturnType<typeof serializeIdentity> & { published?: boolean };
  let platform = loadJson<PlatformFile>(PLATFORM_FILE);
  // A platform DID made in a dry run was never published: replace it when running live
  if (platform && platform.published === false && !dryRun) platform = null;
  if (platform) {
    console.log(chalk.green('✓ Platform DID (existing):'), platform.did);
  } else {
    const created = await createIdentity('platform', 'didcal-platform', { dryRun });
    platform = { ...serializeIdentity(created), published: !dryRun };
    saveJson(PLATFORM_FILE, platform);
    console.log(chalk.green('✓ Platform DID (created):'), platform.did);
  }
  console.log(chalk.gray(`  rotation key: ${platform.rotationKeyPair.did.slice(0, 40)}…  (platform only)`));

  // ── 2. Group control keys ───────────────────────────────────
  const { keys, created } = await loadOrCreateControlKeys();
  console.log(chalk.green(`\n✓ Group control keys (${created ? 'created' : 'existing'})`), chalk.gray(`→ ${path.relative('.', CONTROL_KEYS_FILE)}`));
  console.log(chalk.gray(`  conferences: ${keys.conference.did.slice(0, 40)}…`));
  console.log(chalk.gray(`  journals:    ${keys.journal.did.slice(0, 40)}…`));

  // ── 3. Venue DIDs ───────────────────────────────────────────
  const records = loadJson<Record<string, VenueRecord>>(VENUES_FILE) ?? {};
  console.log(chalk.bold('\nVenue DIDs'));
  const benchStart = new Date();
  const t0Bench = performance.now();
  const resumed = !dryRun && VENUES.some((v) => v.role.startsWith('Sample') && records[v.key]?.published);
  for (const v of VENUES) {
    const existing = records[v.key];
    // Reuse a published DID; replace a dry-run DID when running live
    if (existing && (existing.published || dryRun)) {
      console.log(`  ${chalk.gray('existing')}  ${v.key.padEnd(9)} ${existing.did}  ${chalk.gray(existing.handle)}`);
      continue;
    }
    if (bench && benchRows.length > 0) { await sleep(POLITENESS_MS); politenessMs += POLITENESS_MS; }
    const row: BenchRow = { key: v.key, handle: handleOf(v), type: v.type };
    let identity;
    try {
      identity = await createIdentity('venue', v.slug, {
        dryRun,
        rotationPrivateKey: keys[v.type].privateKey,
        handle: handleOf(v),
        service: { type: 'DIDcalVenue', endpoint: `https://didcal.io/${v.type}s` },
        timings: bench ? (t) => Object.assign(row, t) : undefined,
      });
    } catch (e) {
      if (bench) {
        benchRows.push(row);
        writeBench(benchStart.toISOString(), performance.now() - t0Bench, resumed, false);
      }
      throw e;
    }
    row.did = identity.did;
    records[v.key] = {
      key: v.key,
      name: v.name,
      did: identity.did,
      type: v.type,
      handle: handleOf(v),
      controlKeyDid: keys[v.type].did,
      signingKeyPair: serializeKeyPair(identity.signingKeyPair),
      published: !dryRun,
      createdAt: new Date().toISOString(),
      plcDirectoryUrl: `https://plc.directory/${identity.did}`,
      plcOperation: identity.plcOperation,
    };
    saveJson(VENUES_FILE, records); // save after each one, so a failure midway loses nothing
    if (bench && !dryRun) await measureResolve(identity.did, row);
    if (bench) benchRows.push(row);
    console.log(`  ${chalk.green('created ')}  ${v.key.padEnd(9)} ${identity.did}  ${chalk.gray(handleOf(v))}${bench && !dryRun ? chalk.gray(`  post ${row.publishMs?.toFixed(0)} ms, resolved after ${row.resolveMs?.toFixed(0) ?? '?'} ms`) : ''}`);
  }
  if (bench) writeBench(benchStart.toISOString(), performance.now() - t0Bench, resumed, true);

  // ── Summary ─────────────────────────────────────────────────
  const count = (t: VenueType) => Object.values(records).filter((r) => r.type === t).length;
  console.log(chalk.bold('\nSummary'));
  console.log(`  ${count('conference')} conference DIDs, controlled by the conference key (*.${groupOf('conference')}.didcal.io)`);
  console.log(`  ${count('journal')} journal DIDs, controlled by the journal key (*.${groupOf('journal')}.didcal.io)`);
  console.log(`  Every venue has its own DID and its own signing key.`);
  console.log(chalk.gray(`  Saved to ${path.relative('.', VENUES_FILE)}\n`));
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
