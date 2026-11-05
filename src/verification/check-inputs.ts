import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  extractIcore, extractRetractionWatch, extractScimago, parseIcore, parseRetractionWatch, parseScimago,
  type IcoreFile, type RetractionFile, type ScimagoFile,
} from '../scoring/extract-1.js';
import type { InputValue, ProvenanceManifest, SourceSnapshot } from '../shared/types.js';

/**
 * L3, the "Inputs" check: do the inputs in a credential match the PROVIDER'S OWN published file?
 *
 *   Only for sources published as fixed, dated files: ICORE (icore.csv), SCImago (scimago.csv) and
 *   Retraction Watch (retraction_watch.csv). OpenAlex is a live API with no fixed edition, so its inputs
 *   are always "not verifiable against the source" and rest on the signature and the recompute alone.
 *
 *   The files are ones the checker downloaded into a folder of their choice (--sources-dir). Our own
 *   copies in data/ are never used as evidence: a folder inside data/ is refused.
 *
 * Per source: pass (hash and values match) · warn (values match, file bytes differ) · fail (a value
 * differs, or the matching rule finds no row although the credential has a value) · not-verifiable
 * (OpenAlex, file missing, or a different edition; never a failure).
 * Retraction Watch changes daily, so its hash is not compared: the rows dated on or before the
 * credential's cutoff are counted again in the file given. The same count is a pass; fewer is a fail;
 * more is a warn when it is a plausible backfill (up to LATE_ADDITION_TOLERANCE of the credential's own
 * count, at least one record), and a fail beyond that: a credential that says 0 retractions where the
 * provider's file has 948 dated before the cutoff is not a late addition.
 */
export const LATE_ADDITION_TOLERANCE = 0.1;

export type SourceStatus = 'pass' | 'warn' | 'fail' | 'not-verifiable';
export interface SourceInputsResult {
  source: string; status: SourceStatus; reason: string;
  title?: string;          // the matched row's title (ICORE, SCImago), so a reader can see the row names the venue
  metrics: string[];       // the credential's inputs from this source
  extractMs?: number;      // time of the extraction for this venue
}
export interface InputsResult {
  status: 'pass' | 'warn' | 'fail' | 'skip';   // the worst of the file sources; 'skip' when none could be checked
  detail: string;
  sources: SourceInputsResult[];
  ms: number;
}

export const SOURCE_FILES = { icore: 'icore.csv', scimago: 'scimago.csv', 'retraction-watch': 'retraction_watch.csv' } as const;
type FileSource = keyof typeof SOURCE_FILES;

/** Refuse a sources folder that is our own data/ (or inside it): that would be checking the issuer against itself. */
export function assertNotOwnData(dir: string): string {
  const resolved = fs.existsSync(dir) ? fs.realpathSync(path.resolve(dir)) : path.resolve(dir);
  const data = path.resolve('data');
  const ownData = [data, fs.existsSync(data) ? fs.realpathSync(data) : data];
  for (const d of ownData) {
    const rel = path.relative(d, resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new Error(`--sources-dir ${dir} is inside data/, the issuer's own copies. The Inputs check must use files you downloaded yourself from the providers: put them in another folder (for example l3-sources/).`);
    }
  }
  return resolved;
}

// ── provider files, read and parsed once per run ─────────────
type Parsed = { icore: IcoreFile; scimago: ScimagoFile; 'retraction-watch': RetractionFile };
export interface LoadedFile<S extends FileSource = FileSource> {
  source: S; path: string; bytes: number; sha256: string; parsed: Parsed[S]; edition: string | null; cutoff: string | null;
  readMs: number; hashMs: number; parseMs: number;
}

export class ProviderFiles {
  readonly dir: string;
  private cache = new Map<FileSource, { sig: string; file: LoadedFile | null }>();
  constructor(dir: string) { this.dir = assertNotOwnData(dir); }

