import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity } from '../src/identity/create-identity.js';
import { serializeIdentity } from '../src/identity/identity-store.js';

const OUTPUT = path.resolve('output');

async function main() {
  console.log(chalk.bold('\n=== DIDcal Demo: Identity Creation ===\n'));

  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  // ── 1. Create platform identity ────────────────────────────
  // The platform is the entity that computes and signs venue scores.
  // It needs a DID so verifiers can look up its public key.
  console.log(chalk.blue('Creating platform identity...'));
  const platform = await createIdentity('platform', 'didcal-platform', { dryRun: false });

  fs.writeFileSync(
    path.join(OUTPUT, 'platform.json'),
    JSON.stringify(serializeIdentity(platform), null, 2)
  );
  console.log(chalk.green(`✓ Platform DID: ${platform.did}`));
  console.log(chalk.cyan(`  Live at: https://plc.directory/${platform.did}`));
  console.log(chalk.gray(`  Saved to: output/platform.json`));
  console.log();

  // ── 2. Create venue identity ───────────────────────────────
  // The platform creates venue DIDs on behalf of venues.
  // Venues can later claim their DID via key rotation (see demo:claim).
  console.log(chalk.blue('Creating venue identity...'));
  const venue = await createIdentity('venue', 'demo-venue', { dryRun: false });

  fs.writeFileSync(
    path.join(OUTPUT, 'venue.json'),
    JSON.stringify(serializeIdentity(venue), null, 2)
  );
  console.log(chalk.green(`✓ Venue DID: ${venue.did}`));
  console.log(chalk.cyan(`  Live at: https://plc.directory/${venue.did}`));
  console.log(chalk.gray(`  Saved to: output/venue.json`));

  console.log(chalk.bold('\n=== Open the URLs above in a browser to see the live DID documents ===\n'));
  console.log(chalk.gray('Next steps:'));
  console.log(chalk.gray('  npm run demo:score   — compute and sign a venue score'));
  console.log(chalk.gray('  npm run demo:verify  — verify the signed score'));
  console.log(chalk.gray('  npm run demo:claim   — venue claims its DID via key rotation'));
}

main().catch(console.error);