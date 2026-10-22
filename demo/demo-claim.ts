import * as atprotoCrypto from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { claimVenue } from '../src/identity/claim-venue.js';
import { createIdentity, generateP256KeyPair } from '../src/identity/create-identity.js';
import { loadOrCreateControlKeys } from '../src/identity/key-store.js';
import { getAuditLog, resolveDID } from '../src/identity/resolve-did.js';

/**
 * npm run demo:claim
 *
 * This demo PUBLISHES to the live plc.directory and needs network access.
 * Each run creates one new throwaway test venue DID (never one of the 13
 * registry venues — claiming a DID is permanent and would lock the platform
 * out of real test data).
 */

const OUTPUT = path.resolve('output');

async function main() {
  console.log(chalk.bold('\n=== DIDcal Demo: Venue Claiming via Key Rotation ===\n'));

  if (!fs.existsSync(OUTPUT)) fs.mkdirSync(OUTPUT, { recursive: true });

  // ── Step 1: Platform creates a venue DID with the GROUP control key ──
  console.log(chalk.blue('Step 1: Platform creates a venue identity with the conference group key...'));
  const { keys } = await loadOrCreateControlKeys();
  const handle = `claim-test-${Date.now()}.conf.didcal.io`;
  const venue = await createIdentity('venue', `claim-test-${Date.now()}`, {
    dryRun: false,
    rotationPrivateKey: keys.conference.privateKey,
    handle,
  });
  console.log(chalk.green(`  ✓ Venue DID created: ${venue.did}`));
  console.log(chalk.gray(`    Handle: ${handle}`));
  console.log(chalk.gray(`    Rotation key (conference group key): ${venue.rotationKeyPair.did}`));
  console.log(chalk.gray(`    Signing key (throwaway, set by the platform at genesis): ${venue.signingKeyPair.did}`));
  console.log();

  // ── Step 2: Audit log before claiming ────────────────────────
  console.log(chalk.blue('Step 2: Audit log before claiming...'));
  const logBefore = await getAuditLog(venue.did);
  const opBefore = (logBefore[logBefore.length - 1] as Record<string, unknown>).operation as Record<string, unknown>;
  const rotationKeysBefore = opBefore.rotationKeys as string[];
  console.log(chalk.gray(`  ${logBefore.length} operation(s) in log (genesis only)`));
  console.log(chalk.gray(`    rotationKeys: ${JSON.stringify(rotationKeysBefore)}`));
  const groupKeyControlsIt = rotationKeysBefore.length === 1 && rotationKeysBefore[0] === keys.conference.did;
  console.log(groupKeyControlsIt
    ? chalk.green(`  ✓ matches the conference group key exactly`)
    : chalk.red(`  ✗ expected exactly [${keys.conference.did}]`));
  console.log();

  // ── Step 3: Venue side — generate its OWN keys locally ───────
  console.log(chalk.blue('Step 3 (venue side): the venue generates its own keypairs locally...'));
  const venueRotationKeyPair = await atprotoCrypto.Secp256k1Keypair.create({ exportable: true });
  const venueRotationPrivateKeyBytes = await venueRotationKeyPair.export();
  const venueRotationKeyDid = venueRotationKeyPair.did();
  const venueSigningKey = generateP256KeyPair();
  console.log(chalk.gray(`    New rotation key (secp256k1): ${venueRotationKeyDid}`));
  console.log(chalk.gray(`    New signing key (P-256):      ${venueSigningKey.did}`));
  console.log(chalk.yellow('  Only these two PUBLIC did:key values are sent to the platform.'));
  console.log(chalk.yellow('  The private keys never leave the venue.'));
  console.log();

  // ── Step 4: Platform side — sign the handover ────────────────
  console.log(chalk.blue('Step 4 (platform side): signing the handover with the current rotation key...'));
  const claimResult = await claimVenue(venue.did, keys.conference.privateKey, {
    newRotationKeyDid: venueRotationKeyDid,
    newSigningKeyDid: venueSigningKey.did,
  });
  console.log(chalk.green('  ✓ Update published to plc.directory'));
  console.log(chalk.gray(`    Previous rotation key: ${claimResult.previousRotationKeyDid}`));
  console.log(chalk.gray(`    New rotation key:      ${claimResult.newRotationKeyDid}`));
  console.log(chalk.gray(`    New signing key:       ${claimResult.newSigningKeyDid}`));
  console.log();

  // ── Step 5: Verify the handover took effect ──────────────────
  console.log(chalk.blue('Step 5: Verifying the handover...'));
  await new Promise((resolve) => setTimeout(resolve, 1000)); // let plc.directory propagate

  const logAfter = await getAuditLog(venue.did);
  const opAfter = (logAfter[logAfter.length - 1] as Record<string, unknown>).operation as Record<string, unknown>;
  const rotationKeysAfter = opAfter.rotationKeys as string[];
  console.log(chalk.gray(`  rotationKeys (from the audit log): ${JSON.stringify(rotationKeysAfter)}`));
  const rotationHandedOver = rotationKeysAfter.length === 1
    && rotationKeysAfter[0] === venueRotationKeyDid
    && !rotationKeysAfter.includes(keys.conference.did);
  console.log(rotationHandedOver
    ? chalk.green(`  ✓ rotation key is now the venue's own key, and no longer includes the group key`)
    : chalk.red(`  ✗ expected exactly [${venueRotationKeyDid}], without ${keys.conference.did}`));

  const docAfter = await resolveDID(venue.did);
  const signingMethod = docAfter.verificationMethod.find((vm) => vm.id.includes('#atproto'));
  console.log(chalk.gray(`  signing key (DID document's #atproto method): ${signingMethod?.publicKeyMultibase ?? '(not found)'}`));
  const expectedSigningMultikey = atprotoCrypto.extractMultikey(venueSigningKey.did);
  const signingHandedOver = signingMethod?.publicKeyMultibase === expectedSigningMultikey;
  console.log(signingHandedOver
    ? chalk.green('  ✓ signing key now matches the venue\'s new signing key')
    : chalk.red('  ✗ signing key does not match the venue\'s new signing key'));
  console.log();

  // ── Step 6 (bonus): can the old group key still push an update? ──
  console.log(chalk.blue('Step 6 (bonus): does the old group key still have any power?'));
  const { sig: _oldSig, ...unsignedClaimOp } = claimResult.updateOperation as Record<string, unknown> & { sig?: string };
  const groupKeyPair = await atprotoCrypto.Secp256k1Keypair.import(keys.conference.privateKey, { exportable: false });
  const forgedSig = await groupKeyPair.sign(dagCbor.encode(unsignedClaimOp));
  const forgedOp = { ...unsignedClaimOp, sig: Buffer.from(forgedSig).toString('base64url') };
  const forgeRes = await fetch(`https://plc.directory/${venue.did}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(forgedOp),
  });
  if (forgeRes.ok) {
    console.log(chalk.red('  ✗ FAILURE: plc.directory accepted an operation re-signed with the old group key'));
    console.log(chalk.red('    the platform did not fully lose control (or this ran inside plc.directory\'s recovery window)'));
  } else {
    console.log(chalk.green(`  ✓ plc.directory rejected it (${forgeRes.status}) — the platform has truly lost control`));
  }
  console.log();

  // ── Step 7: Save the venue's own keys (stands in for its own storage) ──
  const venueFile = {
    did: venue.did,
    role: 'venue',
    handle,
    claimed: true,
    claimedAt: new Date().toISOString(),
    previousRotationKeyDid: claimResult.previousRotationKeyDid,
    rotationKeyPair: {
      did: venueRotationKeyDid,
      privateKey: Buffer.from(venueRotationPrivateKeyBytes).toString('hex'),
    },
    signingKeyPair: {
      did: venueSigningKey.did,
      publicKey: Buffer.from(venueSigningKey.publicKey).toString('hex'),
      privateKey: Buffer.from(venueSigningKey.privateKey).toString('hex'),
    },
    plcDirectoryUrl: `https://plc.directory/${venue.did}`,
    auditLogUrl: `https://plc.directory/${venue.did}/log/audit`,
  };

  fs.writeFileSync(path.join(OUTPUT, 'venue-claimed.json'), JSON.stringify(venueFile, null, 2));
  console.log(chalk.gray(`Saved to: output/venue-claimed.json (stands in for the venue's own storage)`));

  // ── Summary ────────────────────────────────────────────────
  console.log(chalk.bold('\n=== Summary ===\n'));
  console.log(chalk.white('  What happened:'));
  console.log(chalk.gray('    1. The platform created a venue DID controlled by its conference GROUP key'));
  console.log(chalk.gray('    2. The venue generated its own rotation and signing keys locally and sent only the public did:key values'));
  console.log(chalk.gray('    3. The platform signed a PLC update naming those public keys, authorized by the group key'));
  console.log(chalk.gray('    4. plc.directory recorded both operations in the audit log'));
  console.log();
  console.log(chalk.white('  Trust properties:'));
  console.log(chalk.gray('    • The platform never saw the venue\'s private keys'));
  console.log(chalk.gray('    • The group key can no longer modify this one DID (it still controls every other unclaimed venue in its group)'));
  console.log(chalk.gray('    • Only the venue\'s own rotation key can sign future updates'));
  console.log(chalk.gray('    • Anyone can verify the transfer by inspecting the audit log'));
  console.log();
  console.log(chalk.cyan(`  Verify: ${venueFile.auditLogUrl}`));
  console.log();
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