  /** The parsed provider file, or null when it is not in the folder. Re-read only if it changed on disk. */
  load<S extends FileSource>(source: S): LoadedFile<S> | null {
    const file = path.join(this.dir, SOURCE_FILES[source]);
    const sig = fs.existsSync(file) ? `${fs.statSync(file).mtimeMs}:${fs.statSync(file).size}` : 'missing';
    const hit = this.cache.get(source);
    if (hit && hit.sig === sig) return hit.file as LoadedFile<S> | null;
    let loaded: LoadedFile | null = null;
    if (sig !== 'missing') {
      const t0 = performance.now();
      const buf = fs.readFileSync(file);
      const t1 = performance.now();
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const t2 = performance.now();
      const text = buf.toString('utf8');
      const base = { path: file, bytes: buf.length, sha256, readMs: t1 - t0, hashMs: t2 - t1 };
      if (source === 'icore') { const parsed = parseIcore(text); loaded = { ...base, source, parsed, edition: parsed.edition, cutoff: null, parseMs: performance.now() - t2 } as LoadedFile; }
      else if (source === 'scimago') { const parsed = parseScimago(text); loaded = { ...base, source, parsed, edition: parsed.edition, cutoff: null, parseMs: performance.now() - t2 } as LoadedFile; }
      else { const parsed = parseRetractionWatch(text); loaded = { ...base, source, parsed, edition: null, cutoff: parsed.cutoff, parseMs: performance.now() - t2 } as LoadedFile; }
    }
    this.cache.set(source, { sig, file: loaded });
    return loaded as LoadedFile<S> | null;
  }

  /** Every file loaded so far, with its read / hash / parse time (for benchmarks). */
  get loads() { return [...this.cache.values()].flatMap((c) => (c.file ? [c.file] : [])); }
}

const byDir = new Map<string, ProviderFiles>();
/** One ProviderFiles per sources folder per process, so a run over many credentials parses each file once. */
export function providerFilesFor(dir: string): ProviderFiles {
  const key = assertNotOwnData(dir);
  let p = byDir.get(key);
  if (!p) { p = new ProviderFiles(dir); byDir.set(key, p); }
  return p;
}

// ── the check ────────────────────────────────────────────────
const RANK: Record<SourceStatus, number> = { 'not-verifiable': 0, pass: 1, warn: 2, fail: 3 };
const show = (v: unknown) => (v === null || v === undefined ? 'none' : String(v));
/** Input names for display: a yearly series (openalex.works.2016 … 2025) is listed once as openalex.works.<year> x10. */
const namesOf = (metrics: string[]) => {
  const out = new Map<string, number>();
  for (const m of metrics) { const k = m.replace(/\.\d{4}$/, '.<year>'); out.set(k, (out.get(k) ?? 0) + 1); }
  return [...out].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
};

