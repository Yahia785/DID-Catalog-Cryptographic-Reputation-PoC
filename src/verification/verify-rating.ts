import { ES256Signer } from 'did-jwt';
import crypto from 'node:crypto';
import type { SignedRating, VerificationResult } from '../shared/types.js';

/**
 * Reconstruct the canonical form of a rating payload.
 * Same process used during signing: sort keys, JSON.stringify.
 */
function canonicalize(payload: SignedRating['payload']): string {
  return JSON.stringify(payload, (_key, value) => {
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
 * Verify a signed rating against a known public key.
 *
 * In production, the public key would be resolved from plc.directory
 * by looking up the reviewer's DID and extracting the verification
 * method referenced in the rating payload. Here we accept it directly.
 *
 * Steps:
 * 1. Reconstruct the canonical payload
 * 2. Recompute the SHA-256 hash
 * 3. Verify the ECDSA signature against the provided public key
 */
export async function verifyRating(
  signedRating: SignedRating,
  signerPublicKey: Uint8Array
): Promise<VerificationResult> {
  const { payload, signature, payloadHash } = signedRating;

  try {
    // 1. Reconstruct canonical form and verify hash
    const canonical = canonicalize(payload);
    const recomputedHash = crypto.createHash('sha256').update(canonical).digest('hex');

    if (recomputedHash !== payloadHash) {
      return {
        valid: false,
        reviewerDID: payload.reviewer,
        venueDID: payload.venue,
        verificationMethod: payload.verificationMethod,
        error: `Hash mismatch: expected ${payloadHash}, got ${recomputedHash}`,
      };
    }

    // 2. Build the public key object for node:crypto verification
    // The public key is a 33-byte compressed P-256 point.
    // node:crypto needs it in SPKI DER format.
    const spkiDer = buildSpkiFromCompressed(signerPublicKey);
    const pubKeyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    // 3. The signature from ES256Signer is base64url-encoded raw r||s (64 bytes).
    // node:crypto expects DER-encoded signature for verify.
    const sigBytes = Buffer.from(signature, 'base64url');
    const derSig = rawSigToDer(sigBytes);

    // 4. Verify
    const verifier = crypto.createVerify('SHA256');
    verifier.update(canonical);
    const valid = verifier.verify(pubKeyObj, derSig);

    return {
      valid,
      reviewerDID: payload.reviewer,
      venueDID: payload.venue,
      verificationMethod: payload.verificationMethod,
      error: valid ? undefined : 'Signature verification failed',
    };
  } catch (e) {
    return {
      valid: false,
      reviewerDID: payload.reviewer,
      venueDID: payload.venue,
      verificationMethod: payload.verificationMethod,
      error: `Verification error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Build SPKI DER encoding from a 33-byte compressed P-256 public key.
 *
 * SPKI structure for P-256:
 *   SEQUENCE {
 *     SEQUENCE { OID(ecPublicKey), OID(prime256v1) }
 *     BIT STRING { 0x00 || uncompressed_point }
 *   }
 *
 * However, node:crypto also accepts compressed points in the BIT STRING,
 * so we use the compressed form directly (34 bytes: 0x00 pad + 33 bytes).
 */
function buildSpkiFromCompressed(compressed: Uint8Array): Buffer {
  // Fixed SPKI header for P-256 (26 bytes)
  const header = Buffer.from([
    0x30, 0x39,             // SEQUENCE (57 bytes total)
    0x30, 0x13,             // SEQUENCE (19 bytes) - AlgorithmIdentifier
    0x06, 0x07,             // OID (7 bytes) - ecPublicKey
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08,             // OID (8 bytes) - prime256v1
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    0x03, 0x22,             // BIT STRING (34 bytes)
    0x00,                   // no unused bits
  ]);
  return Buffer.concat([header, Buffer.from(compressed)]);
}

/**
 * Convert a raw ECDSA signature (r || s, 64 bytes) to DER encoding.
 * node:crypto's verify expects DER format.
 */
function rawSigToDer(raw: Buffer): Buffer {
  if (raw.length !== 64) {
    throw new Error(`Expected 64-byte raw signature, got ${raw.length}`);
  }

  const r = raw.subarray(0, 32);
  const s = raw.subarray(32, 64);

  function encodeInteger(bytes: Buffer): Buffer {
    // If high bit is set, prepend 0x00 to keep it positive
    const needsPad = bytes[0] >= 0x80;
    // Strip leading zeros (but keep at least one byte)
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.subarray(start);
    const needsPadAfterTrim = trimmed[0] >= 0x80;

    if (needsPadAfterTrim) {
      const padded = Buffer.alloc(trimmed.length + 1);
      padded[0] = 0x00;
      trimmed.copy(padded, 1);
      return Buffer.concat([Buffer.from([0x02, padded.length]), padded]);
    }
    return Buffer.concat([Buffer.from([0x02, trimmed.length]), trimmed]);
  }

  const rDer = encodeInteger(r);
  const sDer = encodeInteger(s);
  const body = Buffer.concat([rDer, sDer]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}