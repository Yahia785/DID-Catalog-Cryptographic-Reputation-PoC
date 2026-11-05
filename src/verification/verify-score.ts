import * as atprotoCrypto from '@atproto/crypto';
import crypto from 'node:crypto';
import { cachedResolver } from '../identity/plc-cache.js';
import { onlineResolver, type AuditEntry, type DidResolver } from '../identity/resolve-did.js';
import { FORMULAS } from '../scoring/compute-score.js';
import { ANCHOR_SERVICE_KEY, anchorHeadOf, chainProblems, hashFormulaCode, loadReleases, recordHash, releaseJwsProblem, type ReleaseList } from '../scoring/formula-releases.js';
import { decodeScoreVC } from '../scoring/read-vc.js';
import type { ProvenanceManifest } from '../shared/types.js';
import { findVenue, handleOf } from '../venues/registry.js';
import { checkInputs, providerFilesFor, ProviderFiles, type InputsResult } from './check-inputs.js';
import { loadVenueRecords } from '../venues/venue-records.js';

/**
 * Verify a score credential the way an outside party would:
 *
 *   1. Signature   resolve the issuer DID on plc.directory, take its #signing-1
 *                  public key, check the JWT signature (ES256)
 *   2. Identities  issuer, subject and manifest agree on the platform and venue DIDs
 *   3. Venue       the venue DID actually belongs to the venue the manifest names
 *   4. Recompute   running the formula on those inputs reproduces the signed score
 *   5. Formula     the formula's code is the one that was released: its code hash is in a signed,
 *                  unbroken release chain whose head is anchored in the platform DID, and the anchor
 *                  is older than the credential
 *   6. Inputs      (only with the sourcesDir option) the inputs match the provider's own published files
 *                  that the checker downloaded: see check-inputs.ts
 */

export type Status = 'pass' | 'fail' | 'warn' | 'skip';
export interface Check { name: string; status: Status; detail: string }
export interface VerifyReport { venueKey: string; venueDID: string; issuer: string; score: number | null; class?: string; checks: Check[]; ok: boolean; inputs?: InputsResult }

export interface VerifyOptions {
  resolver?: DidResolver; // where DID audit logs come from; default: plc.directory
  timings?: { signatureMs?: number; recomputeMs?: number; formulaMs?: number; inputsMs?: number }; // filled in with how long those checks took (for benchmarks)
  sourcesDir?: string | ProviderFiles; // folder with the provider's own icore.csv / scimago.csv / retraction_watch.csv; adds the sixth check, Inputs
  releases?: ReleaseList | null; // the formula release list; default: releases/formula-releases.json
  codeHashOf?: (formulaVersion: string) => string; // hash of this checker's own copy of a formula's code; default: hash the source file
}