function checkFileSource(s: SourceSnapshot, inputs: InputValue[], files: ProviderFiles): Omit<SourceInputsResult, 'source' | 'metrics'> {
  const id = s.id as FileSource;
  const nv = (reason: string) => ({ status: 'not-verifiable' as const, reason });
  if (!s.verifiable) return nv('the credential has no matching rule (issued before the Inputs check)');
  if (!s.match) return nv('the credential has no matching rule (the venue has no id in this source)');
  const f = files.load(id);
  if (!f) return nv(`edition not available (${SOURCE_FILES[id]} is not in the sources folder)`);
  if (id !== 'retraction-watch' && s.edition && f.edition !== s.edition) {
    return nv(`edition not available (the file is ${f.edition ?? 'of unknown edition'}, the credential names ${s.edition})`);
  }
  const claimed = (metric: string) => inputs.find((i) => i.metric === metric)?.value ?? null;
  const t0 = performance.now();
  let title: string | undefined;
  let found: Record<string, unknown> | null = null;
  const problems: string[] = [];
  let ruleText: string;

  if (id === 'icore') {
    const row = extractIcore(f.parsed as IcoreFile, { coreId: s.match.coreId });
    title = row?.title; ruleText = `coreId ${s.match.coreId}`;
    found = row ? { 'icore.rank': row.rank } : null;
  } else if (id === 'scimago') {
    const row = extractScimago(f.parsed as ScimagoFile, { sourceid: s.match.sourceid });
    title = row?.title; ruleText = `Sourceid ${s.match.sourceid}`;
    if (row && s.match.issn && row.issn !== s.match.issn) problems.push(`the row's ISSN is ${row.issn}, the credential's rule says ${s.match.issn}`);
    found = row ? { 'scimago.sjr': row.sjr, 'scimago.hIndex': row.hIndex } : null;
  } else {
    const file = f.parsed as RetractionFile;
    ruleText = `Journal matching /${s.match.rwMatch}/i${s.match.rwExclude ? ` without /${s.match.rwExclude}/i` : ''}, rows dated up to ${s.match.cutoff}`;
    if (file.cutoff !== null && s.match.cutoff && file.cutoff < s.match.cutoff) {
      return nv(`edition not available (the file ends ${file.cutoff}, before the credential's cutoff ${s.match.cutoff})`);
    }
    const r = extractRetractionWatch(file, { rwMatch: s.match.rwMatch, rwExclude: s.match.rwExclude, cutoff: s.match.cutoff });
    found = { 'rw.retractions': r.retractions };
  }
  const extractMs = performance.now() - t0;
  const result = (status: SourceStatus, reason: string) => ({ status, reason, title, extractMs });

  const mine = inputs.filter((i) => found === null ? true : i.metric in found);
  if (found === null) {
    const has = inputs.filter((i) => i.value !== null && i.value !== undefined);
    return has.length
      ? result('fail', `the matching rule (${ruleText}) finds no row, although the credential has ${has.map((i) => `${i.metric} = ${show(i.value)}`).join(', ')}`)
      : result('pass', `no row for ${ruleText}, as the credential says`);
  }

  const warns: string[] = [];
  for (const i of mine) {
    const got = found[i.metric];
    if (id === 'retraction-watch') {
      const [was, now] = [Number(i.value), Number(got)];
      const tolerance = Math.max(1, Math.ceil(LATE_ADDITION_TOLERANCE * was));
      if (now < was) problems.push(`${i.metric}: the credential says ${was}, the provider's file has only ${now} up to ${s.match.cutoff}`);
      else if (now - was > tolerance) problems.push(`${i.metric}: the credential says ${was}, the provider's file has ${now} dated up to ${s.match.cutoff}: ${now - was} more is too many to be late additions (tolerance ${tolerance})`);
      else if (now > was) warns.push(`${now - was} record(s) dated before the cutoff ${s.match.cutoff} were added later (${i.metric}: credential ${was}, file now ${now})`);
    } else if (i.value !== got) {
      problems.push(`${i.metric}: the credential says ${show(i.value)}, the provider's file says ${show(got)}`);
    }
  }
  if (problems.length) return result('fail', problems.join('; '));
  if (warns.length) return result('warn', warns.join('; '));
  const what = mine.map((i) => `${i.metric} = ${show(claimed(i.metric))}`).join(', ');
  if (id === 'retraction-watch') return result('pass', `${what} (rows up to ${s.match.cutoff}; the file itself changes daily, so its hash is not compared)`);
  if (s.sha256 && s.sha256 !== f.sha256) return result('warn', `${what} match, but the file bytes differ from the one the credential read (sha256 ${f.sha256.slice(0, 12)}…, credential ${s.sha256.slice(0, 12)}…)`);
  return result('pass', `${what} match${s.sha256 ? ', same file bytes' : ''}`);
}

/** Check a credential's inputs against the provider files in `files`. */
export function checkInputs(manifest: ProvenanceManifest, files: ProviderFiles): InputsResult {
  const t0 = performance.now();
  const sources: SourceInputsResult[] = [];
  for (const s of manifest.sources) {
    const metrics = manifest.inputs.filter((i) => i.sourceId === s.id).map((i) => i.metric);
    const inputs = manifest.inputs.filter((i) => i.sourceId === s.id);
    if (s.id === 'openalex' || s.verifiable === 'live') {
      sources.push({ source: s.id, status: 'not-verifiable', reason: `live API, no fixed edition (${namesOf(metrics)})`, metrics });
    } else if (s.id in SOURCE_FILES) {
      sources.push({ source: s.id, metrics, ...checkFileSource(s, inputs, files) });
    }
  }
  const judged = sources.filter((s) => s.status !== 'not-verifiable');
  const worst = judged.reduce<SourceStatus | null>((w, s) => (w === null || RANK[s.status] > RANK[w] ? s.status : w), null);
  const status: InputsResult['status'] = worst === null ? 'skip' : (worst as 'pass' | 'warn' | 'fail');
  const part = (s: SourceInputsResult) => `${s.source}: ${s.status === 'not-verifiable' ? 'not verifiable against the source' : s.status}${s.title ? ` [${s.title}]` : ''} (${s.reason})`;
  const detail = sources.length ? sources.map(part).join(' · ') : 'the credential lists no sources';
  return { status, detail: status === 'skip' ? `nothing could be checked against a provider file: ${detail}` : detail, sources, ms: performance.now() - t0 };
}
