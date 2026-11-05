import { ES256Signer } from 'did-jwt';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Identity } from '../shared/types.js';

/**
 * Tamper-evident list of formula releases.
 *
 * Each release record says "formula version V has code hash H and this description, released at T",
 * and links to the previous record by its hash (prevHash), so records cannot be removed, reordered or
 * edited without breaking the chain. Every record is signed by the platform signing key (compact JWS,
 * ES256). The hash of the NEWEST record (the head) is written into the platform DID on plc.directory
 * as a service entry, so the platform cannot quietly change the list or back-date a formula: the
 * directory's own timestamp says when each head existed.
 *
 * The list is committed in the repository (releases/formula-releases.json): it is public, not data.
 */

/** Which source file holds each formula. Hashing the file pins the formula's code. */
export const FORMULA_SOURCES: Record<string, string> = {
  '0.1-demo': 'src/scoring/compute-score.ts',
  '1.0': 'src/scoring/formula-1.ts',
};
export const RELEASES_FILE = 'releases/formula-releases.json';
export const ANCHOR_SERVICE_KEY = 'didcal_formulas';
export const ANCHOR_SERVICE_TYPE = 'DIDcalFormulaReleases';
export const RELEASE_JWS_TYP = 'didcal-formula-release+jws';

export interface ReleaseRecord {
  formulaVersion: string;
  codeHash: string;            // SHA-256 of the formula's source file, line endings normalised to LF
  description: string;         // the formula description string signed into credentials
  releasedAt: string;          // ISO time
  prevHash: string | null;     // SHA-256 of the previous record's canonical JSON (null for the first)
}
export interface SignedRelease { record: ReleaseRecord; jws: string }
export interface ReleaseList { platform: string; records: SignedRelease[] }

// ── hashing ──────────────────────────────────────────────────
export const sha256Hex = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');

/** JSON with object keys sorted and no whitespace: the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export const recordHash = (r: ReleaseRecord) => sha256Hex(canonicalJson(r));

/** SHA-256 of a formula's source file with CRLF → LF, so the hash is the same on every OS. */
export function hashFormulaCode(version: string, root = process.cwd()): string {
  const rel = FORMULA_SOURCES[version];
  if (!rel) throw new Error(`no source file is registered for formula ${version}`);
  const text = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
  return sha256Hex(text);
}

// ── the list ─────────────────────────────────────────────────
export function loadReleases(file = RELEASES_FILE): ReleaseList | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ReleaseList) : null;
}
export function saveReleases(list: ReleaseList, file = RELEASES_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
}

/** Problems with the hash links of a chain of records (empty = unbroken). */
export function chainProblems(records: ReleaseRecord[]): string[] {
  const problems: string[] = [];
  records.forEach((r, i) => {
    const expected = i === 0 ? null : recordHash(records[i - 1]);
    if (r.prevHash !== expected) {
      problems.push(i === 0
        ? `the first record (${r.formulaVersion}) must have prevHash null but has ${String(r.prevHash).slice(0, 12)}…: earlier records were removed`
        : `record ${i + 1} (${r.formulaVersion}) points to ${String(r.prevHash).slice(0, 12)}… but the record before it hashes to ${expected!.slice(0, 12)}…: a record was removed or edited`);
    }
  });
  const versions = records.map((r) => r.formulaVersion);
  const dup = versions.find((v, i) => versions.indexOf(v) !== i);
  if (dup) problems.push(`formula ${dup} has more than one record`);
  return problems;
}

// ── signing ──────────────────────────────────────────────────
const b64 = (s: string) => Buffer.from(s).toString('base64url');

/** Compact JWS (ES256) over the record's canonical JSON, signed with the platform signing key. */
export async function signRelease(record: ReleaseRecord, platform: Pick<Identity, 'did' | 'signingKeyPair'>): Promise<string> {
  const header = b64(JSON.stringify({ alg: 'ES256', typ: RELEASE_JWS_TYP, kid: `${platform.did}#signing-1` }));
  const payload = b64(canonicalJson(record));
  const sig = await ES256Signer(platform.signingKeyPair.privateKey)(`${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

/** Why a release JWS does not hold, or null when it verifies with `key` and carries exactly `record`. */
export function releaseJwsProblem(signed: SignedRelease, key: crypto.KeyObject): string | null {
  const parts = signed.jws.split('.');
  if (parts.length !== 3) return 'the JWS is not in compact form';
  const [h, p, s] = parts;
  let header: { alg?: string };
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString()); } catch { return 'unreadable JWS header'; }
  if (header.alg !== 'ES256') return `unexpected JWS algorithm ${header.alg}`;
  if (Buffer.from(p, 'base64url').toString() !== canonicalJson(signed.record)) return 'the record was changed after it was signed (it differs from the signed payload)';
  const valid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return valid ? null : 'the signature does not match the platform signing key';
}

// ── the anchor in the platform DID ───────────────────────────
export const anchorService = (head: string) => ({ type: ANCHOR_SERVICE_TYPE, endpoint: `https://didcal.io/formulas#sha256=${head}` });
/** The head hash in an anchor service endpoint, or null. */
export const anchorHeadOf = (service: unknown): string | null => {
  const endpoint = (service as { endpoint?: unknown } | undefined)?.endpoint;
  return typeof endpoint === 'string' ? endpoint.match(/#sha256=([0-9a-f]{64})$/)?.[1] ?? null : null;
};
