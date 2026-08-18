import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { verifyRating } from '../src/verification/verify-rating.js';
import type { SignedRating } from '../src/shared/types.js';

const OUTPUT = path.resolve('output');

async function main() {
  console.log(chalk.bold('\n=== DIDcal Demo: Verify Rating ===\n'));

  const filepath = path.join(OUTPUT, 'rating.json');
  if (!fs.existsSync(filepath)) {
    console.log(chalk.red('rating.json not found. Run "npm run demo:rating" first.'));
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  const signedRating: SignedRating = data.signedRating;
  const publicKey = Uint8Array.from(Buffer.from(data.reviewerPublicKey, 'hex'));

  console.log(chalk.gray('Rating payload:'));
  console.log(chalk.gray(`  Reviewer: ${signedRating.payload.reviewer}`));
  console.log(chalk.gray(`  Venue:    ${signedRating.payload.venue}`));
  console.log(chalk.gray(`  Ratings:  legitimacy=${signedRating.payload.ratings.legitimacy}, reviewQuality=${signedRating.payload.ratings.reviewQuality}, overall=${signedRating.payload.ratings.overall}`));
  console.log(chalk.gray(`  Hash:     ${signedRating.payloadHash}`));
  console.log(chalk.gray(`  Signature: ${signedRating.signature.slice(0, 40)}...`));
  console.log();

  console.log(chalk.blue('Verifying...'));
  const result = await verifyRating(signedRating, publicKey);

  if (result.valid) {
    console.log(chalk.green.bold('✓ VALID: Rating is authentic and untampered'));
    console.log(chalk.gray(`  The signature was produced by ${result.reviewerDID}`));
    console.log(chalk.gray(`  using verification method ${result.verificationMethod}`));
  } else {
    console.log(chalk.red.bold('✗ INVALID: Verification failed'));
    console.log(chalk.red(`  Reason: ${result.error}`));
  }

  console.log();
}

main().catch(console.error);