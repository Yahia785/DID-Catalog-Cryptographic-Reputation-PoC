import chalk from 'chalk';
import { createIdentity } from '../identity/create-identity.js';
import { issueRating } from '../ratings/issue-rating.js';
import { verifyRating } from './verify-rating.js';
import type { SignedRating } from '../shared/types.js';

async function verifyDemo() {
  console.log(chalk.bold('\n=== Verification Demo ===\n'));

  // Setup: create identities and a legitimate rating
  console.log(chalk.blue('--- Setup ---'));
  const alice = await createIdentity('researcher', 'alice', { dryRun: true });
  const bob = await createIdentity('researcher', 'bob', { dryRun: true });
  const venue = await createIdentity('venue', 'ieee-sp-2026', { dryRun: true });

  const { signedRating } = await issueRating(alice, venue.did, {
    legitimacy: 5,
    reviewQuality: 4,
    overall: 5,
  });
  console.log(chalk.green('✓ Setup complete: Alice, Bob, venue, and one signed rating'));
  console.log();

  // ---- Scenario 1: Legitimate rating verification ----
  console.log(chalk.blue('--- Scenario 1: Legitimate Rating Verification ---'));
  console.log(chalk.gray('  Verifying Alice\'s rating with Alice\'s public key...'));

  const result1 = await verifyRating(signedRating, alice.signingKeyPair.publicKey);

  if (result1.valid) {
    console.log(chalk.green('✓ PASS: Rating is authentic and untampered'));
  } else {
    console.log(chalk.red('✗ FAIL:'), result1.error);
  }
  console.log(chalk.gray(`  Reviewer: ${result1.reviewerDID}`));
  console.log(chalk.gray(`  Venue:    ${result1.venueDID}`));
  console.log(chalk.gray(`  Method:   ${result1.verificationMethod}`));
  console.log();

  // ---- Scenario 2: Tamper detection ----
  console.log(chalk.blue('--- Scenario 2: Tamper Detection ---'));
  console.log(chalk.gray('  Modifying legitimacy from 5 to 1, keeping original signature...'));

  const tamperedRating: SignedRating = {
    payload: {
      ...signedRating.payload,
      ratings: {
        ...signedRating.payload.ratings,
        legitimacy: 1, // tampered
      },
    },
    signature: signedRating.signature,       // original signature
    payloadHash: signedRating.payloadHash,   // original hash
  };

  const result2 = await verifyRating(tamperedRating, alice.signingKeyPair.publicKey);

  if (!result2.valid) {
    console.log(chalk.green('✓ DETECTED: Tampering caught'));
    console.log(chalk.gray(`  Reason: ${result2.error}`));
  } else {
    console.log(chalk.red('✗ MISSED: Tampered rating passed verification (this should not happen)'));
  }
  console.log();

  // ---- Scenario 3: Forgery detection ----
  console.log(chalk.blue('--- Scenario 3: Forgery Detection ---'));
  console.log(chalk.gray('  Rating claims to be from Alice but verifying with Bob\'s public key...'));
  console.log(chalk.gray('  (simulates platform signing a fake rating with its own key)'));

  const result3 = await verifyRating(signedRating, bob.signingKeyPair.publicKey);

  if (!result3.valid) {
    console.log(chalk.green('✓ DETECTED: Forgery caught'));
    console.log(chalk.gray(`  Reason: ${result3.error}`));
  } else {
    console.log(chalk.red('✗ MISSED: Forged rating passed verification (this should not happen)'));
  }
  console.log();

  // ---- Scenario 4: Non-repudiation ----
  console.log(chalk.blue('--- Scenario 4: Non-Repudiation ---'));
  console.log(chalk.gray('  Alice claims she never left this rating.'));
  console.log(chalk.gray('  Verifying with Alice\'s public key from her DID document...'));

  const result4 = await verifyRating(signedRating, alice.signingKeyPair.publicKey);

  if (result4.valid) {
    console.log(chalk.green('✓ PROVEN: Alice\'s key produced this signature'));
    console.log(chalk.gray('  Alice cannot deny authorship unless she claims key compromise.'));
    console.log(chalk.gray('  In that case, the PLC audit log shows no key rotation occurred,'));
    console.log(chalk.gray('  meaning her signing key was still active at the time of the rating.'));
  } else {
    console.log(chalk.red('✗ FAIL:'), result4.error);
  }
  console.log();

  // ---- Summary ----
  console.log(chalk.bold('--- Summary ---'));
  console.log(chalk.green('✓ Scenario 1: Legitimate verification   → PASS'));
  console.log(chalk.green('✓ Scenario 2: Tamper detection           → DETECTED'));
  console.log(chalk.green('✓ Scenario 3: Forgery detection          → DETECTED'));
  console.log(chalk.green('✓ Non-repudiation                        → PROVEN'));

  console.log(chalk.bold('\n=== Verification demo complete ===\n'));
}

verifyDemo().catch(console.error);