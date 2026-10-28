import chalk from 'chalk';
import { loadJson, PLATFORM_FILE } from './identity-store.js';
import { buildLocalAuditLogCache, saveAuditLogCache } from './plc-cache.js';
import type { Identity } from '../shared/types.js';
import { VENUES } from '../venues/registry.js';
import { loadVenueRecords } from '../venues/venue-records.js';

/**
 * npm run cache:plc             download the audit logs of the platform DID and the DID of every venue in the registry
 * npm run cache:plc -- --local  build them from the locally saved genesis operations instead
 *                               (for dry-run identities that were never published)
 */

async function main() {
  const local = process.argv.includes('--local');
  const platform = loadJson<Pick<Identity, 'did' | 'plcOperation'>>(PLATFORM_FILE);
  if (!platform) throw new Error('output/platform.json not found. Run: npm run setup:venues');
  // The target list is the registry (VENUES), so a venue without a DID record is reported, not silently skipped
  const records = loadVenueRecords();
  const targets = [
    { label: 'platform', did: platform.did, identity: platform as Pick<Identity, 'did' | 'plcOperation'> | undefined, createdAt: undefined as string | undefined },
    ...VENUES.map((v) => ({ label: v.key, did: records[v.key]?.did ?? '(no DID record)', identity: records[v.key] as Pick<Identity, 'did' | 'plcOperation'> | undefined, createdAt: records[v.key]?.createdAt })),
  ];
  let cached = 0;
  for (const t of targets) {
    try {
      if (!t.identity) throw new Error('no record in output/venues.json: run npm run setup:venues');
      const log = local ? buildLocalAuditLogCache(t.identity, t.createdAt) : await saveAuditLogCache(t.did);
      console.log(`  ${chalk.green('✓')} ${t.label.padEnd(9)} ${t.did}  ${log.length} operation(s)${local ? chalk.yellow(' (local)') : ''}`);
      cached++;
    } catch (e) {
      console.log(`  ${chalk.red('✗')} ${t.label.padEnd(9)} ${t.did}  ${chalk.red(e instanceof Error ? e.message : String(e))}`);
    }
  }
  console.log(chalk.gray('\nwritten to output/plc-cache/'));
  console.log((cached === targets.length ? chalk.green : chalk.red)(`cached ${cached} of ${targets.length}`));
  if (cached < targets.length) process.exit(1);
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
