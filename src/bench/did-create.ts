import chalk from 'chalk';
import { performance } from 'node:perf_hooks';
import { createIdentity } from '../identity/create-identity.js';
import { loadOrCreateControlKeys } from '../identity/key-store.js';

/**
 * One-time cost of publishing a venue DID to the live plc.directory (opt-in: --did-create=N --yes).
 * Created the way demo-claim does it: a venue under the conference group control key.
 *
 *   a  build + sign the genesis operation locally (includes generating the two key pairs)
 *   b  the POST to plc.directory, until the response comes back
 *   c  from the POST returning until GET /<did>/log/audit answers 200 (polled every 250 ms, max 30 s)
 *   d  bytes sent in the POST, and bytes of the audit log that comes back
 */

export const MAX_DIDS = 5;
const MIN_GAP_MS = 500;
const POLL_MS = 250;
const POLL_MAX_MS = 30_000;

export interface DidCreateRow {
  did: string; handle: string;
  buildMs: number; postMs: number; resolveMs: number;
  postBytes: number; auditLogBytes: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const agg = (xs: number[]) => ({ mean: sum(xs) / xs.length, max: Math.max(...xs) });

/** Validate --did-create=N (1..5) and --yes before anything touches the network. Returns N, or null if the flag is absent. */
export function parseDidCreate(argv: string[]): number | null {
  const raw = argv.find((a) => a.startsWith('--did-create='));
  if (!raw) return null;
  const n = Number(raw.split('=')[1]);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DIDS) throw new Error(`--did-create must be a whole number from 1 to ${MAX_DIDS} (got "${raw.split('=')[1]}")`);
  return n;
}

export async function didCreateRun(n: number, confirmed: boolean) {
  console.log(chalk.yellow(`WARNING: --did-create publishes ${n} PERMANENT throwaway DID(s) to the live https://plc.directory.`));
  console.log(chalk.yellow('         They cannot be deleted. Handles look like claim-bench-<timestamp>-<i>.conf.didcal.io.'));
  if (!confirmed) throw new Error('Nothing was created. Add --yes to confirm: npx tsx src/bench/measure.ts --did-create=' + n + ' --yes');

  const { keys } = await loadOrCreateControlKeys();
  const stamp = Date.now();
  const rows: DidCreateRow[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) await sleep(MIN_GAP_MS);
    const handle = `claim-bench-${stamp}-${i}.conf.didcal.io`;

    // a. build + sign locally (dry run: createIdentity does everything except the POST)
    const t0 = performance.now();
    const venue = await createIdentity('venue', `claim-bench-${stamp}-${i}`, { dryRun: true, rotationPrivateKey: keys.conference.privateKey, handle });
    const buildMs = performance.now() - t0;

    // b. the POST, exactly as createIdentity would send it
    const body = JSON.stringify(venue.plcOperation);
    const t1 = performance.now();
    const post = await fetch(`https://plc.directory/${venue.did}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const postMs = performance.now() - t1;
    if (!post.ok) throw new Error(`plc.directory publish failed (${post.status}): ${await post.text()}`);

    // c. wait until the DID resolves
    const t2 = performance.now();
    let auditLogBytes = 0;
    for (;;) {
      const res = await fetch(`https://plc.directory/${venue.did}/log/audit`, { headers: { Accept: 'application/json' } });
      if (res.ok) { auditLogBytes = Buffer.byteLength(await res.text()); break; }
      if (performance.now() - t2 > POLL_MAX_MS) throw new Error(`${venue.did} did not resolve within ${POLL_MAX_MS / 1000} s (last status ${res.status})`);
      await sleep(POLL_MS);
    }
    const resolveMs = performance.now() - t2;

    rows.push({ did: venue.did, handle, buildMs, postMs, resolveMs, postBytes: Buffer.byteLength(body), auditLogBytes });
    console.log(chalk.gray(`  created ${venue.did}  ${handle}`));
  }

  return {
    n, rows,
    buildMs: agg(rows.map((r) => r.buildMs)), postMs: agg(rows.map((r) => r.postMs)), resolveMs: agg(rows.map((r) => r.resolveMs)),
    postBytes: agg(rows.map((r) => r.postBytes)), auditLogBytes: agg(rows.map((r) => r.auditLogBytes)),
  };
}

export function printDidCreate(r: Awaited<ReturnType<typeof didCreateRun>>) {
  console.log(chalk.bold(`DID creation cost (${r.n} throwaway venue DID(s), live plc.directory)`));
  console.log('  ' + 'metric'.padEnd(46) + 'mean'.padStart(12) + 'max'.padStart(12));
  const row = (name: string, a: { mean: number; max: number }, d = 1) => console.log('  ' + name.padEnd(46) + a.mean.toFixed(d).padStart(12) + a.max.toFixed(d).padStart(12));
  row('a. build + sign genesis, local (ms)', r.buildMs);
  row('b. POST to plc.directory returns (ms)', r.postMs);
  row('c. until the DID resolves (ms)', r.resolveMs);
  row('d. bytes sent in the POST', r.postBytes, 0);
  row('d. bytes of the audit log', r.auditLogBytes, 0);
  console.log();
}
