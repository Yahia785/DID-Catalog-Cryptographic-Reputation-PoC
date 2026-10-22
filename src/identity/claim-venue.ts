import * as atprotoCrypto from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import crypto from 'node:crypto';

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
}

/** Make sure a string is a well-formed did:key before it is embedded in a signed PLC operation. */
function assertValidDidKey(didKey: string, label: string): void {
  try {
    atprotoCrypto.parseMultikey(atprotoCrypto.extractMultikey(didKey));
  } catch (e) {
    throw new Error(`${label} is not a valid did:key: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Claim a venue DID by performing key rotation.
 *
 * This is the core trust-transfer operation in DIDcal. The venue generates
 * its OWN keypairs locally and never hands the private keys to the platform:
 * it sends only the public did:key values (newRotationKeyDid, and optionally
 * newSigningKeyDid). The platform then:
 * 1. Fetches the venue's current PLC operation from plc.directory
 * 2. Builds an update operation naming the venue's new rotation key (and,
 *    if given, its new signing key — otherwise the current signing key
 *    carries over unchanged)
 * 3. Signs the update with the platform's CURRENT rotation key, proving
 *    the platform authorized the handover
 * 4. Publishes the update to plc.directory
 *
 * After this operation:
 *   - The platform can NO LONGER modify the venue's DID
 *   - Only the venue's own rotation key can sign future updates
 *   - The audit log records both operations with timestamps
 *   - Anyone can verify the transfer by inspecting the log
 *
 * @param venueDid - The DID to claim
 * @param platformRotationPrivateKey - The platform's (or group's) current rotation private key (raw bytes)
 * @param options.newRotationKeyDid - The venue's new rotation public key, as a did:key (required)
 * @param options.newSigningKeyDid - The venue's new signing public key, as a did:key (optional; the current signing key is kept if omitted)
 * @param options.dryRun - Build but don't publish the update (not currently supported)
 */
export async function claimVenue(
  venueDid: string,
  platformRotationPrivateKey: Uint8Array,
  options: { newRotationKeyDid: string; newSigningKeyDid?: string; dryRun?: boolean }
): Promise<ClaimResult> {
  assertValidDidKey(options.newRotationKeyDid, 'newRotationKeyDid');
  if (options.newSigningKeyDid) assertValidDidKey(options.newSigningKeyDid, 'newSigningKeyDid');

  if (options.dryRun) {
    // In dry run, we can't fetch from plc.directory since the DID
    // may not be published. Use a placeholder.
    throw new Error('Dry run not supported for claimVenue — the DID must be published to plc.directory first');
  }

  // 1. Reconstruct the platform's rotation keypair from private key
  const platformRotationKeyPair = await atprotoCrypto.Secp256k1Keypair.import(
    platformRotationPrivateKey,
    { exportable: false }
  );
  const previousRotationKeyDid = platformRotationKeyPair.did();

  // 2. Fetch current operation from plc.directory
  const currentAuditEntry = await fetchCurrentOperation(venueDid);
  const currentOp = extractOperationFields(currentAuditEntry);

  // Use the CID that plc.directory computed for this operation.
  // plc.directory includes a 'cid' field in each audit log entry.
  // Using it directly avoids CID mismatches from field ordering
  // differences in our DAG-CBOR encoding vs. theirs.
  const prevCid = typeof currentAuditEntry.cid === 'string'
    ? currentAuditEntry.cid
    : computeOperationCID(currentOp); // fallback: compute it ourselves (may not match plc.directory)

  // 3. Build the update operation, naming the venue's own keys
  const unsignedUpdate = buildUpdateOperation(
    currentOp,
    prevCid,
    options.newRotationKeyDid,
    options.newSigningKeyDid
  );

  // 4. Sign with the platform's current rotation key
  const signedUpdate = await signUpdateOperation(unsignedUpdate, platformRotationKeyPair);

  // 5. Publish to plc.directory
  await publishUpdate(venueDid, signedUpdate);

  return {
    did: venueDid,
    previousRotationKeyDid,
    newRotationKeyDid: options.newRotationKeyDid,
    newSigningKeyDid: options.newSigningKeyDid ?? null,
    updateOperation: signedUpdate,
  };
}

export { computeOperationCID, fetchCurrentOperation };