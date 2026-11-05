import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeScoreVC } from '../scoring/read-vc.js';
import { checkInputs, ProviderFiles, type SourceStatus } from '../verification/check-inputs.js';

/**
 * One fresh-process run of the Inputs check (L3) for benchmark E1, part D. Started by e1.ts, not by hand:
 *   tsx src/bench/e1-l3-child.ts --sources-dir=<folder> --creds-dir=<folder>
 * It loads the three provider files, checks every credential in the folder and prints ONE line,
 * "E1JSON:" followed by a JSON object. A fresh process is used because the parse cost is paid once per
 * run; repeating it inside one process keeps the earlier parses in memory and inflates it.
 */

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const [srcDir, credsDir] = [arg('sources-dir'), arg('creds-dir')];
if (!srcDir || !credsDir) throw new Error('needs --sources-dir and --creds-dir');
const mib = (b: number) => b / 1024 / 1024;     // MiB (1024 * 1024 bytes)

const t0 = performance.now();                                   // the run starts here: the modules are already loaded
const files = new ProviderFiles(srcDir);
const sourcesIn = ['icore', 'scimago', 'retraction-watch'] as const;

// credentials (reading and decoding them is not part of the Inputs check)
const tDecode = performance.now();
const manifests = fs.readdirSync(credsDir).filter((f) => f.endsWith('.vc.jwt')).sort()
  .map((f) => decodeScoreVC(fs.readFileSync(path.join(credsDir, f), 'utf8')).manifest);
const decodeMs = performance.now() - tDecode;

// load the provider files: read, hash, parse (and the order-independent content hash, when a credential's file hash differs)
const loads: Record<string, { bytes: number; readMs: number; hashMs: number; parseMs: number; contentHashMs: number | null } | null> = {};
for (const s of sourcesIn) {
  const f = files.load(s);
  if (!f) { loads[s] = null; continue; }
  const needsContentHash = s !== 'retraction-watch' && manifests.some((m) => { const e = m.sources.find((x) => x.id === s); return e?.sha256 !== undefined && e.sha256 !== f.sha256; });
  if (needsContentHash) f.contentHash();
  loads[s] = { bytes: f.bytes, readMs: f.readMs, hashMs: f.hashMs, parseMs: f.parseMs, contentHashMs: needsContentHash ? f.contentHashMs ?? null : null };
}
const loadedMs = performance.now() - t0 - decodeMs;
const heapAfterLoadMB = mib(process.memoryUsage().heapUsed);

// check every credential; the files are loaded, so this is the per-credential cost
const perCredentialMs: number[] = [];
const extractMs: Record<string, number[]> = {};
const statuses: Record<string, Record<SourceStatus, number>> = {};
let failedCredentials = 0;
for (const m of manifests) {
  const t = performance.now();
  const r = checkInputs(m, files);
  perCredentialMs.push(performance.now() - t);
  if (r.sources.some((s) => s.status === 'fail')) failedCredentials++;
  for (const s of r.sources) {
    if (s.extractMs !== undefined) (extractMs[s.source] ??= []).push(s.extractMs);
    const st = (statuses[s.source] ??= { pass: 0, warn: 0, fail: 0, 'not-verifiable': 0 });
    st[s.status]++;
  }
}
const wallMs = performance.now() - t0;

console.log('E1JSON:' + JSON.stringify({
  credentials: manifests.length, decodeMs, loadedMs, wallMs, loads, perCredentialMs, extractMs, statuses, failedCredentials,
  memory: { heapAfterLoadMB, heapEndMB: mib(process.memoryUsage().heapUsed), rssEndMB: mib(process.memoryUsage().rss), maxRssMB: process.resourceUsage().maxRSS / 1024 },   // maxRSS is in KiB
}));
