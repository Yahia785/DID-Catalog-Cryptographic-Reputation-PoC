import * as atprotoCrypto from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import crypto from 'node:crypto';
import type { Identity } from '../shared/types.js';

// ─── CID computation ─────────────────────────────────────────

/**
 * Compute the CID (Content Identifier) of a signed PLC operation.
 *
 * PLC uses CID v1 with:
 *   - dag-cbor codec (0x71)
 *   - sha-256 multihash (0x12, 32 bytes)
 *   - base32lower multibase encoding
 *
 * The CID of operation N becomes the `prev` field of operation N+1,
 * forming the append-only sigchain.
 */
function computeOperationCID(signedOperation: Record<string, unknown>): string {
  const cbor = dagCbor.encode(signedOperation);
  const hash = crypto.createHash('sha256').update(cbor).digest();

  // CID v1: version(0x01) + codec(0x71) + multihash-algo(0x12) + length(0x20) + hash
  const cidPrefix = new Uint8Array([0x01, 0x71, 0x12, 0x20]);
  const cidBytes = new Uint8Array(cidPrefix.length + hash.length);
  cidBytes.set(cidPrefix);
  cidBytes.set(hash, cidPrefix.length);

  return base32.encode(cidBytes);
}

// ─── Fetch current state ─────────────────────────────────────

/**
 * Fetch the most recent signed operation for a DID from plc.directory.
 * The audit log is an ordered array; the last entry is the current state.
 */
async function fetchCurrentOperation(
  did: string
): Promise<Record<string, unknown>> {
  const url = `https://plc.directory/${did}/log/audit`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch audit log (${response.status}): ${body}`);
  }

  const log = (await response.json()) as Array<Record<string, unknown>>;
  if (log.length === 0) {
    throw new Error('Audit log is empty');
  }

  return log[log.length - 1];
}

/**
 * Recursively remove undefined values from an object.
 * DAG-CBOR does not support undefined — all values must be
 * concrete (strings, numbers, arrays, objects, null, booleans).
 */
function removeUndefined(obj: unknown): unknown {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== 'object') return obj;
  // Preserve CID objects — they have special DAG-CBOR encoding
  if (obj instanceof CID) return obj;
  if (ArrayBuffer.isView(obj)) return obj;
  if (Array.isArray(obj)) return obj.map(removeUndefined);
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (value !== undefined) {
      cleaned[key] = removeUndefined(value);
    }
  }
  return cleaned;
}

/**
 * Extract the core operation fields from an audit log entry.
 *
 * plc.directory returns audit log entries in this format:
 *   { did, operation: { sig, prev, type, services, ... }, cid, nullified, createdAt }
 *
 * The actual operation is nested under the 'operation' key.
 * Only the spec-defined operation fields are returned.
 */
function extractOperationFields(
  auditEntry: Record<string, unknown>
): Record<string, unknown> {
  // The operation may be nested under 'operation' key (plc.directory format)
  // or flat at the top level (raw operation format)
  const source = (auditEntry.operation && typeof auditEntry.operation === 'object')
    ? auditEntry.operation as Record<string, unknown>
    : auditEntry;

  const opFields = [
    'type', 'rotationKeys', 'verificationMethods',
    'alsoKnownAs', 'services', 'prev', 'sig',
  ];
  const op: Record<string, unknown> = {};
  for (const field of opFields) {
    if (field in source && source[field] !== undefined) {
      op[field] = source[field];
    }
  }
  return op;
}

/**
 * Extract the current signing key DID from a PLC operation's
 * verificationMethods. Handles the audit log format where
 * verificationMethods is an object with named entries.
 */
function extractSigningKey(op: Record<string, unknown>): string | null {
  const vm = op.verificationMethods;
  if (vm && typeof vm === 'object') {
    const methods = vm as Record<string, string>;
    // Try 'signing-1' first, then fall back to any non-atproto key
    if (methods['signing-1']) return methods['signing-1'];
    for (const [key, value] of Object.entries(methods)) {
      if (key !== 'atproto' && typeof value === 'string') return value;
    }
  }
  return null;
}

// ─── Build and sign update operation ─────────────────────────

/**
 * Build an unsigned PLC update operation that transfers control
 * from the platform's rotation key to the venue's new rotation key.
 *
 * The update preserves all other DID document fields (services,
 * alsoKnownAs) and only changes:
 *   - rotationKeys → venue's new rotation key
 *   - verificationMethods.atproto → the venue's signing key
 *   - prev → CID of the current (most recent) operation
 *
 * The signing key (verificationMethods.signing-1) can optionally
 * be rotated too. If newSigningKeyDid is provided, it replaces
 * the existing signing key.
 */
function buildUpdateOperation(
  currentOp: Record<string, unknown>,
  prevCid: string,
  newRotationKeyDid: string,
  newSigningKeyDid?: string
): Record<string, unknown> {
  // Resolve the current signing key from the operation
  const currentSigningKey = extractSigningKey(currentOp);
  const signingKey = newSigningKeyDid ?? currentSigningKey;

  if (!signingKey) {
    throw new Error('Cannot determine signing key: not provided and not found in current operation');
  }

  const op = {
    type: 'plc_operation',
    rotationKeys: [newRotationKeyDid],
    verificationMethods: {
      atproto: signingKey,
      'signing-1': signingKey,
    },
    alsoKnownAs: currentOp.alsoKnownAs ?? [],
    services: currentOp.services ?? {},
    prev: prevCid,
  };

  // Clean any undefined values before DAG-CBOR encoding
  return removeUndefined(op) as Record<string, unknown>;
}

/**
 * Sign a PLC update operation with the current rotation key.
 *
 * Per PLC spec: the update must be signed by a key listed in
 * the CURRENT rotationKeys array (before the update takes effect).
 */
async function signUpdateOperation(
  unsignedOp: Record<string, unknown>,
  currentRotationKeyPair: atprotoCrypto.Secp256k1Keypair
): Promise<Record<string, unknown>> {
  // Encode directly — matching how signGenesisOperation works
  // in create-identity.ts. Do not transform the object (e.g. with
  // removeUndefined) before encoding, as that can change the
  // structure and produce different CBOR bytes.
  const cbor = dagCbor.encode(unsignedOp);
  const signature = await currentRotationKeyPair.sign(cbor);
  const sigBase64url = Buffer.from(signature).toString('base64url');
  return { ...unsignedOp, sig: sigBase64url };
}

// ─── Publish update ──────────────────────────────────────────

/**
 * Publish a signed update operation to plc.directory.
 * Uses the same endpoint as genesis: POST /{did}
 */
async function publishUpdate(
  did: string,
  signedOperation: Record<string, unknown>
): Promise<void> {
  const url = `https://plc.directory/${did}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signedOperation),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`plc.directory update failed (${response.status}): ${body}`);
  }
}

