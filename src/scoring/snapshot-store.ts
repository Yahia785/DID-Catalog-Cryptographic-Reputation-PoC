import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from '../shared/hash.js';

/**
 * A snapshot is a folder of JSON files, one per data source, frozen at one
 * point in time: data/snapshots/<YYYY-MM-DD>/.
 *
 * Scoring and verification read ONLY these files, never live APIs, so anyone
 * with the same files gets the same score. Each file's SHA-256 goes into the
 * provenance manifest; a verifier re-hashes the file to prove nothing changed.
 */

export const SNAPSHOTS_ROOT = path.resolve('data/snapshots');

export type SourceId = 'icore' | 'scimago' | 'retraction-watch' | 'openalex' | 'crossref' | 's2';
export const ALL_SOURCES: SourceId[] = ['icore', 'scimago', 'retraction-watch', 'openalex', 'crossref', 's2'];

export interface SourceInfo {
  id: SourceId;
  name: string;
  access: 'api' | 'csv';
  url: string;
  edition?: string;
  retrievedAt: string;
  inputFile?: string;     // for CSV sources: the downloaded file that was read
  inputSha256?: string;   // hash of that downloaded file
}

// Per-venue data from each source. null = the venue is not in that source.
export interface IcoreData { coreId: string; title: string; acronym: string; edition: string; rank: string }
export interface ScimagoData { title: string; sjr: number | null; quartile: string; hIndex: number | null; totalDocs3y: number | null; citesPerDoc2y: number | null }
export interface RetractionData { records: number; retractions: number; byYear: Record<string, number>; topReasons: Record<string, number> }
export interface OpenAlexData { worksCount: number; citedByCount: number; twoYrMeanCitedness: number | null; hIndex: number | null; worksByYear: Record<string, number> }
export interface CrossrefData { totalDois: number | null; doisByYear: Record<string, number>; retractionNotices: number | null }
export interface S2Data { venueName: string; papersByYear: Record<string, number>; cohortYear: number; cohortPapers: number; cohortCitations: number }

export interface SourceDataMap {
  icore: IcoreData; scimago: ScimagoData; 'retraction-watch': RetractionData;
  openalex: OpenAlexData; crossref: CrossrefData; s2: S2Data;
}

export interface SnapshotFile<T> {
  source: SourceInfo;
  years: number[];                         // the full years covered, e.g. 2016–2025
  venues: Record<string, T | null>;        // keyed by registry key, e.g. 'SCN'
}

export interface SnapshotIndexEntry { id: SourceId; file: string; sha256: string }
export interface SnapshotIndex { createdAt: string; dir: string; files: SnapshotIndexEntry[] }

export interface Snapshot {
  dir: string;                              // relative path, e.g. data/snapshots/2026-09-25
  index: SnapshotIndex;
  sources: Partial<{ [K in SourceId]: SnapshotFile<SourceDataMap[K]> }>;
}

export const fileFor = (dir: string, id: SourceId) => path.join(dir, `${id}.json`);
export const rel = (p: string) => path.relative(process.cwd(), p).split(path.sep).join('/');

/** The most recent snapshot folder, by name. */
export function latestSnapshotDir(): string {
  if (!fs.existsSync(SNAPSHOTS_ROOT)) throw new Error('No snapshots yet. Run: npm run snapshot');
  const dirs = fs.readdirSync(SNAPSHOTS_ROOT).filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  if (!dirs.length) throw new Error('No snapshots yet. Run: npm run snapshot');
  return path.join(SNAPSHOTS_ROOT, dirs[dirs.length - 1]);
}

export function loadSnapshot(dir = latestSnapshotDir()): Snapshot {
  const indexPath = path.join(dir, 'index.json');
  if (!fs.existsSync(indexPath)) throw new Error(`${rel(indexPath)} not found`);
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as SnapshotIndex;
  const sources: Snapshot['sources'] = {};
  for (const e of index.files) {
    // Read each file from THIS folder (so a copied snapshot folder is read from its own location)
    (sources as any)[e.id] = JSON.parse(fs.readFileSync(path.join(dir, path.basename(e.file)), 'utf8'));
  }
  return { dir: rel(dir), index, sources };
}

/** Rebuild index.json from the source files present in a snapshot folder. */
export function writeIndex(dir: string): SnapshotIndex {
  const files: SnapshotIndexEntry[] = [];
  for (const id of ALL_SOURCES) {
    const f = fileFor(dir, id);
    if (fs.existsSync(f)) files.push({ id, file: rel(f), sha256: sha256File(f) });
  }
  const index: SnapshotIndex = { createdAt: new Date().toISOString(), dir: rel(dir), files };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}
