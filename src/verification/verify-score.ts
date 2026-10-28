import * as atprotoCrypto from '@atproto/crypto';
import crypto from 'node:crypto';
import { cachedResolver } from '../identity/plc-cache.js';
import { onlineResolver, type AuditEntry, type DidResolver } from '../identity/resolve-did.js';
import { FORMULAS } from '../scoring/compute-score.js';
import { decodeScoreVC } from '../scoring/read-vc.js';
import { findVenue, handleOf } from '../venues/registry.js';
import { loadVenueRecords } from '../venues/venue-records.js';

/**
 * Verify a score credential the way an outside party would:
 *
 *   1. Signature   resolve the issuer DID on plc.directory, take its #signing-1
 *                  public key, check the JWT signature (ES256)
 *   2. Identities  issuer, subject and manifest agree on the platform and venue DIDs
 *   3. Venue       the venue DID actually belongs to the venue the manifest names
 *   4. Recompute   running the formula on those inputs reproduces the signed score
 */

export type Status = 'pass' | 'fail' | 'warn' | 'skip';
export interface Check { name: string; status: Status; detail: string }
export interface VerifyReport { venueKey: string; venueDID: string; issuer: string; score: number | null; class?: string; checks: Check[]; ok: boolean }

export interface VerifyOptions {
  resolver?: DidResolver; // where DID audit logs come from; default: plc.directory
  timings?: { signatureMs?: number; recomputeMs?: number }; // filled in with how long those two checks took (for benchmarks)
}

/** P-256 did:key → node public key object. */
function p256KeyFromDidKey(didKey: string): crypto.KeyObject {
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
async function resolveSigningKey(issuer: string, signedAt: number, resolver: DidResolver): Promise<{ didKey: string; via: string }> {
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

  return { venueKey: manifest.venueKey, venueDID: subject.venue, issuer: claims.iss, score: subject.score, class: subject.class, checks, ok: !checks.some((c) => c.status === 'fail') };
}
