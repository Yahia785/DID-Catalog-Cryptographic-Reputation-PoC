import chalk from 'chalk';
import path from 'node:path';
import { loadPlatform, saveJson } from '../identity/identity-store.js';
import { VENUES, findVenue } from '../venues/registry.js';
import { loadVenueRecords } from '../venues/venue-records.js';
import { buildScore } from './build-score.js';
import { FORMULA_VERSION } from './compute-score.js';
import { issueScore } from './issue-score.js';
import { SNAPSHOTS_ROOT, latestSnapshotDir, loadSnapshot } from './snapshot-store.js';
import fs from 'node:fs';

/**
 * npm run score
 *
 * For every venue: read the snapshot → compute the score → sign it as a VC
 * with the platform key → save to output/scores/.
 *
 * Options:
 *   --snapshot=YYYY-MM-DD   use a specific snapshot (default: latest)
 *   --venue=SCN             score one venue only
 *
 * Output per venue (slug = file-safe name, e.g. 'scn'):
 *   output/scores/<slug>.vc.jwt           the signed credential (this is what gets shared)
 *   output/scores/<slug>.manifest.json    the provenance manifest, readable
 *   output/scores/<slug>.score.json       the score payload, readable
 *   output/scores/index.json              summary of the whole run
 */

export const SCORES_DIR = path.resolve('output/scores');
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  const snapshotDir = arg('snapshot') ? path.join(SNAPSHOTS_ROOT, arg('snapshot')!) : latestSnapshotDir();
  const snapshot = loadSnapshot(snapshotDir);
  const platform = loadPlatform();
  const records = loadVenueRecords();
  const only = arg('venue') ? findVenue(arg('venue')!) : undefined;
  if (arg('venue') && !only) throw new Error(`Unknown venue: ${arg('venue')}`);

  console.log(chalk.bold(`\n=== DIDcal: compute and sign scores ===`));
  console.log(chalk.gray(`snapshot ${snapshot.dir}   formula ${FORMULA_VERSION}   issuer ${platform.did}\n`));

  fs.mkdirSync(SCORES_DIR, { recursive: true });
  const computedAt = new Date().toISOString();
  const summary: unknown[] = [];

  for (const venue of only ? [only] : VENUES) {
    const record = records[venue.key];
    if (!record) { console.log(chalk.yellow(`  ! ${venue.key}: no DID in output/venues.json, skipped`)); continue; }

    const score = buildScore({ venue, venueDID: record.did, platformDID: platform.did, snapshot, computedAt });
    const vc = await issueScore(platform, score);

    const base = path.join(SCORES_DIR, venue.slug);
    fs.writeFileSync(`${base}.vc.jwt`, vc.jwt);
    saveJson(`${base}.manifest.json`, vc.manifest);
    saveJson(`${base}.score.json`, vc.payload);
    summary.push({ key: venue.key, slug: venue.slug, type: venue.type, did: record.did, score: vc.payload.score, confidence: vc.payload.confidence, flags: vc.payload.flags });

    const s = vc.payload.score === null ? '  —  ' : vc.payload.score.toFixed(1).padStart(5);
    const conf = `${vc.payload.confidence.present}/${vc.payload.confidence.total}`;
    console.log(`  ${chalk.green('✓')} ${venue.key.padEnd(9)} ${s}  ${conf}  ${chalk.gray(vc.payload.flags.join(' · '))}`);
  }

  saveJson(path.join(SCORES_DIR, 'index.json'), { computedAt, snapshot: snapshot.dir, formulaVersion: FORMULA_VERSION, issuer: platform.did, venues: summary });
  console.log(chalk.gray(`\nSigned credentials saved to ${path.relative('.', SCORES_DIR)}${path.sep}. Next: npm run demo:score\n`));
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
