import { ES256Signer } from 'did-jwt';
import { createVerifiableCredentialJwt, type CredentialPayload, type Issuer } from 'did-jwt-vc';
import type { Identity, ReputationScore, ScoreVC } from '../shared/types.js';

/**
 * Sign a computed score as a W3C Verifiable Credential (JWT, ES256).
 *
 *   issuer             = the platform DID (signs with its own P-256 signing key)
 *   credentialSubject  = the venue DID + the score + the full provenance manifest
 *
 * The platform signs AS ITSELF, never as the venue. Venue signing keys are
 * never used by the platform.
 */
export async function issueScore(platform: Identity, score: ReputationScore): Promise<ScoreVC> {
  const { payload, manifest } = score;
  const issuer: Issuer = { did: platform.did, signer: ES256Signer(platform.signingKeyPair.privateKey), alg: 'ES256' };

  const vcPayload: CredentialPayload = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'VenueScoreCredential'],
    issuer: { id: platform.did },
    issuanceDate: payload.computedAt,
    credentialSubject: {
      id: payload.venue,
      ...payload,
      provenanceManifest: manifest,
    },
  };

  const jwt = await createVerifiableCredentialJwt(vcPayload, issuer);
  return { jwt, issuer: platform.did, subject: payload.venue, issuanceDate: payload.computedAt, payload, manifest };
}
