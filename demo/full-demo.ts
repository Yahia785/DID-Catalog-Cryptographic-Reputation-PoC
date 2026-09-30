import chalk from 'chalk';
import { execSync } from 'node:child_process';
import readline from 'node:readline/promises';

/**
 * npm run demo               the whole story, pausing between steps (press Enter)
 * npm run demo -- --no-pause run straight through
 * Add --offline to skip resolving the platform DID on plc.directory.
 *
 * Assumes setup:venues, snapshot and score have already been run.
 */

const pause = !process.argv.includes('--no-pause');
const offline = process.argv.includes('--offline') ? ' --offline' : '';
const venue = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'SCN';

const steps: [string, string][] = [
  ['1. All venues: signed scores (every venue has its own DID)', 'npx tsx demo/demo-score.ts'],
  [`2. One venue in detail: where every number came from`, `npx tsx demo/demo-score.ts ${venue}`],
  ['3. Verify one credential like an outside party would', `npx tsx demo/demo-verify.ts ${venue}${offline}`],
  ['4. Verify every credential', `npx tsx demo/demo-verify.ts --all${offline}`],
  ['5. Attack scenarios and which check catches each', `npx tsx demo/demo-tamper.ts ${venue}${offline}`],
];

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (const [title, cmd] of steps) {
    console.log(chalk.bold.bgBlue(`\n ${title} `));
    try { execSync(cmd, { stdio: 'inherit' }); } catch { /* failing checks exit non-zero; keep going */ }
    if (pause) await rl.question(chalk.gray('\n[Enter] next step '));
  }
  rl.close();
}

main();
