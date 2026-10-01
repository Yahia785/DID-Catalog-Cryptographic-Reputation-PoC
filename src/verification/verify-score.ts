import * as atprotoCrypto from '@atproto/crypto';
import crypto from 'node:crypto';
import { loadJson, PLATFORM_FILE } from '../identity/identity-store.js';
import { resolveDID } from '../identity/resolve-did.js';
import { computeScore } from '../scoring/compute-score.js';
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
export interface VerifyReport { venueKey: string; venueDID: string; issuer: string; score: number | null; checks: Check[]; ok: boolean }

export interface VerifyOptions {
  offline?: boolean; // use output/platform.json instead of plc.directory for the issuer key
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

/** Find the issuer's signing key: live from plc.directory, or (offline only) from the local platform file. */
async function resolveSigningKey(issuer: string, offline: boolean): Promise<{ didKey: string; via: string }> {
  if (!offline) {
    let res: Response;
    try {
      res = await fetch(`https://plc.directory/${issuer}/data`);
    } catch (e) {
      throw new Error(`could not reach plc.directory: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      if (res.status === 404) throw new Error(`plc.directory returned 404 for ${issuer}; the platform DID is not published (use --offline for local dry-run identities)`);
      throw new Error(`plc.directory returned ${res.status} for ${issuer}`);
    }
    const data = (await res.json()) as { verificationMethods?: Record<string, string> };
    const k = data.verificationMethods?.['signing-1'];
    if (!k) throw new Error('issuer DID has no signing-1 key');
    return { didKey: k, via: 'plc.directory' };
  }
  const local = loadJson<{ did: string; signingKeyPair: { did: string } }>(PLATFORM_FILE);
  if (local?.did === issuer) return { didKey: local.signingKeyPair.did, via: 'local output/platform.json (offline)' };
  throw new Error('cannot resolve issuer key (offline and no matching local platform file)');
}

export async function verifyScoreJwt(jwt: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const checks: Check[] = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });
  const vc = decodeScoreVC(jwt);
  const { subject, manifest, claims } = vc;

  // 1. Signature
  try {
    const { didKey, via } = await resolveSigningKey(claims.iss, !!opts.offline);
    const [h, p, s] = vc.jwt.split('.');
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: p256KeyFromDidKey(didKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    add('Signature', valid ? 'pass' : 'fail', valid ? `valid, key ${didKey.slice(0, 24)}… via ${via}` : 'does not match the issuer\'s signing key: the credential was altered or signed by someone else');
  } catch (e) {
    add('Signature', 'fail', e instanceof Error ? e.message : String(e));
  }

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
        let handles: string[];
        let via: string;
        if (!opts.offline) {
          const doc = await resolveDID(subject.venue);
          handles = (doc.alsoKnownAs ?? []).map((a) => a.replace(/^at:\/\//, ''));
          via = 'plc.directory';
        } else {
          const records = loadVenueRecords();
          const rec = Object.values(records).find((r) => r.did === subject.venue);
          if (!rec) throw new Error('venue DID not found in output/venues.json');
          handles = [rec.handle];
          via = 'output/venues.json, offline';
        }
        if (handles.includes(expected)) add('Venue', 'pass', `${manifest.venueKey} → ${expected} (via ${via})`);
        else add('Venue', 'fail', `manifest says ${manifest.venueKey} (expects ${expected}) but ${subject.venue} is ${handles.join(', ') || 'unknown'}`);
      } catch (e) {
        add('Venue', 'fail', e instanceof Error ? e.message : String(e));
      }
    }
  }

  // 4. Recompute
  if (!venue) {
    add('Recompute', 'skip', 'venue check failed');
  } else {
    const re = computeScore(manifest.venueType, manifest.inputs);
    const same = re.score === subject.score && JSON.stringify(re.breakdown) === JSON.stringify(subject.breakdown);
    add('Recompute', same ? 'pass' : 'fail', same ? `formula ${manifest.formulaVersion} gives ${re.score} = signed ${subject.score}` : `formula gives ${re.score}, credential claims ${subject.score}`);
  }

  return { venueKey: manifest.venueKey, venueDID: subject.venue, issuer: claims.iss, score: subject.score, checks, ok: !checks.some((c) => c.status === 'fail') };
}
