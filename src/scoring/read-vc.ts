import fs from 'node:fs';
import path from 'node:path';
import type { ProvenanceManifest, ScorePayload } from '../shared/types.js';

export const SCORES_DIR = path.resolve('output/scores');

export interface DecodedScoreVC {
  jwt: string;
  header: { alg: string; typ?: string };
  claims: Record<string, any>;        // the JWT payload (iss, sub, nbf, vc)
  subject: ScorePayload;              // vc.credentialSubject without the manifest
  manifest: ProvenanceManifest;       // vc.credentialSubject.provenanceManifest
}

/** Decode (NOT verify) a score VC JWT into its parts. */
export function decodeScoreVC(jwt: string): DecodedScoreVC {
  const [h, p] = jwt.trim().split('.');
  if (!h || !p) throw new Error('Not a JWT');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const { provenanceManifest, id: _id, ...subject } = claims.vc?.credentialSubject ?? {};
  return { jwt: jwt.trim(), header, claims, subject: subject as ScorePayload, manifest: provenanceManifest as ProvenanceManifest };
}

export const vcPathFor = (slug: string) => path.join(SCORES_DIR, `${slug}.vc.jwt`);

export function readScoreVC(slug: string): DecodedScoreVC {
  const file = vcPathFor(slug);
  if (!fs.existsSync(file)) throw new Error(`${path.relative('.', file)} not found. Run: npm run score`);
  return decodeScoreVC(fs.readFileSync(file, 'utf8'));
}