/** P-256 did:key → node public key object. */
export function p256KeyFromDidKey(didKey: string): crypto.KeyObject {
  const parsed = atprotoCrypto.parseMultikey(atprotoCrypto.extractMultikey(didKey));
  if (parsed.jwtAlg !== 'ES256') throw new Error(`expected a P-256 key, got ${parsed.jwtAlg}`);
  // SPKI DER header for a P-256 point: compressed (33 bytes) or uncompressed (65 bytes)
  const bytes = Buffer.from(parsed.keyBytes);
  const header = Buffer.from(bytes.length === 33
    ? '3039301306072a8648ce3d020106082a8648ce3d030107032200'
    : '3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([header, bytes]), format: 'der', type: 'spki' });
}

/**
 * Find the key the issuer had when it signed: replay the DID's audit log and take the last
 * operation that was already in force at the signing time (the JWT's nbf).
 *
 * Known limitation: the signing time is set by the platform itself, so a platform that has
 * lost an old key could backdate a credential to when that key was still valid. We also trust
 * plc.directory (or the cached copy of it) to serve the log correctly.
 */
export async function resolveSigningKey(issuer: string, signedAt: number, resolver: DidResolver): Promise<{ didKey: string; via: string }> {
  let log: AuditEntry[];
  try {
    log = await resolver.auditLog(issuer);
  } catch (e) {
    throw new Error(e instanceof Error && e.message.startsWith('no cached') ? e.message : `could not get the audit log of ${issuer} from ${resolver.via}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ops = log.filter((e) => !e.nullified).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  if (ops.length === 0) throw new Error(`audit log of ${issuer} has no valid operations`);
  if (!Number.isFinite(signedAt)) throw new Error('credential has no valid nbf (signing time)');
  const inForce = ops.filter((e) => Date.parse(e.createdAt) / 1000 <= signedAt);
  if (inForce.length === 0) throw new Error(`credential was signed (${new Date(signedAt * 1000).toISOString()}) before the issuer DID existed (first operation ${ops[0].createdAt})`);
  const op = inForce[inForce.length - 1];
  const didKey = op.operation.verificationMethods?.['signing-1'];
  if (!didKey) throw new Error('issuer DID had no signing-1 key at signing time');
  return { didKey, via: `key from operation ${inForce.length} of ${ops.length} (${op.local && Date.parse(op.createdAt) === 0 ? 'local cache, no date' : op.createdAt.slice(0, 10)}), via ${resolver.via}${op.local ? ' [local genesis]' : ''}` };
}

/**
 * Check 5. Returns pass/fail, or 'warn' for a credential issued before formula releases existed
 * (no codeHash). Everything is judged from the credential, this checker's own copy of the formula
 * code, the release list and the platform DID's audit log.
 */
async function checkFormula(manifest: ProvenanceManifest, nbf: number, resolver: DidResolver, opts: VerifyOptions): Promise<{ status: Status; detail: string }> {
  if (!manifest.codeHash) return { status: 'warn', detail: 'no fingerprint (issued before releases)' };
  const fail = (detail: string) => ({ status: 'fail' as const, detail });
  const v = manifest.formulaVersion;
  const list = opts.releases === undefined ? loadReleases() : opts.releases;
  if (!list) return fail('no formula release list (releases/formula-releases.json)');
  const idx = list.records.findIndex((r) => r.record.formulaVersion === v);
  if (idx < 0) return fail(`formula ${v} has no release record`);
  const rec = list.records[idx].record;
  if (rec.codeHash !== manifest.codeHash) return fail(`the credential's codeHash ${manifest.codeHash.slice(0, 12)}… is not the released one (${rec.codeHash.slice(0, 12)}…)`);
  let own: string;
  try { own = (opts.codeHashOf ?? hashFormulaCode)(v); } catch (e) { return fail(`could not hash this checker's copy of formula ${v}: ${e instanceof Error ? e.message : String(e)}`); }
  if (own !== rec.codeHash) return fail(`this checker's copy of formula ${v} hashes to ${own.slice(0, 12)}…, the release says ${rec.codeHash.slice(0, 12)}…: the code was edited`);

  const chain = chainProblems(list.records.map((r) => r.record));
  if (chain.length) return fail(`release chain broken: ${chain.join('; ')}`);

  // this check needs the platform DID's audit log several times (anchors, the key at each release): fetch it once
  const memo = new Map<string, Promise<AuditEntry[]>>();
  const once: DidResolver = { via: resolver.via, auditLog: (did) => { let p = memo.get(did); if (!p) { p = resolver.auditLog(did); memo.set(did, p); } return p; } };
  let log: AuditEntry[];
  try { log = await once.auditLog(manifest.platformDID); } catch (e) { return fail(`could not get the platform DID's audit log: ${e instanceof Error ? e.message : String(e)}`); }

  for (const signed of list.records) {
    try {
      const { didKey } = await resolveSigningKey(manifest.platformDID, Date.parse(signed.record.releasedAt) / 1000, once);
      const problem = releaseJwsProblem(signed, p256KeyFromDidKey(didKey));
      if (problem) return fail(`release record ${signed.record.formulaVersion}: ${problem}`);
    } catch (e) { return fail(`release record ${signed.record.formulaVersion}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  const hashes = list.records.map((r) => recordHash(r.record));
  const head = hashes[hashes.length - 1];
  const anchors = log.filter((e) => !e.nullified).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt))
    .map((e) => ({ head: anchorHeadOf((e.operation.services as Record<string, unknown> | undefined)?.[ANCHOR_SERVICE_KEY]), createdAt: e.createdAt }))
    .filter((a): a is { head: string; createdAt: string } => a.head !== null);
  if (!anchors.some((a) => a.head === head)) return fail(`the release chain head ${head.slice(0, 12)}… is not anchored in the platform DID (anchors there: ${anchors.map((a) => a.head.slice(0, 12) + '…').join(', ') || 'none'})`);
  // the first anchor that covers this formula's record: its head is this record's hash or a later one's
  const first = anchors.find((a) => hashes.slice(idx).includes(a.head))!;
  if (Math.floor(Date.parse(first.createdAt) / 1000) > nbf) return fail(`formula ${v} was anchored at ${first.createdAt}, after the credential was signed (${new Date(nbf * 1000).toISOString()})`);
  return { status: 'pass', detail: `${v}: code ${rec.codeHash.slice(0, 12)}… matches the release and this checker's copy; ${list.records.length} release(s) chained and signed; head ${head.slice(0, 12)}… anchored ${first.createdAt.slice(0, 10)}, before signing, via ${resolver.via}` };
}

/** Resolver for the --offline flag: the cached public audit logs, nothing else. */
export const resolverFor = (offline: boolean): DidResolver => (offline ? cachedResolver : onlineResolver);

export async function verifyScoreJwt(jwt: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const resolver = opts.resolver ?? onlineResolver;
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });
  const vc = decodeScoreVC(jwt);
  const { subject, manifest, claims } = vc;

  // 1. Signature
  const tSig = performance.now();
  try {
    const { didKey, via } = await resolveSigningKey(claims.iss, claims.nbf, resolver);
    const [h, p, s] = vc.jwt.split('.');
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: p256KeyFromDidKey(didKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    add('Signature', valid ? 'pass' : 'fail', valid ? `valid, ${via}; ${didKey.slice(0, 24)}…` : 'does not match the issuer\'s signing key: the credential was altered or signed by someone else');
  } catch (e) {
    add('Signature', 'fail', e instanceof Error ? e.message : String(e));
  }

  if (opts.timings) opts.timings.signatureMs = performance.now() - tSig;

  // 2. Identities
  const idsOk = claims.iss === subject.platform && subject.platform === manifest.platformDID
    && claims.sub === subject.venue && subject.venue === manifest.venueDID;
  add('Identities', idsOk ? 'pass' : 'fail', idsOk ? `issuer ${claims.iss}, venue ${claims.sub}` : 'issuer/venue DIDs disagree between the JWT, the score and the manifest');

  // 3. Venue
  // One-direction check only: does the venue DID claim this handle (alsoKnownAs)?
  // The reverse direction — proving the handle's domain actually points back to this
  // DID, via a DNS TXT record at _atproto.<handle> or https://<handle>/.well-known/atproto-did —
  // needs didcal.io to serve those records, so it is left as future work.
  const venue = findVenue(manifest.venueKey);
  if (!venue) {
    add('Venue', 'fail', `unknown venue key ${manifest.venueKey}`);
  } else {
    const typesAgree = subject.venueType === manifest.venueType && manifest.venueType === venue.type;
    if (!typesAgree) {
      add('Venue', 'fail', `venue type disagrees: credential ${subject.venueType}, manifest ${manifest.venueType}, registry ${venue.type}`);
    } else {
      const expected = handleOf(venue);
      try {
        // The venue's handle is whatever its latest valid operation claims
        const ops = (await resolver.auditLog(subject.venue)).filter((e) => !e.nullified).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
        if (ops.length === 0) throw new Error(`audit log of ${subject.venue} has no valid operations`);
        const handles = (ops[ops.length - 1].operation.alsoKnownAs ?? []).map((a) => a.replace(/^at:\/\//, ''));
        const via = resolver.via;
        if (handles.includes(expected)) add('Venue', 'pass', `${manifest.venueKey} → ${expected} (via ${via})`);
        else add('Venue', 'fail', `manifest says ${manifest.venueKey} (expects ${expected}) but ${subject.venue} is ${handles.join(', ') || 'unknown'}`);
      } catch (e) {
        add('Venue', 'fail', e instanceof Error && e.message.startsWith('no cached') ? e.message : `could not get the audit log of ${subject.venue}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 4. Recompute
  const tRec = performance.now();
  if (!venue) {
    add('Recompute', 'skip', 'venue check failed');
  } else {
    const problems: string[] = [];
    const mismatch = (field: string, expected: unknown, claimed: unknown) => {
      if (JSON.stringify(expected) !== JSON.stringify(claimed)) problems.push(`${field}: expected ${JSON.stringify(expected)}, claimed ${JSON.stringify(claimed)}`);
    };
    const formula = FORMULAS[manifest.formulaVersion];
    mismatch('formulaVersion (manifest vs credential)', manifest.formulaVersion, subject.formulaVersion);
    if (!formula) problems.push(`unknown formula version ${manifest.formulaVersion}`);
    else {
      mismatch('formula description', formula.description, manifest.formula);
      const re = formula.compute(manifest.venueType, manifest.inputs, manifest.cohort);
      mismatch('score', re.score, subject.score);
      mismatch('class', re.class, subject.class);
      mismatch('breakdown', re.breakdown, subject.breakdown);
      mismatch('confidence', re.confidence, subject.confidence);
      mismatch('flags', re.flags, subject.flags);
    }
    mismatch('venueType', venue.type, subject.venueType);
    mismatch('computedAt (manifest vs credential)', manifest.computedAt, subject.computedAt);
    mismatch('nbf', Math.floor(Date.parse(manifest.computedAt) / 1000), claims.nbf);
    mismatch('verificationMethod', `${claims.iss}#signing-1`, subject.verificationMethod);
    add('Recompute', problems.length ? 'fail' : 'pass', problems.length ? problems.join('; ') : `formula ${manifest.formulaVersion} reproduces score ${subject.score}, breakdown, confidence, flags and dates`);
  }

  if (opts.timings) opts.timings.recomputeMs = performance.now() - tRec;

  // 5. Formula
  const tFormula = performance.now();
  const formulaCheck = await checkFormula(manifest, claims.nbf, resolver, opts);
  add('Formula', formulaCheck.status, formulaCheck.detail);
  if (opts.timings) opts.timings.formulaMs = performance.now() - tFormula;

  // 6. Inputs (L3), only when the checker has provider files
  let inputs: InputsResult | undefined;
  if (opts.sourcesDir) {
    const tInputs = performance.now();
    inputs = checkInputs(manifest, typeof opts.sourcesDir === 'string' ? providerFilesFor(opts.sourcesDir) : opts.sourcesDir);
    add('Inputs', inputs.status === 'skip' ? 'skip' : inputs.status, inputs.detail);
    if (opts.timings) opts.timings.inputsMs = performance.now() - tInputs;
  }

  return { venueKey: manifest.venueKey, venueDID: subject.venue, issuer: claims.iss, score: subject.score, class: subject.class, checks, ok: !checks.some((c) => c.status === 'fail'), ...(inputs ? { inputs } : {}) };
}
