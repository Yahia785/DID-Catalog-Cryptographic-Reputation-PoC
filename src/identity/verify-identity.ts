import chalk from 'chalk';
import { createIdentity } from './create-identity.js';
import { resolveDID, getAuditLog } from './resolve-did.js';

const dryRun = process.argv.includes('--dry-run');

async function verifyIdentityPhase() {
  console.log(chalk.bold('\n=== Phase 2: Identity Creation Verification ===\n'));
  console.log(chalk.gray(`Mode: ${dryRun ? 'DRY RUN (no plc.directory publishing)' : 'LIVE (publishing to plc.directory)'}\n`));

  // 1. Create researcher identity
  console.log(chalk.blue('--- Creating Researcher Identity ---'));
  const researcher = await createIdentity('researcher', 'alice-test', { dryRun });
  console.log(chalk.green('✓ Researcher DID created:'), researcher.did);
  console.log(chalk.gray('  Rotation key (did:key):'), researcher.rotationKeyPair.did);
  console.log(chalk.gray('  Signing key (did:key):'), researcher.signingKeyPair.did);
  console.log(chalk.gray('  Rotation private key (hex):'), Buffer.from(researcher.rotationKeyPair.privateKey).toString('hex').slice(0, 16) + '...');
  console.log(chalk.gray('  Signing private key (hex):'), Buffer.from(researcher.signingKeyPair.privateKey).toString('hex').slice(0, 16) + '...');
  console.log();

  // 2. Create venue identity
  console.log(chalk.blue('--- Creating Venue Identity ---'));
  const venue = await createIdentity('venue', 'ieee-sp-2026', { dryRun });
  console.log(chalk.green('✓ Venue DID created:'), venue.did);
  console.log(chalk.gray('  Rotation key (did:key):'), venue.rotationKeyPair.did);
  console.log(chalk.gray('  Signing key (did:key):'), venue.signingKeyPair.did);
  console.log();

  // 3. Print PLC operations
  console.log(chalk.blue('--- Genesis Operations ---'));
  console.log(chalk.gray('Researcher PLC operation:'));
  console.log(JSON.stringify(researcher.plcOperation, null, 2));
  console.log();
  console.log(chalk.gray('Venue PLC operation:'));
  console.log(JSON.stringify(venue.plcOperation, null, 2));
  console.log();

  // 4. Resolve from plc.directory (live mode only)
  if (!dryRun) {
    console.log(chalk.blue('--- Resolving DIDs from plc.directory ---'));

    try {
      const researcherDoc = await resolveDID(researcher.did);
      console.log(chalk.green('✓ Researcher DID resolved:'));
      console.log(JSON.stringify(researcherDoc, null, 2));
      console.log();
    } catch (e) {
      console.log(chalk.red('✗ Researcher DID resolution failed:'), e);
    }

    try {
      const venueDoc = await resolveDID(venue.did);
      console.log(chalk.green('✓ Venue DID resolved:'));
      console.log(JSON.stringify(venueDoc, null, 2));
      console.log();
    } catch (e) {
      console.log(chalk.red('✗ Venue DID resolution failed:'), e);
    }

    // 5. Fetch audit logs
    console.log(chalk.blue('--- Audit Logs ---'));
    try {
      const log = await getAuditLog(researcher.did);
      console.log(chalk.green('✓ Researcher audit log:'), `${log.length} operation(s)`);
    } catch (e) {
      console.log(chalk.red('✗ Audit log fetch failed:'), e);
    }
  } else {
    console.log(chalk.yellow('⚠ Skipping plc.directory resolution (dry run mode)'));
    console.log(chalk.yellow('  Run without --dry-run to publish and resolve live DIDs'));
  }

  console.log(chalk.bold('\n=== Phase 2 verification complete ===\n'));
}

verifyIdentityPhase().catch(console.error);