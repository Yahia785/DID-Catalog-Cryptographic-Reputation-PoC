import path from 'node:path';
import type { VenueType } from '../shared/types.js';
import type { SerializedKeyPair } from '../identity/identity-store.js';
import { loadJson } from '../identity/identity-store.js';

/** One published venue DID, as saved by `npm run setup:venues` in output/venues.json. */
export interface VenueRecord {
  key: string;
  name: string;
  did: string;
  type: VenueType;
  handle: string;
  controlKeyDid: string;       // group key that controls this DID until it is claimed
  signingKeyPair: SerializedKeyPair;
  published: boolean;
  createdAt: string;
  plcDirectoryUrl: string;
  plcOperation?: object;
}

export const VENUES_FILE = path.resolve('output/venues.json');

export function loadVenueRecords(): Record<string, VenueRecord> {
  const records = loadJson<Record<string, VenueRecord>>(VENUES_FILE);
  if (!records) throw new Error('output/venues.json not found. Run: npm run setup:venues');
  return records;
}
