import * as atprotoCrypto from '@atproto/crypto';
import * as dagCbor from '@ipld/dag-cbor';
import { base58btc } from 'multiformats/bases/base58';
import { base32 } from 'multiformats/bases/base32';
import chalk from 'chalk';
import crypto from 'node:crypto';
import type { Identity, RatingPayload, ReputationScore } from './types.js';

async function verifySetup() {
  console.log(chalk.bold('\n=== DIDcal PoC Setup Verification ===\n'));

  // 1. @atproto/crypto
  try {
    const keypair = await atprotoCrypto.Secp256k1Keypair.create({ exportable: true });
    const did = keypair.did();
    console.log(chalk.green('✓ @atproto/crypto'), `- secp256k1 keypair created, DID: ${did.slice(0, 30)}...`);
  } catch (e) {
    console.log(chalk.red('✗ @atproto/crypto'), `- ${e}`);
  }

  // 2. P-256 via node:crypto
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const sign = crypto.createSign('SHA256');
    sign.update('test message');
    const signature = sign.sign({ key: Buffer.from(privateKey), format: 'der', type: 'pkcs8' });
    const verify = crypto.createVerify('SHA256');
    verify.update('test message');
    const valid = verify.verify(
      { key: Buffer.from(publicKey), format: 'der', type: 'spki' },
      signature
    );
    console.log(chalk.green('✓ P-256 (node:crypto)'), `- sign/verify: ${valid}`);
  } catch (e) {
    console.log(chalk.red('✗ P-256 (node:crypto)'), `- ${e}`);
  }

  // 3. SHA-256 via node:crypto
  try {
    const hash = crypto.createHash('sha256').update('hello').digest('hex');
    console.log(chalk.green('✓ SHA-256 (node:crypto)'), `- hash: ${hash.slice(0, 16)}...`);
  } catch (e) {
    console.log(chalk.red('✗ SHA-256 (node:crypto)'), `- ${e}`);
  }

  // 4. @ipld/dag-cbor
  try {
    const testObj = { hello: 'world', num: 42 };
    const encoded = dagCbor.encode(testObj);
    const decoded = dagCbor.decode(encoded);
    console.log(chalk.green('✓ @ipld/dag-cbor'), `- encode/decode: ${JSON.stringify(decoded)}`);
  } catch (e) {
    console.log(chalk.red('✗ @ipld/dag-cbor'), `- ${e}`);
  }

  // 5. multiformats
  try {
    const testBytes = new Uint8Array([1, 2, 3, 4]);
    const b58 = base58btc.encode(testBytes);
    const b32 = base32.encode(testBytes);
    console.log(chalk.green('✓ multiformats'), `- base58btc: ${b58}, base32: ${b32}`);
  } catch (e) {
    console.log(chalk.red('✗ multiformats'), `- ${e}`);
  }

  // 6. chalk
  console.log(chalk.green('✓ chalk'), '- terminal colors working');

  // 7. Types compile check
  const testIdentity: Partial<Identity> = { role: 'researcher' };
  const testPayload: Partial<RatingPayload> = { type: 'VenueRating' };
  const testScore: Partial<ReputationScore> = { score: 0.85 };
  console.log(chalk.green('✓ types'), '- all type definitions compile');

  console.log(chalk.bold('\n=== Setup verification complete ===\n'));
}

verifySetup().catch(console.error);