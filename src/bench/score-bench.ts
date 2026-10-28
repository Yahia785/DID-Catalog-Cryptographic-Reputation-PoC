import { performance } from 'node:perf_hooks';
import type { AuditEntry, DidResolver } from '../identity/resolve-did.js';
import { verifyScoreJwt } from '../verification/verify-score.js';
import { summarize, type Summary } from './stats.js';

/**
 * Benchmark 3 (checking): how long it takes an outside party to check credentials, offline from the
 * cached audit logs and online against plc.directory, with and without a per-DID cache.
 *
 * Online, the politeness wait between plc.directory requests is measured separately and taken OUT of
 * every reported time (it would otherwise be mistaken for network latency).
 */

export interface CheckRow {
  key: string; ok: boolean;
  totalMs: number; signatureMs: number; recomputeMs: number; otherMs: number;   // otherMs = identities + venue checks
  requests: number; bytes: number; fetchMs: number; waitMs: number;
}
export interface CheckRun {
  label: string; resolver: string; credentials: number; failed: number;
  wallSeconds: number; politenessWaitSeconds: number; requests: number; bytes: number;
  summary: Record<'totalMs' | 'signatureMs' | 'recomputeMs' | 'otherMs' | 'requestsPerCheck' | 'bytesPerCheck', Summary | null>;
  rows: CheckRow[];
}

// ── counting fetch ───────────────────────────────────────────
const realFetch = globalThis.fetch;
const net = { requests: 0, bytes: 0, fetchMs: 0, waitMs: 0 };
let lastRequestAt = 0;

/** Count every fetch (requests, body bytes, time inside fetch) and space requests at least minGapMs apart. Returns restore(). */
export function countFetch(minGapMs: number): () => void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const wait = lastRequestAt + minGapMs - Date.now();
    if (minGapMs && wait > 0) { const t = performance.now(); await new Promise((r) => setTimeout(r, wait)); net.waitMs += performance.now() - t; }
    net.requests++;
    const t = performance.now();
    const res = await realFetch(input, init);
    net.bytes += (await res.clone().arrayBuffer()).byteLength;
    net.fetchMs += performance.now() - t;
    lastRequestAt = Date.now();
    return res;
  }) as typeof fetch;
  return () => { globalThis.fetch = realFetch; };
}

/** A resolver that remembers each DID's audit log after the first fetch. */
export function cachingResolver(inner: DidResolver): DidResolver & { hits: number; misses: number } {
  const memo = new Map<string, Promise<AuditEntry[]>>();
  const r = {
    via: `${inner.via} + per-DID cache`, hits: 0, misses: 0,
    auditLog(did: string) {
      const hit = memo.get(did);
      if (hit) { r.hits++; return hit; }
      r.misses++;
      const p = inner.auditLog(did);
      memo.set(did, p);
      p.catch(() => memo.delete(did));
      return p;
    },
  };
  return r;
}

/** Verify every credential in turn and time each check. */
export async function runChecks(label: string, items: { key: string; jwt: string }[], resolver: DidResolver): Promise<CheckRun> {
  const rows: CheckRow[] = [];
  const runStart = performance.now();
  const waitStart = net.waitMs, reqStart = net.requests, bytesStart = net.bytes;
  for (const { key, jwt } of items) {
    const before = { ...net };
    const timings: { signatureMs?: number; recomputeMs?: number } = {};
    // The verifier asks for the issuer's audit log first (signature check), then the venue's (venue check).
    // Record how long the politeness wait was inside the first request, so it can be taken out of the signature time.
    let waitInFirstCall: number | null = null;
    const tracked: DidResolver = {
      via: resolver.via,
      async auditLog(did) {
        const w0 = net.waitMs;
        try { return await resolver.auditLog(did); } finally { waitInFirstCall ??= net.waitMs - w0; }
      },
    };
    const t0 = performance.now();
    const report = await verifyScoreJwt(jwt, { resolver: tracked, timings });
    const wall = performance.now() - t0;
    const waitMs = net.waitMs - before.waitMs;
    const totalMs = wall - waitMs;
    const signatureMs = (timings.signatureMs ?? 0) - (waitInFirstCall ?? 0);
    const recomputeMs = timings.recomputeMs ?? 0;
    rows.push({
      key, ok: report.ok, totalMs, signatureMs, recomputeMs, otherMs: Math.max(0, totalMs - signatureMs - recomputeMs),
      requests: net.requests - before.requests, bytes: net.bytes - before.bytes, fetchMs: net.fetchMs - before.fetchMs, waitMs,
    });
  }
  const col = (f: (r: CheckRow) => number) => summarize(rows.map(f));
  return {
    label, resolver: resolver.via, credentials: rows.length, failed: rows.filter((r) => !r.ok).length,
    wallSeconds: (performance.now() - runStart) / 1000, politenessWaitSeconds: (net.waitMs - waitStart) / 1000,
    requests: net.requests - reqStart, bytes: net.bytes - bytesStart,
    summary: {
      totalMs: col((r) => r.totalMs), signatureMs: col((r) => r.signatureMs), recomputeMs: col((r) => r.recomputeMs), otherMs: col((r) => r.otherMs),
      requestsPerCheck: col((r) => r.requests), bytesPerCheck: col((r) => r.bytes),
    },
    rows,
  };
}

const f = (x: number | undefined, d: number) => (x === undefined ? '-' : x.toFixed(d));
/** Print a table of summaries: one row per metric. */
export function printSummaries(title: string, metrics: Record<string, Summary | null>, digits: Record<string, number> = {}) {
  console.log(`\n${title}`);
  console.log('  ' + 'metric'.padEnd(22) + ['n', 'mean', 'median', 'p95', 'min', 'max'].map((h) => h.padStart(11)).join(''));
  for (const [name, s] of Object.entries(metrics)) {
    if (!s) continue;
    const d = digits[name] ?? 3;
    console.log('  ' + name.padEnd(22) + [String(s.n), f(s.mean, d), f(s.median, d), f(s.p95, d), f(s.min, d), f(s.max, d)].map((x) => x.padStart(11)).join(''));
  }
}
