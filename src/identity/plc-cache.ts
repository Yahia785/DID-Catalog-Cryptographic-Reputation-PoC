import fs from 'node:fs';
import path from 'node:path';
import type { Identity } from '../shared/types.js';
import { saveJson } from './identity-store.js';
import { getAuditLog, type AuditEntry, type DidResolver } from './resolve-did.js';

/**
 * Cache of public PLC audit logs, so credentials can be verified without network.
 * Audit logs are public data: unlike output/platform.json, nothing here is secret.
 */

export const PLC_CACHE_DIR = path.resolve('output/plc-cache');
// ':' is not allowed in Windows file names, so did:plc:abc is stored as did_plc_abc
export const cachePathFor = (did: string) => path.join(PLC_CACHE_DIR, `${did.replace(/:/g, '_')}.audit.json`);

/** Fetch the audit log from plc.directory and write it to the cache. */
export async function saveAuditLogCache(did: string): Promise<AuditEntry[]> {
  const log = await getAuditLog(did);
  saveJson(cachePathFor(did), log);
  return log;
}

/**
 * For identities that were never published (dry runs): build a one-entry audit log from the
 * saved genesis operation, marked { local: true }. `createdAt` is when the identity was created
 * if known; otherwise the epoch, i.e. "valid since the beginning".
 */
export function buildLocalAuditLogCache(identity: Pick<Identity, 'did' | 'plcOperation'>, createdAt?: string): AuditEntry[] {
  if (!identity.plcOperation) throw new Error(`${identity.did} has no saved genesis plcOperation`);
  const log: AuditEntry[] = [{
    did: identity.did,
    operation: identity.plcOperation as AuditEntry['operation'],
    cid: 'local',
    nullified: false,
    createdAt: createdAt ?? new Date(0).toISOString(),
    local: true,
  }];
  saveJson(cachePathFor(identity.did), log);
  return log;
}

/** Offline resolver: reads only the cache. A missing file is an error, never a fallback to anything else. */
export const cachedResolver: DidResolver = {
  via: 'cached audit log, offline',
  async auditLog(did) {
    const file = cachePathFor(did);
    if (!fs.existsSync(file)) throw new Error(`no cached audit log for ${did}; run npm run cache:plc`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AuditEntry[];
  },
};
