import * as atprotoCrypto from '@atproto/crypto';
import path from 'node:path';
import type { VenueType } from '../shared/types.js';
import { loadJson, saveJson } from './identity-store.js';

/**
 * Group control keys.
 *
 * Three levels of keys, each with a different job:
 *   - Platform rotation key: controls the platform's own DID only.
 *   - Group control keys (one for conferences, one for journals):
 *     control every unclaimed venue DID in that group. Held by the platform.
 *     A leaked conference key cannot touch journal DIDs, and vice versa.
 *   - Signing keys: unique per venue. Never shared.
 *
 * Sharing a control key does NOT share an identifier: every venue still gets
 * its own DID, because a DID is derived from the hash of that venue's own
 * genesis operation (its own signing key, handle, and services).
 *
 * When a venue claims its DID, its rotation key is replaced by the venue's
 * own key, and the group key loses control of that one DID.
 */

export const CONTROL_KEYS_FILE = path.resolve('output/keys/control-keys.json');

interface StoredKey { did: string; privateKey: string }
type ControlKeys = Record<VenueType, StoredKey>;

async function newKey(): Promise<StoredKey> {
  const kp = await atprotoCrypto.Secp256k1Keypair.create({ exportable: true });
  return { did: kp.did(), privateKey: Buffer.from(await kp.export()).toString('hex') };
}

/** Load the conference and journal control keys, creating them on first use. */
export async function loadOrCreateControlKeys(): Promise<{
  keys: Record<VenueType, { did: string; privateKey: Uint8Array }>;
  created: boolean;
}> {
  let stored = loadJson<ControlKeys>(CONTROL_KEYS_FILE);
  let created = false;
  if (!stored) {
    stored = { conference: await newKey(), journal: await newKey() };
    saveJson(CONTROL_KEYS_FILE, stored);
    created = true;
  }
  const toBytes = (k: StoredKey) => ({ did: k.did, privateKey: new Uint8Array(Buffer.from(k.privateKey, 'hex')) });
  return { keys: { conference: toBytes(stored.conference), journal: toBytes(stored.journal) }, created };
}
