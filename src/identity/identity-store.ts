import fs from 'node:fs';
import path from 'node:path';
import type { Identity, KeyPair } from '../shared/types.js';

/**
 * Save and load identities as JSON (keys hex-encoded).
 * These files contain PRIVATE KEYS: they live in output/, which is git-ignored.
 */

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

export interface SerializedKeyPair { did: string; publicKey: string; privateKey: string }

export function serializeKeyPair(k: KeyPair): SerializedKeyPair {
  return { did: k.did, publicKey: hex(k.publicKey), privateKey: hex(k.privateKey) };
}

export function deserializeKeyPair(k: SerializedKeyPair): KeyPair {
  return { did: k.did, publicKey: unhex(k.publicKey), privateKey: unhex(k.privateKey) };
}

export function serializeIdentity(identity: Identity) {
  return {
    did: identity.did,
    role: identity.role,
    rotationKeyPair: serializeKeyPair(identity.rotationKeyPair),
    signingKeyPair: serializeKeyPair(identity.signingKeyPair),
    plcOperation: identity.plcOperation,
    plcDirectoryUrl: `https://plc.directory/${identity.did}`,
  };
}

export function deserializeIdentity(json: ReturnType<typeof serializeIdentity>): Identity {
  return {
    did: json.did,
    role: json.role,
    rotationKeyPair: deserializeKeyPair(json.rotationKeyPair),
    signingKeyPair: deserializeKeyPair(json.signingKeyPair),
    plcOperation: json.plcOperation,
  };
}

export function saveJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function loadJson<T>(file: string): T | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null;
}

export const PLATFORM_FILE = path.resolve('output/platform.json');

export function loadPlatform(): Identity {
  const json = loadJson<ReturnType<typeof serializeIdentity>>(PLATFORM_FILE);
  if (!json) throw new Error('output/platform.json not found. Run: npm run setup:venues');
  return deserializeIdentity(json);
}
