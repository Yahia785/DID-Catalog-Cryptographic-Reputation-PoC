import chalk from 'chalk';
import fs from 'node:fs';
import { vcPathFor } from '../src/scoring/read-vc.js';
import { verifyScoreJwt, type Check, type VerifyReport } from '../src/verification/verify-score.js';
import { VENUES, findVenue } from '../src/venues/registry.js';

/**
 * npm run demo:verify -- SCN           verify one venue's signed score, step by step
 * npm run demo:verify -- --all         verify every venue (one line each)
 * npm run demo:verify -- --file=path   verify any score VC file (e.g. one someone sent you)
 * Add --offline to use the local platform key instead of resolving it on plc.directory.
 */

const icon: Record<Check['status'], string> = {
  pass: chalk.green('✓'), fail: chalk.red('✗'), warn: chalk.yellow('⚠'), skip: chalk.gray('–'),
};

export function printReport(r: VerifyReport, title?: string) {
  if (title) console.log(chalk.bold(`\n${title}`));
  console.log(chalk.gray(`${r.venueKey}  venue ${r.venueDID}  issuer ${r.issuer}`));
  for (const c of r.checks) console.log(`  ${icon[c.status]} ${c.name.padEnd(22)} ${chalk.gray(c.detail)}`);
  console.log(r.ok ? chalk.green.bold(`  → VALID: score ${r.score} is authentic and reproducible`) : chalk.red.bold('  → INVALID: do not trust this score'));
}

async function main() {
  const offline = process.argv.includes('--offline');
  const file = process.argv.find((a) => a.startsWith('--file='))?.split('=')[1];

  if (process.argv.includes('--all')) {
    console.log(chalk.bold('\nVerifying all signed scores\n'));
    let failed = 0;
    for (const v of VENUES) {
      if (!fs.existsSync(vcPathFor(v.slug))) continue;
      const r = await verifyScoreJwt(fs.readFileSync(vcPathFor(v.slug), 'utf8'), { offline });
      if (!r.ok) failed++;
      console.log(`  ${r.ok ? chalk.green('✓') : chalk.red('✗')} ${v.key.padEnd(9)} ${r.checks.map((c) => icon[c.status]).join(' ')}  ${chalk.gray(r.checks.filter((c) => c.status !== 'pass').map((c) => c.name).join(', '))}`);
    }
    console.log(chalk.gray('\n  checks: signature · identities · venue · recompute'));
    console.log(failed ? chalk.red(`\n${failed} credential(s) failed\n`) : chalk.green('\nAll credentials valid\n'));
    process.exit(failed ? 1 : 0);
  }

  let jwt: string;
  if (file) jwt = fs.readFileSync(file, 'utf8');
  else {
    const key = process.argv.slice(2).find((a) => !a.startsWith('--'));
    const venue = key ? findVenue(key) : undefined;
    if (!venue) throw new Error(`Give a venue (${VENUES.map((v) => v.key).join(', ')}), --all, or --file=path`);
    jwt = fs.readFileSync(vcPathFor(venue.slug), 'utf8');
  }
  const r = await verifyScoreJwt(jwt, { offline });
  printReport(r, 'Verifying score credential');
  console.log();
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1]?.includes('demo-verify')) {
  main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
}
