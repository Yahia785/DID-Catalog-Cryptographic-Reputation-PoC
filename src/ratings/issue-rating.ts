import { ES256Signer } from 'did-jwt';
import { createVerifiableCredentialJwt } from 'did-jwt-vc';
import type { CredentialPayload, Issuer } from 'did-jwt-vc';
import crypto from 'node:crypto';
import type { Identity, RatingPayload, SignedRating, VenueRatingVC } from '../shared/types.js';

/**
 * Recursively sort all object keys and stringify.
 * Unlike JSON.stringify with an array replacer, this sorts keys
 * at every level of nesting, ensuring nested fields like
 * ratings.legitimacy are included in the canonical form.
 */
function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });
}

/**
 * Build a canonical rating payload.
 */
function buildRatingPayload(
  reviewerDID: string,
  venueDID: string,
  ratings: { legitimacy: number; reviewQuality: number; overall: number },
  timestamp?: string
): RatingPayload {
  return {
    type: 'VenueRating',
    reviewer: reviewerDID,
    venue: venueDID,
    verificationMethod: `${reviewerDID}#signing-1`,
    ratings: {
      legitimacy: ratings.legitimacy,
      reviewQuality: ratings.reviewQuality,
      overall: ratings.overall,
    },
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

/**
 * Create a canonical hash of a rating payload.
 * Sorts keys via JSON.stringify replacer, then SHA-256.
 */
function canonicalHash(payload: RatingPayload): string {
  const canonical = stableStringify(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Sign a rating payload with P-256 private key using ES256Signer.
 * Returns the base64url-encoded ECDSA signature.
 */
async function signCanonical(payload: RatingPayload, privateKey: Uint8Array): Promise<string> {
  const canonical = stableStringify(payload);
  const signer = ES256Signer(privateKey);
  const result = await signer(canonical);
  return typeof result === 'string' ? result : `${result.r}.${result.s}`;
}

/**
 * Issue a signed rating as a JWT-based Verifiable Credential.
 *
 * Creates both:
 * - A W3C Verifiable Credential (JWT format) using did-jwt-vc
 * - A raw canonical signature for independent verification without JWT libraries
 */
export async function issueRating(
  reviewer: Identity,
  venueDID: string,
  ratings: { legitimacy: number; reviewQuality: number; overall: number },
  timestamp?: string
): Promise<{ vc: VenueRatingVC; signedRating: SignedRating }> {
  // 1. Build the rating payload
  const payload = buildRatingPayload(reviewer.did, venueDID, ratings, timestamp);

  // 2. Create raw canonical signature (for independent verification)
  const payloadHash = canonicalHash(payload);
  const signature = await signCanonical(payload, reviewer.signingKeyPair.privateKey);

  const signedRating: SignedRating = {
    payload,
    signature,
    payloadHash,
  };

  // 3. Create the Verifiable Credential using did-jwt-vc
  const signer = ES256Signer(reviewer.signingKeyPair.privateKey);

  const issuer: Issuer = {
    did: reviewer.did,
    signer,
    alg: 'ES256',
  };

  const vcPayload: CredentialPayload = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'VenueRatingCredential'],
    issuer: { id: reviewer.did },
    issuanceDate: payload.timestamp,
    credentialSubject: {
      id: venueDID,
      type: 'VenueRating',
      reviewer: reviewer.did,
      verificationMethod: payload.verificationMethod,
      ratings: payload.ratings,
      canonicalHash: payloadHash,
    },
  };

  const jwt = await createVerifiableCredentialJwt(vcPayload, issuer);

  const vc: VenueRatingVC = {
    jwt,
    decoded: {
      issuer: reviewer.did,
      subject: venueDID,
      issuanceDate: payload.timestamp,
      credentialSubject: payload,
    },
  };

  return { vc, signedRating };
}

export { canonicalHash };