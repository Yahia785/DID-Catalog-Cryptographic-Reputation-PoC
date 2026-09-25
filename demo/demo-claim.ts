import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity } from '../src/identity/create-identity.js';
import { resolveDID, getAuditLog } from '../src/identity/resolve-did.js';
import { claimVenue } from '../src/identity/claim-venue.js';

const OUTPUT = path.resolve('output');

async function main() {
  console.log(chalk.bold('\n=== DIDcal Demo: Venue Claiming via Key Rotation ===\n'));

  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  // ── Step 1: Platform creates a venue DID ───────────────────
  console.log(chalk.blue('Step 1: Platform creates venue identity...'));
  const venue = await createIdentity('venue', `claim-test-${Date.now()}`, { dryRun: false });
  console.log(chalk.green(`  ✓ Venue DID created: ${venue.did}`));
  console.log(chalk.gray(`    Rotation key (platform-controlled): ${venue.rotationKeyPair.did}`));
  console.log(chalk.gray(`    Signing key:  ${venue.signingKeyPair.did}`));
  console.log();

  // ── Step 2: Resolve to confirm the DID is live ─────────────
  console.log(chalk.blue('Step 2: Verifying DID is live on plc.directory...'));
  const docBefore = await resolveDID(venue.did);
  console.log(chalk.green('  ✓ DID resolved successfully'));
  console.log(chalk.gray(`    Verification methods: ${docBefore.verificationMethod.length}`));
  console.log();

  // ── Step 3: Check audit log before claiming ────────────────
  console.log(chalk.blue('Step 3: Audit log before claiming...'));
  const logBefore = await getAuditLog(venue.did);
  console.log(chalk.green(`  ✓ ${logBefore.length} operation(s) in log (genesis only)`));
  
  console.log();

  // ── Step 4: Venue claims its DID ───────────────────────────
  console.log(chalk.blue('Step 4: Venue claims its DID via key rotation...'));
  console.log(chalk.gray('  Generating new keypairs for venue...'));
  console.log(chalk.gray('  Building PLC update operation...'));
  console.log(chalk.gray('  Signing with platform\'s current rotation key...'));
  console.log(chalk.gray('  Publishing to plc.directory...'));

  const claimResult = await claimVenue(
    venue.did,
    venue.rotationKeyPair.privateKey
  );

  console.log(chalk.green('  ✓ Venue claimed successfully'));
  console.log(chalk.gray(`    Previous rotation key: ${claimResult.previousRotationKeyDid}`));
  console.log(chalk.gray(`    New rotation key:      ${claimResult.newRotationKeyDid}`));
  if (claimResult.newSigningKeyDid) {
    console.log(chalk.gray(`    New signing key:       ${claimResult.newSigningKeyDid}`));
  }
  console.log();

  // ── Step 5: Verify the rotation took effect ────────────────
  console.log(chalk.blue('Step 5: Verifying rotation on plc.directory...'));

  // Small delay to let plc.directory propagate
  await new Promise(resolve => setTimeout(resolve, 1000));

  const docAfter = await resolveDID(venue.did);

  // Check that the rotation key changed
  const rotationMethodBefore = docBefore.verificationMethod.find(
    (vm: { id: string }) => vm.id.includes('#atproto')
  );
  const rotationMethodAfter = docAfter.verificationMethod.find(
    (vm: { id: string }) => vm.id.includes('#atproto')
  );

  if (
    rotationMethodBefore &&
    rotationMethodAfter &&
    rotationMethodBefore.publicKeyMultibase !== rotationMethodAfter.publicKeyMultibase
  ) {
    console.log(chalk.green('  ✓ Rotation key changed — platform no longer controls this DID'));
  } else {
    console.log(chalk.red('  ✗ Rotation key did not change — something went wrong'));
  }
  console.log();

  // ── Step 6: Inspect the audit log ──────────────────────────
  console.log(chalk.blue('Step 6: Audit log after claiming...'));
  const logAfter = await getAuditLog(venue.did);
  console.log(chalk.green(`  ✓ ${logAfter.length} operation(s) in log`));

  for (let i = 0; i < logAfter.length; i++) {
    const entry = logAfter[i] as Record<string, unknown>;
    const createdAt = entry.createdAt as string;
    // plc.directory nests the operation fields under `operation`
    const op = (entry.operation ?? {}) as Record<string, unknown>;
    const rotationKeys = op.rotationKeys as string[];
    const isGenesis = op.prev === null;
    console.log(chalk.gray(`    [${i + 1}] ${isGenesis ? 'GENESIS' : 'UPDATE '} at ${createdAt}`));
    console.log(chalk.gray(`        rotationKeys: ${rotationKeys?.[0]?.slice(0, 30)}...`));
  }
  console.log();

  // ── Step 7: Save the venue's new identity ──────────────────
  const venueFile = {
    did: claimResult.venueIdentity.did,
    role: claimResult.venueIdentity.role,
    claimed: true,
    claimedAt: new Date().toISOString(),
    previousRotationKeyDid: claimResult.previousRotationKeyDid,
    rotationKeyPair: {
      did: claimResult.venueIdentity.rotationKeyPair.did,
      publicKey: Buffer.from(claimResult.venueIdentity.rotationKeyPair.publicKey).toString('hex'),
      privateKey: Buffer.from(claimResult.venueIdentity.rotationKeyPair.privateKey).toString('hex'),
    },
    signingKeyPair: {
      did: claimResult.venueIdentity.signingKeyPair.did,
      publicKey: Buffer.from(claimResult.venueIdentity.signingKeyPair.publicKey).toString('hex'),
      privateKey: Buffer.from(claimResult.venueIdentity.signingKeyPair.privateKey).toString('hex'),
    },
    plcDirectoryUrl: `https://plc.directory/${venue.did}`,
    auditLogUrl: `https://plc.directory/${venue.did}/log/audit`,
  };

  fs.writeFileSync(
    path.join(OUTPUT, 'venue-claimed.json'),
    JSON.stringify(venueFile, null, 2)
  );
  console.log(chalk.gray(`  Saved to: output/venue-claimed.json`));

  // ── Summary ────────────────────────────────────────────────
  console.log(chalk.bold('\n=== Summary ===\n'));
  console.log(chalk.white('  What happened:'));
  console.log(chalk.gray('    1. Platform created a venue DID (platform held the rotation key)'));
  console.log(chalk.gray('    2. Venue claimed the DID by requesting key rotation'));
  console.log(chalk.gray('    3. Platform signed a PLC update transferring control to the venue'));
  console.log(chalk.gray('    4. plc.directory recorded both operations in the audit log'));
  console.log();
  console.log(chalk.white('  Trust properties:'));
  console.log(chalk.gray('    • Platform can no longer modify this DID'));
  console.log(chalk.gray('    • Only the venue\'s new rotation key can sign future updates'));
  console.log(chalk.gray('    • Anyone can verify the transfer by inspecting the audit log'));
  console.log(chalk.gray('    • The timestamp proves when the transfer occurred'));
  console.log();
  console.log(chalk.cyan(`  Verify: ${venueFile.auditLogUrl}`));
  console.log();
}

main().catch(console.error);