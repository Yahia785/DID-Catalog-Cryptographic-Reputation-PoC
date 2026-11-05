import chalk from 'chalk';
import { loadPlatform } from '../identity/identity-store.js';
import { FORMULAS } from './compute-score.js';
import { FORMULA_SOURCES, RELEASES_FILE, chainProblems, hashFormulaCode, loadReleases, recordHash, saveReleases, signRelease, type ReleaseList, type ReleaseRecord } from './formula-releases.js';

/**
 * npx tsx src/scoring/release-formulas.ts
 *
 * Add a signed release record for every formula version that has none yet (in the order of
 * FORMULA_SOURCES), chained to the previous record, into releases/formula-releases.json.
 * A released formula is never changed: if a formula's code no longer hashes to its record, this
 * stops with an error (make a new formula version instead). The new head still has to be anchored
 * in the platform DID: npx tsx src/identity/anchor-formulas.ts --live
 */

async function main() {
  const platform = loadPlatform();
  const list: ReleaseList = loadReleases() ?? { platform: platform.did, records: [] };
  if (list.platform !== platform.did) throw new Error(`${RELEASES_FILE} belongs to ${list.platform}, not to ${platform.did}`);
  const broken = chainProblems(list.records.map((r) => r.record));
  if (broken.length) throw new Error(`the existing release chain is broken: ${broken.join('; ')}`);

  let added = 0;
  const edited: string[] = [];
  for (const version of Object.keys(FORMULA_SOURCES)) {
    const codeHash = hashFormulaCode(version);
    const existing = list.records.find((r) => r.record.formulaVersion === version);
    if (existing) {
      if (existing.record.codeHash === codeHash) console.log(chalk.gray(`  ${version.padEnd(9)} already released (code ${codeHash.slice(0, 12)}…)`));
      else { edited.push(version); console.log(chalk.red(`  ${version.padEnd(9)} CODE CHANGED since its release: ${codeHash.slice(0, 12)}… vs ${existing.record.codeHash.slice(0, 12)}…`)); }
      continue;
    }
    if (!FORMULAS[version]) throw new Error(`formula ${version} has a source file but is not in FORMULAS`);
    const last = list.records[list.records.length - 1];
    const record: ReleaseRecord = {
      formulaVersion: version, codeHash, description: FORMULAS[version].description,
      releasedAt: new Date().toISOString(), prevHash: last ? recordHash(last.record) : null,
    };
    list.records.push({ record, jws: await signRelease(record, platform) });
    added++;
    console.log(chalk.green(`  ${version.padEnd(9)} released: code ${codeHash.slice(0, 12)}…, prevHash ${record.prevHash ? record.prevHash.slice(0, 12) + '…' : 'null'}`));
  }
  if (edited.length) { console.error(chalk.red(`\nReleased formula code was edited (${edited.join(', ')}). Nothing written. A released formula must not change: add a new version.\n`)); process.exit(1); }
  if (added) saveReleases(list);
  const head = recordHash(list.records[list.records.length - 1].record);
  console.log(`\n${added} record(s) added; ${list.records.length} in ${RELEASES_FILE}. Chain head ${chalk.bold(head)}`);
  console.log(chalk.gray('Anchor it in the platform DID: npx tsx src/identity/anchor-formulas.ts --live\n'));
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
