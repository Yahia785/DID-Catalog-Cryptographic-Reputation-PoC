import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { issueRating } from '../src/ratings/issue-rating.js';
import type { Identity } from '../src/shared/types.js';

const OUTPUT = path.resolve('output');

function loadIdentity(filename: string): Identity {
  const filepath = path.join(OUTPUT, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`${filename} not found. Run "npm run demo:identity" first.`);
  }
  const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  return {
    did: data.did,
    role: data.role,
    rotationKeyPair: {
      did: data.rotationKeyPair.did,
      publicKey: Uint8Array.from(Buffer.from(data.rotationKeyPair.publicKey, 'hex')),
      privateKey: Uint8Array.from(Buffer.from(data.rotationKeyPair.privateKey, 'hex')),
    },
    signingKeyPair: {
      did: data.signingKeyPair.did,
      publicKey: Uint8Array.from(Buffer.from(data.signingKeyPair.publicKey, 'hex')),
      privateKey: Uint8Array.from(Buffer.from(data.signingKeyPair.privateKey, 'hex')),
    },
  };
}

async function main() {
  console.log(chalk.bold('\n=== DIDcal Demo: Issue Rating ===\n'));

  const researcher = loadIdentity('researcher.json');
  const venue = loadIdentity('venue.json');

  console.log(chalk.gray(`Researcher: ${researcher.did}`));
  console.log(chalk.gray(`Venue:      ${venue.did}`));
  console.log();

  console.log(chalk.blue('Issuing signed rating...'));
  console.log(chalk.gray('  Scores: legitimacy=5, reviewQuality=4, overall=5'));

  const { vc, signedRating } = await issueRating(researcher, venue.did, {
    legitimacy: 5,
    reviewQuality: 4,
    overall: 5,
  });

  // Save rating file with everything the verifier needs
  const ratingFile = {
    signedRating,
    reviewerPublicKey: Buffer.from(researcher.signingKeyPair.publicKey).toString('hex'),
  };

  fs.writeFileSync(path.join(OUTPUT, 'rating.json'), JSON.stringify(ratingFile, null, 2));

  // Save VC separately
  fs.writeFileSync(path.join(OUTPUT, 'credential.json'), JSON.stringify(vc, null, 2));

  console.log(chalk.green(`✓ Rating signed`));
  console.log(chalk.gray(`  Payload hash: ${signedRating.payloadHash}`));
  console.log(chalk.gray(`  Signature:    ${signedRating.signature.slice(0, 40)}...`));
  console.log(chalk.gray(`  Saved to:     output/rating.json`));
  console.log(chalk.gray(`  VC saved to:  output/credential.json`));

  console.log(chalk.bold('\n=== To test tamper detection: open rating.json, change a rating value, save, then run demo:verify ===\n'));
}

main().catch(console.error);