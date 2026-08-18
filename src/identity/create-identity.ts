import * as atprotoCrypto from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import { base32 } from 'multiformats/bases/base32';
import { base58btc } from 'multiformats/bases/base58';
import crypto from 'node:crypto';
import type { Identity } from '../shared/types.js';

// Multicodec prefix for P-256 public key (varint of 0x1200)
const P256_MULTICODEC_PREFIX = new Uint8Array([0x80, 0x24]);

/**
 * Compress a P-256 public key from uncompressed (65 bytes) to compressed (33 bytes).
 * Uncompressed format: 0x04 || x (32 bytes) || y (32 bytes)
 * Compressed format:   0x02/0x03 || x (32 bytes), prefix depends on y parity
 */
function compressP256PublicKey(uncompressedKey: Buffer): Buffer {
  if (uncompressedKey[0] !== 0x04 || uncompressedKey.length !== 65) {
    throw new Error('Expected uncompressed P-256 public key (65 bytes starting with 0x04)');
  }
  const x = uncompressedKey.subarray(1, 33);
  const y = uncompressedKey.subarray(33, 65);
  // If y is even, prefix is 0x02; if odd, prefix is 0x03
  const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]);
}

/**
 * Encode a compressed P-256 public key as a did:key string.
 * Format: did:key:z + base58btc(multicodec_prefix + compressed_pubkey)
 */
function p256PublicKeyToDidKey(compressedPubKey: Buffer): string {
  const multicodecBytes = new Uint8Array(P256_MULTICODEC_PREFIX.length + compressedPubKey.length);
  multicodecBytes.set(P256_MULTICODEC_PREFIX);
  multicodecBytes.set(compressedPubKey, P256_MULTICODEC_PREFIX.length);
  return `did:key:${base58btc.encode(multicodecBytes)}`;
}

/**
 * Generate a P-256 keypair using node:crypto.
 * Returns raw private key bytes, compressed public key bytes, and did:key string.
 */
function generateP256KeyPair(): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  did: string;
} {
  const keyObj = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  // Export as JWK to reliably get the raw 32-byte private key
  const jwk = keyObj.privateKey.export({ format: 'jwk' });
  const rawPriv = Buffer.from(jwk.d as string, 'base64url');

  // Export public key as DER to extract raw point, then compress
  const derPub = keyObj.publicKey.export({ format: 'der', type: 'spki' });
  const rawPubUncompressed = Buffer.from(derPub).subarray(26);
  const compressedPub = compressP256PublicKey(rawPubUncompressed);

  const did = p256PublicKeyToDidKey(compressedPub);

  return {
    privateKey: new Uint8Array(rawPriv),
    publicKey: new Uint8Array(compressedPub),
    did,
  };
}

/**
 * Build the PLC genesis operation object (without signature).
 * Follows PLC spec v0.3.0.
 */
function buildGenesisOperation(
  rotationKeyDid: string,
  signingKeyDid: string,
  role: 'researcher' | 'venue',
  label: string
): Record<string, unknown> {
  return {
    type: 'plc_operation',
    rotationKeys: [rotationKeyDid],
    verificationMethods: {
      atproto: rotationKeyDid,
      'signing-1': signingKeyDid,
    },
    alsoKnownAs: [`at://${label}.didcal.io`],
    services: {
      atproto_pds: {
        type: 'AtprotoPersonalDataServer',
        endpoint: 'https://api.didcal.io',
      },
      didcal: {
        type: 'DIDcalEntity',
        endpoint: `https://didcal.io/${role}s`,
      },
    },
    prev: null,
  };
}

/**
 * Sign the genesis operation and derive the DID.
 *
 * Process (per PLC spec):
 * 1. Encode unsigned operation to DAG-CBOR (canonical key ordering)
 * 2. Sign CBOR bytes with secp256k1 ECDSA-SHA256, low-S normalization
 * 3. base64url encode the signature, add as "sig" field
 * 4. Re-encode the now-signed operation to DAG-CBOR
 * 5. SHA-256 the signed CBOR bytes
 * 6. DID = did:plc:<base32lower(hash).slice(0,24)>
 */
async function signGenesisOperation(
  unsignedOp: Record<string, unknown>,
  rotationKeyPair: atprotoCrypto.Secp256k1Keypair
): Promise<{ signedOperation: Record<string, unknown>; did: string }> {
  // 1. Encode unsigned op to DAG-CBOR
  const unsignedCbor = dagCbor.encode(unsignedOp);

  // 2. Sign with secp256k1 (low-S normalization handled by @atproto/crypto)
  const signature = await rotationKeyPair.sign(unsignedCbor);

  // 3. base64url encode signature
  const sigBase64url = Buffer.from(signature).toString('base64url');

  // 4. Add sig to operation
  const signedOp = { ...unsignedOp, sig: sigBase64url };

  // 5. Re-encode signed operation and hash
  const signedCbor = dagCbor.encode(signedOp);
  const hash = crypto.createHash('sha256').update(signedCbor).digest();

// 6. Derive DID from hash
  const hashBase32 = base32.encode(hash);
  // base32.encode returns multibase-prefixed string ('b' prefix for base32lower)
  const hashStr = hashBase32.startsWith('b') ? hashBase32.slice(1) : hashBase32;
  const did = `did:plc:${hashStr.slice(0, 24)}`;
  return { signedOperation: signedOp, did };
}

/**
 * Publish a signed genesis operation to plc.directory.
 */
async function publishToDirectory(
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
    throw new Error(`plc.directory publish failed (${response.status}): ${body}`);
  }
}

/**
 * Create a DID:PLC identity for a researcher or venue.
 *
 * Generates both keypairs locally, builds and signs the PLC genesis operation,
 * optionally publishes to plc.directory, and returns the full identity object.
 */
export async function createIdentity(
  role: 'researcher' | 'venue',
  label: string,
  options: { dryRun?: boolean } = {}
): Promise<Identity> {
  // 1. Generate secp256k1 rotation keypair
  const rotationKeyPair = await atprotoCrypto.Secp256k1Keypair.create({ exportable: true });
  const rotationPrivateKeyBytes = await rotationKeyPair.export();

  // 2. Generate P-256 signing keypair
  const signingKey = generateP256KeyPair();

  // 3. Build unsigned genesis operation
  const unsignedOp = buildGenesisOperation(
    rotationKeyPair.did(),
    signingKey.did,
    role,
    label
  );

  // 4. Sign and derive DID
  const { signedOperation, did } = await signGenesisOperation(unsignedOp, rotationKeyPair);

  // 5. Publish (unless dry run)
  if (!options.dryRun) {
    await publishToDirectory(did, signedOperation);
  }

  return {
    did,
    role,
    rotationKeyPair: {
      privateKey: new Uint8Array(rotationPrivateKeyBytes),
      publicKey: new Uint8Array(atprotoCrypto.parseMultikey(atprotoCrypto.extractMultikey(rotationKeyPair.did())).keyBytes),
      did: rotationKeyPair.did(),
    },
    signingKeyPair: {
      privateKey: signingKey.privateKey,
      publicKey: signingKey.publicKey,
      did: signingKey.did,
    },
    plcOperation: signedOperation,
  };
}