// ─── Main: claim venue ───────────────────────────────────────

export interface ClaimResult {
  did: string;
  previousRotationKeyDid: string;
  newRotationKeyDid: string;
  newSigningKeyDid: string | null;
  updateOperation: Record<string, unknown>;
  venueIdentity: Identity;
}

/**
 * Claim a venue DID by performing key rotation.
 *
 * This is the core trust-transfer operation in DIDcal:
 * 1. Fetch the venue's current PLC operation from plc.directory
 * 2. Generate new keypairs for the venue
 * 3. Build an update operation that replaces the platform's
 *    rotation key with the venue's new key
 * 4. Sign the update with the platform's current rotation key
 *    (proving the platform authorized the transfer)
 * 5. Publish the update to plc.directory
 *
 * After this operation:
 *   - The platform can NO LONGER modify the venue's DID
 *   - Only the venue's new rotation key can sign future updates
 *   - The audit log records both operations with timestamps
 *   - Anyone can verify the transfer by inspecting the log
 *
 * @param venueDid - The DID to claim
 * @param platformRotationPrivateKey - The platform's current rotation private key (raw bytes)
 * @param options.rotateSigningKey - Also generate a new signing key (default: true)
 * @param options.dryRun - Build but don't publish the update (default: false)
 */
export async function claimVenue(
  venueDid: string,
  platformRotationPrivateKey: Uint8Array,
  options: { rotateSigningKey?: boolean; dryRun?: boolean } = {}
): Promise<ClaimResult> {
  const rotateSigningKey = options.rotateSigningKey ?? true;

  // 1. Reconstruct the platform's rotation keypair from private key
  const platformRotationKeyPair = await atprotoCrypto.Secp256k1Keypair.import(
    platformRotationPrivateKey,
    { exportable: false }
  );
  const previousRotationKeyDid = platformRotationKeyPair.did();

  // 2. Fetch current operation from plc.directory
  let currentAuditEntry: Record<string, unknown>;
  let currentOp: Record<string, unknown>;
  let prevCid: string;

  if (options.dryRun) {
    // In dry run, we can't fetch from plc.directory since the DID
    // may not be published. Use a placeholder.
    throw new Error('Dry run not supported for claimVenue — the DID must be published to plc.directory first');
  }

  currentAuditEntry = await fetchCurrentOperation(venueDid);
  currentOp = extractOperationFields(currentAuditEntry);

  // Use the CID that plc.directory computed for this operation.
  // plc.directory includes a 'cid' field in each audit log entry.
  // Using it directly avoids CID mismatches from field ordering
  // differences in our DAG-CBOR encoding vs. theirs.
  if (typeof currentAuditEntry.cid === 'string') {
    prevCid = currentAuditEntry.cid;
  } else {
    // Fallback: compute it ourselves (may not match plc.directory)
    prevCid = computeOperationCID(currentOp);
  }

  // 3. Generate new rotation keypair for the venue
  const newRotationKeyPair = await atprotoCrypto.Secp256k1Keypair.create({ exportable: true });
  const newRotationPrivateKeyBytes = await newRotationKeyPair.export();

  // 4. Optionally generate new signing keypair
  let newSigningKeyDid: string | null = null;
  let signingKeyPrivate: Uint8Array | undefined;
  let signingKeyPublic: Uint8Array | undefined;
  let signingKeyDidKey: string | undefined;

  if (rotateSigningKey) {
    // Generate P-256 signing key (same as in create-identity)
    const keyObj = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = keyObj.privateKey.export({ format: 'jwk' });
    signingKeyPrivate = new Uint8Array(Buffer.from(jwk.d as string, 'base64url'));
    const derPub = keyObj.publicKey.export({ format: 'der', type: 'spki' });
    const rawPubUncompressed = Buffer.from(derPub).subarray(26);
    // Compress
    const x = rawPubUncompressed.subarray(1, 33);
    const y = rawPubUncompressed.subarray(33, 65);
    const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
    signingKeyPublic = new Uint8Array(Buffer.concat([Buffer.from([prefix]), x]));
    // Encode as did:key
    const P256_MULTICODEC_PREFIX = new Uint8Array([0x80, 0x24]);
    const multicodecBytes = new Uint8Array(P256_MULTICODEC_PREFIX.length + signingKeyPublic.length);
    multicodecBytes.set(P256_MULTICODEC_PREFIX);
    multicodecBytes.set(signingKeyPublic, P256_MULTICODEC_PREFIX.length);
    const { base58btc } = await import('multiformats/bases/base58');
    signingKeyDidKey = `did:key:${base58btc.encode(multicodecBytes)}`;
    newSigningKeyDid = signingKeyDidKey;
  }

  // 5. Build the update operation
  const unsignedUpdate = buildUpdateOperation(
    currentOp,
    prevCid,
    newRotationKeyPair.did(),
    newSigningKeyDid ?? undefined
  );

  // 6. Sign with the platform's current rotation key
  const signedUpdate = await signUpdateOperation(unsignedUpdate, platformRotationKeyPair);

  // 7. Publish to plc.directory
  await publishUpdate(venueDid, signedUpdate);

  // 8. Build the venue's new identity object
  const venueIdentity: Identity = {
    did: venueDid,
    role: 'venue',
    rotationKeyPair: {
      privateKey: new Uint8Array(newRotationPrivateKeyBytes),
      publicKey: new Uint8Array(
        atprotoCrypto.parseMultikey(
          atprotoCrypto.extractMultikey(newRotationKeyPair.did())
        ).keyBytes
      ),
      did: newRotationKeyPair.did(),
    },
    signingKeyPair: {
      privateKey: signingKeyPrivate ?? new Uint8Array(0),
      publicKey: signingKeyPublic ?? new Uint8Array(0),
      did: signingKeyDidKey ?? '',
    },
  };

  return {
    did: venueDid,
    previousRotationKeyDid,
    newRotationKeyDid: newRotationKeyPair.did(),
    newSigningKeyDid,
    updateOperation: signedUpdate,
    venueIdentity,
  };
}

export { computeOperationCID, fetchCurrentOperation };