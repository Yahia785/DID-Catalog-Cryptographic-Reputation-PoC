import chalk from 'chalk';
import path from 'node:path';
import { createIdentity } from '../src/identity/create-identity.js';
import { loadOrCreateControlKeys, CONTROL_KEYS_FILE } from '../src/identity/key-store.js';
import {
  PLATFORM_FILE, loadJson, saveJson, serializeIdentity, serializeKeyPair, type SerializedKeyPair,
} from '../src/identity/identity-store.js';
import { VENUES, handleOf, groupOf } from '../src/venues/registry.js';
import type { VenueType } from '../src/shared/types.js';

/**
 * Set up all identities for the scoring demo:
 *   1. Platform DID   — its own rotation key and its own signing key
 *   2. Control keys   — one for conferences, one for journals (platform-held)
 *   3. Venue DIDs     — one unique DID per venue, controlled by its group key
 *
 * Safe to run again: anything that already exists is reused, not recreated.
 * Use --dry-run to build everything locally without publishing to plc.directory.
 */

export const VENUES_FILE = path.resolve('output/venues.json');

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

const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(chalk.bold('\n=== DIDcal: identity setup ===\n'));
  console.log(chalk.gray(`Mode: ${dryRun ? 'DRY RUN (nothing published)' : 'LIVE (publishing to plc.directory)'}\n`));

  // ── 1. Platform ─────────────────────────────────────────────
  type PlatformFile = ReturnType<typeof serializeIdentity> & { published?: boolean };
  let platform = loadJson<PlatformFile>(PLATFORM_FILE);
  // A platform DID made in a dry run was never published: replace it when running live
  if (platform && platform.published === false && !dryRun) platform = null;
  if (platform) {
    console.log(chalk.green('✓ Platform DID (existing):'), platform.did);
  } else {
    const created = await createIdentity('platform', 'didcal-platform', { dryRun });
    platform = { ...serializeIdentity(created), published: !dryRun };
    saveJson(PLATFORM_FILE, platform);
    console.log(chalk.green('✓ Platform DID (created):'), platform.did);
  }
  console.log(chalk.gray(`  rotation key: ${platform.rotationKeyPair.did.slice(0, 40)}…  (platform only)`));

  // ── 2. Group control keys ───────────────────────────────────
  const { keys, created } = await loadOrCreateControlKeys();
  console.log(chalk.green(`\n✓ Group control keys (${created ? 'created' : 'existing'})`), chalk.gray(`→ ${path.relative('.', CONTROL_KEYS_FILE)}`));
  console.log(chalk.gray(`  conferences: ${keys.conference.did.slice(0, 40)}…`));
  console.log(chalk.gray(`  journals:    ${keys.journal.did.slice(0, 40)}…`));

  // ── 3. Venue DIDs ───────────────────────────────────────────
  const records = loadJson<Record<string, VenueRecord>>(VENUES_FILE) ?? {};
  console.log(chalk.bold('\nVenue DIDs'));
  for (const v of VENUES) {
    const existing = records[v.key];
    // Reuse a published DID; replace a dry-run DID when running live
    if (existing && (existing.published || dryRun)) {
      console.log(`  ${chalk.gray('existing')}  ${v.key.padEnd(9)} ${existing.did}  ${chalk.gray(existing.handle)}`);
      continue;
    }
    const identity = await createIdentity('venue', v.slug, {
      dryRun,
      rotationPrivateKey: keys[v.type].privateKey,
      handle: handleOf(v),
      service: { type: 'DIDcalVenue', endpoint: `https://didcal.io/${v.type}s` },
    });
    records[v.key] = {
      key: v.key,
      name: v.name,
      did: identity.did,
      type: v.type,
      handle: handleOf(v),
      controlKeyDid: keys[v.type].did,
      signingKeyPair: serializeKeyPair(identity.signingKeyPair),
      published: !dryRun,
      createdAt: new Date().toISOString(),
      plcDirectoryUrl: `https://plc.directory/${identity.did}`,
      plcOperation: identity.plcOperation,
    };
    saveJson(VENUES_FILE, records); // save after each one, so a failure midway loses nothing
    console.log(`  ${chalk.green('created ')}  ${v.key.padEnd(9)} ${identity.did}  ${chalk.gray(handleOf(v))}`);
  }

  // ── Summary ─────────────────────────────────────────────────
  const count = (t: VenueType) => Object.values(records).filter((r) => r.type === t).length;
  console.log(chalk.bold('\nSummary'));
  console.log(`  ${count('conference')} conference DIDs, controlled by the conference key (*.${groupOf('conference')}.didcal.io)`);
  console.log(`  ${count('journal')} journal DIDs, controlled by the journal key (*.${groupOf('journal')}.didcal.io)`);
  console.log(`  Every venue has its own DID and its own signing key.`);
  console.log(chalk.gray(`  Saved to ${path.relative('.', VENUES_FILE)}\n`));
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
