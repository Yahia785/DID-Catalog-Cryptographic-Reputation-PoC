import * as atprotoCrypto from '@atproto/crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadJson, PLATFORM_FILE } from '../identity/identity-store.js';
import { buildInputs } from '../scoring/build-score.js';
import { computeScore } from '../scoring/compute-score.js';
import { decodeScoreVC } from '../scoring/read-vc.js';
import { loadSnapshot } from '../scoring/snapshot-store.js';
import { sha256File } from '../shared/hash.js';
import { findVenue } from '../venues/registry.js';

/**
 * Verify a score credential the way an outside party would:
 *
 *   1. Signature   resolve the issuer DID on plc.directory, take its #signing-1
 *                  public key, check the JWT signature (ES256)
 *   2. Identities  issuer, subject and manifest agree on the platform and venue DIDs
 *   3. Hashes      every snapshot file named in the manifest has the recorded SHA-256
 *   4. Inputs      the inputs in the manifest are exactly what the snapshot files contain
 *   5. Recompute   running the formula on those inputs reproduces the signed score
 *   6. Freshness   no source is older than the allowed age (warning only)
 */

export type Status = 'pass' | 'fail' | 'warn' | 'skip';
export interface Check { name: string; status: Status; detail: string }
export interface VerifyReport { venueKey: string; venueDID: string; issuer: string; score: number | null; checks: Check[]; ok: boolean }

export interface VerifyOptions {
  offline?: boolean;            // use output/platform.json instead of plc.directory for the issuer key
  maxAgeDays?: number;          // freshness limit (default 30)
  now?: Date;                   // pretend "today" is this date (for the stale-data demo)
  snapshotDirOverride?: string; // read snapshot files from another folder (for the tamper demo)
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

/** Find the issuer's signing key: live from plc.directory, or from the local platform file. */
async function resolveSigningKey(issuer: string, offline: boolean): Promise<{ didKey: string; via: string }> {
  if (!offline) {
    try {
      const res = await fetch(`https://plc.directory/${issuer}/data`);
      if (res.ok) {
        const data = (await res.json()) as { verificationMethods?: Record<string, string> };
        const k = data.verificationMethods?.['signing-1'];
        if (k) return { didKey: k, via: 'plc.directory' };
        throw new Error('issuer DID has no signing-1 key');
      }
      throw new Error(`plc.directory returned ${res.status}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('issuer DID')) throw e;
      // network problem: fall through to the local copy
    }
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

  // 3. Hashes of the snapshot files
  const fileOf = (f: string) => (opts.snapshotDirOverride ? path.join(opts.snapshotDirOverride, path.basename(f)) : path.resolve(f));
  const bad: string[] = [], missing: string[] = [];
  for (const src of manifest.sources) {
    const f = fileOf(src.file);
    if (!fs.existsSync(f)) missing.push(src.file);
    else if (sha256File(f) !== src.sha256) bad.push(src.id);
  }
  if (missing.length) add('Snapshot hashes', 'fail', `missing file(s): ${missing.join(', ')}`);
  else add('Snapshot hashes', bad.length ? 'fail' : 'pass', bad.length ? `changed since signing: ${bad.join(', ')}` : `${manifest.sources.length} file(s) match their SHA-256`);

  // 4. Inputs match the snapshot
  const venue = findVenue(manifest.venueKey);
  if (!venue) add('Inputs match snapshot', 'fail', `unknown venue key ${manifest.venueKey}`);
  else if (missing.length) add('Inputs match snapshot', 'skip', 'snapshot files missing');
  else {
    try {
      const dir = opts.snapshotDirOverride ?? path.dirname(path.resolve(manifest.sources[0].file));
      const fromSnapshot = buildInputs(venue, loadSnapshot(dir));
      const diffs = manifest.inputs.filter((i) => JSON.stringify(fromSnapshot.find((x) => x.metric === i.metric)?.value ?? null) !== JSON.stringify(i.value));
      const sameCount = fromSnapshot.length === manifest.inputs.length;
      add('Inputs match snapshot', diffs.length || !sameCount ? 'fail' : 'pass',
        diffs.length ? `differs: ${diffs.map((d) => `${d.metric} (manifest ${d.value}, snapshot ${fromSnapshot.find((x) => x.metric === d.metric)?.value ?? null})`).join('; ')}`
          : sameCount ? `${manifest.inputs.length} input values match` : 'number of inputs differs');
    } catch (e) {
      add('Inputs match snapshot', 'fail', e instanceof Error ? e.message : String(e));
    }
  }

  // 5. Recompute
  const re = computeScore(manifest.venueType, manifest.inputs);
  const same = re.score === subject.score && JSON.stringify(re.breakdown) === JSON.stringify(subject.breakdown);
  add('Recompute', same ? 'pass' : 'fail', same ? `formula ${manifest.formulaVersion} gives ${re.score} = signed ${subject.score}` : `formula gives ${re.score}, credential claims ${subject.score}`);

  // 6. Freshness
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeDays ?? 30;
  const ages = manifest.sources.map((s) => ({ id: s.id, days: Math.floor((now.getTime() - new Date(s.retrievedAt).getTime()) / 86_400_000) }));
  const stale = ages.filter((a) => a.days > maxAge);
  const oldest = Math.max(...ages.map((a) => a.days));
  add('Freshness', stale.length ? 'warn' : 'pass', stale.length ? `older than ${maxAge} days: ${stale.map((a) => `${a.id} (${a.days}d)`).join(', ')}` : `oldest source ${oldest} day(s) old (limit ${maxAge})`);

  return { venueKey: manifest.venueKey, venueDID: subject.venue, issuer: claims.iss, score: subject.score, checks, ok: !checks.some((c) => c.status === 'fail') };
}
