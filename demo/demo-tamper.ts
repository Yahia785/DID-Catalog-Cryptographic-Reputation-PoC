import chalk from 'chalk';
import { loadPlatform } from '../src/identity/identity-store.js';
import path from 'node:path';
import { FORMULAS } from '../src/scoring/compute-score.js';
import { issueScore } from '../src/scoring/issue-score.js';
import { SCORES_DIR, readScoreVC } from '../src/scoring/read-vc.js';
import { resolverFor, verifyScoreJwt } from '../src/verification/verify-score.js';
import { findVenue } from '../src/venues/registry.js';
import { printReport } from './demo-verify.js';

/**
 * npm run demo:tamper            (default venue: SCN)
 * npm run demo:tamper -- CIN
 * npm run demo:tamper -- SCN --dir=output/scores/f1     (formula 1.0 credentials)
 *
 * Attack scenarios against a real signed score, and which check catches each.
 * Nothing on disk is modified: every tampered copy lives in memory or a temp folder.
 */

const DIR = path.resolve(process.argv.find((a) => a.startsWith('--dir='))?.split('=')[1] ?? SCORES_DIR);
const resolver = resolverFor(process.argv.includes('--offline'));
const key = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'SCN';

async function main() {
  const venue = findVenue(key);
  if (!venue) throw new Error(`Unknown venue ${key}`);
  const original = readScoreVC(venue.slug, DIR);
  const formula = FORMULAS[original.manifest.formulaVersion];   // the same function the verifier runs
  const platform = loadPlatform();
  const retr = original.manifest.inputs.find((i) => i.metric === 'rw.retractions');

  console.log(chalk.bold(`\n=== DIDcal: tamper scenarios for ${venue.key} (signed score ${original.subject.score}) ===`));

  // 1. Honest credential
  printReport(await verifyScoreJwt(original.jwt, { resolver }),
    '1. Legitimate credential, untouched');

  // 2. Outsider edits the score inside the credential, keeps the old signature
  {
    const [h, p, s] = original.jwt.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.vc.credentialSubject.score = 92;
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
    printReport(await verifyScoreJwt(forged, { resolver }),
      '2. Someone changes the score to 92 after signing (no platform key)');
  }

  // 3. Dishonest platform signs an inflated score (valid signature, wrong math)
  {
    const inflated = original.subject.score === 92 ? 93 : 92;
    const payload = { ...original.subject, score: inflated };
    const vc = await issueScore(platform, { payload, manifest: original.manifest });
    printReport(await verifyScoreJwt(vc.jwt, { resolver }),
      `3. The platform itself signs an inflated score of ${inflated}`);
  }

  // A. Dishonest platform removes the warning flags and claims full confidence
  {
    const payload = { ...original.subject, flags: [], confidence: { present: 4, total: 4 } };
    const vc = await issueScore(platform, { payload, manifest: original.manifest });
    printReport(await verifyScoreJwt(vc.jwt, { resolver }),
      'A. The platform removes the flags and claims confidence 4/4');
  }

  // D. Dishonest platform signs under a formula version nobody can check
  {
    const payload = { ...original.subject, formulaVersion: '9.9' };
    const vc = await issueScore(platform, { payload, manifest: { ...original.manifest, formulaVersion: '9.9' } });
    printReport(await verifyScoreJwt(vc.jwt, { resolver }),
      'D. The platform signs with a made-up formula version 9.9');
  }

  // 4. Dishonest platform hides retractions in the manifest and recomputes consistently
  if (retr) {
    const inputs = original.manifest.inputs.map((i) => (i.metric === 'rw.retractions' ? { ...i, value: 0 } : i));
    const re = formula.compute(original.manifest.venueType, inputs, original.manifest.cohort);
    const payload = { ...original.subject, score: re.score, class: re.class, breakdown: re.breakdown, confidence: re.confidence, flags: re.flags };
    const vc = await issueScore(platform, { payload, manifest: { ...original.manifest, inputs } });
    console.log(chalk.yellow.bold(`\n4. The platform lies about the input data (not caught yet: needs check against the public source edition)`));
    console.log(chalk.gray(`   claims 0 retractions for ${venue.key}, real value is ${retr.value}`));
    printReport(await verifyScoreJwt(vc.jwt, { resolver }));
  }

  console.log(chalk.bold('\nSummary'));
  console.log('  2  outsider edits the credential        → caught by the signature');
  console.log('  3  platform signs a score that does not follow from its inputs → caught by recomputation');
  console.log('  A  platform hides flags / fakes confidence → caught by recomputation (every derived field is compared)');
  console.log('  D  platform invents a formula version   → caught by recomputation (unknown formula version)');
  console.log('  4  platform lies about the input data   → open until checked against the public source edition');
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
