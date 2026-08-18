import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity } from '../src/identity/create-identity.js';

const OUTPUT = path.resolve('output');

async function main() {
  console.log(chalk.bold('\n=== DIDcal Demo: Identity Creation ===\n'));

  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  // Create researcher
  console.log(chalk.blue('Creating researcher identity...'));
  const researcher = await createIdentity('researcher', 'demo-researcher', { dryRun: false });

  const researcherFile = {
    did: researcher.did,
    role: researcher.role,
    rotationKeyPair: {
      did: researcher.rotationKeyPair.did,
      publicKey: Buffer.from(researcher.rotationKeyPair.publicKey).toString('hex'),
      privateKey: Buffer.from(researcher.rotationKeyPair.privateKey).toString('hex'),
    },
    signingKeyPair: {
      did: researcher.signingKeyPair.did,
      publicKey: Buffer.from(researcher.signingKeyPair.publicKey).toString('hex'),
      privateKey: Buffer.from(researcher.signingKeyPair.privateKey).toString('hex'),
    },
    plcOperation: researcher.plcOperation,
    plcDirectoryUrl: `https://plc.directory/${researcher.did}`,
  };

  fs.writeFileSync(path.join(OUTPUT, 'researcher.json'), JSON.stringify(researcherFile, null, 2));
  console.log(chalk.green(`✓ Researcher DID: ${researcher.did}`));
  console.log(chalk.cyan(`  Live at: https://plc.directory/${researcher.did}`));
  console.log(chalk.gray(`  Saved to: output/researcher.json`));
  console.log();

  // Create venue
  console.log(chalk.blue('Creating venue identity...'));
  const venue = await createIdentity('venue', 'demo-venue', { dryRun: false });

  const venueFile = {
    did: venue.did,
    role: venue.role,
    rotationKeyPair: {
      did: venue.rotationKeyPair.did,
      publicKey: Buffer.from(venue.rotationKeyPair.publicKey).toString('hex'),
      privateKey: Buffer.from(venue.rotationKeyPair.privateKey).toString('hex'),
    },
    signingKeyPair: {
      did: venue.signingKeyPair.did,
      publicKey: Buffer.from(venue.signingKeyPair.publicKey).toString('hex'),
      privateKey: Buffer.from(venue.signingKeyPair.privateKey).toString('hex'),
    },
    plcOperation: venue.plcOperation,
    plcDirectoryUrl: `https://plc.directory/${venue.did}`,
  };

  fs.writeFileSync(path.join(OUTPUT, 'venue.json'), JSON.stringify(venueFile, null, 2));
  console.log(chalk.green(`✓ Venue DID: ${venue.did}`));
  console.log(chalk.cyan(`  Live at: https://plc.directory/${venue.did}`));
  console.log(chalk.gray(`  Saved to: output/venue.json`));

  console.log(chalk.bold('\n=== Open the URLs above in a browser to see the live DID documents ===\n'));
}

main().catch(console.error);