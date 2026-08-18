import chalk from 'chalk';
import { decodeJWT } from 'did-jwt';
import { createIdentity } from '../identity/create-identity.js';
import { issueRating } from './issue-rating.js';
import fs from 'node:fs';
import path from 'node:path';

async function verifyRatingsPhase() {
  console.log(chalk.bold('\n=== Phase 3: Signed Rating Issuance Verification ===\n'));

  // 1. Create identities (dry run, no plc.directory)
  console.log(chalk.blue('--- Setting up identities ---'));
  const reviewer1 = await createIdentity('researcher', 'alice', { dryRun: true });
  const reviewer2 = await createIdentity('researcher', 'bob', { dryRun: true });
  const reviewer3 = await createIdentity('researcher', 'carol', { dryRun: true });
  const venue = await createIdentity('venue', 'ieee-sp-2026', { dryRun: true });
  console.log(chalk.green('✓ Created 3 reviewer DIDs and 1 venue DID'));
  console.log(chalk.gray(`  Reviewer 1 (Alice): ${reviewer1.did}`));
  console.log(chalk.gray(`  Reviewer 2 (Bob):   ${reviewer2.did}`));
  console.log(chalk.gray(`  Reviewer 3 (Carol): ${reviewer3.did}`));
  console.log(chalk.gray(`  Venue:              ${venue.did}`));
  console.log();

  // 2. Issue ratings from each reviewer
  console.log(chalk.blue('--- Issuing Signed Ratings ---'));

  const rating1 = await issueRating(reviewer1, venue.did, {
    legitimacy: 5,
    reviewQuality: 4,
    overall: 5,
  });
  console.log(chalk.green('✓ Rating 1 (Alice):'), 'legitimacy=5, reviewQuality=4, overall=5');
  console.log(chalk.gray(`  Payload hash: ${rating1.signedRating.payloadHash}`));
  console.log(chalk.gray(`  Raw signature: ${rating1.signedRating.signature.slice(0, 32)}...`));
  console.log();

  const rating2 = await issueRating(reviewer2, venue.did, {
    legitimacy: 4,
    reviewQuality: 3,
    overall: 4,
  });
  console.log(chalk.green('✓ Rating 2 (Bob):'), 'legitimacy=4, reviewQuality=3, overall=4');
  console.log(chalk.gray(`  Payload hash: ${rating2.signedRating.payloadHash}`));
  console.log(chalk.gray(`  Raw signature: ${rating2.signedRating.signature.slice(0, 32)}...`));
  console.log();

  const rating3 = await issueRating(reviewer3, venue.did, {
    legitimacy: 3,
    reviewQuality: 4,
    overall: 3,
  });
  console.log(chalk.green('✓ Rating 3 (Carol):'), 'legitimacy=3, reviewQuality=4, overall=3');
  console.log(chalk.gray(`  Payload hash: ${rating3.signedRating.payloadHash}`));
  console.log(chalk.gray(`  Raw signature: ${rating3.signedRating.signature.slice(0, 32)}...`));
  console.log();

  // 3. Decode and inspect a JWT
  console.log(chalk.blue('--- Decoded JWT (Rating 1) ---'));
  const decoded = decodeJWT(rating1.vc.jwt);
  console.log(chalk.gray('Header:'));
  console.log(JSON.stringify(decoded.header, null, 2));
  console.log(chalk.gray('Payload:'));
  console.log(JSON.stringify(decoded.payload, null, 2));
  console.log(chalk.gray('Signature:'), decoded.signature.slice(0, 32) + '...');
  console.log();

  // 4. Show the full VC structure
  console.log(chalk.blue('--- Full Verifiable Credential (Rating 1) ---'));
  console.log(chalk.gray('JWT:'), rating1.vc.jwt.slice(0, 50) + '...');
  console.log(chalk.gray('Decoded VC:'));
  console.log(JSON.stringify(rating1.vc.decoded, null, 2));
  console.log();

  // 5. Save artifacts to output/
  const outputDir = path.resolve('output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const artifacts = {
    venue: { did: venue.did },
    ratings: [
      { reviewer: 'Alice', did: reviewer1.did, vc: rating1.vc, signedRating: rating1.signedRating },
      { reviewer: 'Bob', did: reviewer2.did, vc: rating2.vc, signedRating: rating2.signedRating },
      { reviewer: 'Carol', did: reviewer3.did, vc: rating3.vc, signedRating: rating3.signedRating },
    ],
  };

  fs.writeFileSync(
    path.join(outputDir, 'phase3-ratings.json'),
    JSON.stringify(artifacts, null, 2)
  );
  console.log(chalk.green('✓ Artifacts saved to output/phase3-ratings.json'));

  console.log(chalk.bold('\n=== Phase 3 verification complete ===\n'));
}

verifyRatingsPhase().catch(console.error);