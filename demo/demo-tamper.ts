import chalk from 'chalk';
import { loadPlatform } from '../src/identity/identity-store.js';
import { computeScore } from '../src/scoring/compute-score.js';
import { issueScore } from '../src/scoring/issue-score.js';
import { readScoreVC } from '../src/scoring/read-vc.js';
import { verifyScoreJwt } from '../src/verification/verify-score.js';
import { findVenue } from '../src/venues/registry.js';
import { printReport } from './demo-verify.js';

/**
 * npm run demo:tamper            (default venue: SCN)
 * npm run demo:tamper -- CIN
 *
 * Attack scenarios against a real signed score, and which check catches each.
 * Nothing on disk is modified: every tampered copy lives in memory or a temp folder.
 */

const offline = process.argv.includes('--offline');
const key = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'SCN';

async function main() {
  const venue = findVenue(key);
  if (!venue) throw new Error(`Unknown venue ${key}`);
  const original = readScoreVC(venue.slug);
  const platform = loadPlatform();
  const retr = original.manifest.inputs.find((i) => i.metric === 'rw.retractions');

  console.log(chalk.bold(`\n=== DIDcal: tamper scenarios for ${venue.key} (signed score ${original.subject.score}) ===`));

  // 1. Honest credential
  printReport(await verifyScoreJwt(original.jwt, { offline }),
    '1. Legitimate credential, untouched');

  // 2. Outsider edits the score inside the credential, keeps the old signature
  {
    const [h, p, s] = original.jwt.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.vc.credentialSubject.score = 92;
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
    printReport(await verifyScoreJwt(forged, { offline }),
      '2. Someone changes the score to 92 after signing (no platform key)');
  }

  // 3. Dishonest platform signs an inflated score (valid signature, wrong math)
  {
    const payload = { ...original.subject, score: 92 };
    const vc = await issueScore(platform, { payload, manifest: original.manifest });
    printReport(await verifyScoreJwt(vc.jwt, { offline }),
      '3. The platform itself signs an inflated score of 92');
  }

  // 4. Dishonest platform hides retractions in the manifest and recomputes consistently
  if (retr) {
    const inputs = original.manifest.inputs.map((i) => (i.metric === 'rw.retractions' ? { ...i, value: 0 } : i));
    const re = computeScore(original.manifest.venueType, inputs);
    const payload = { ...original.subject, score: re.score, breakdown: re.breakdown, confidence: re.confidence, flags: re.flags };
    const vc = await issueScore(platform, { payload, manifest: { ...original.manifest, inputs } });
    console.log(chalk.yellow.bold(`\n4. The platform lies about the input data (not caught yet: needs present-time verification)`));
    console.log(chalk.gray(`   claims 0 retractions for ${venue.key}, real value is ${retr.value}`));
    printReport(await verifyScoreJwt(vc.jwt, { offline }));
  }

  console.log(chalk.bold('\nSummary'));
  console.log('  2  outsider edits the credential        → caught by the signature');
  console.log('  3  platform signs a score that does not follow from its inputs → caught by recomputation');
  console.log('  4  platform lies about the input data   → open until present-time verification');
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
