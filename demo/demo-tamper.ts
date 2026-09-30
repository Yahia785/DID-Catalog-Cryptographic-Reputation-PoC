import chalk from 'chalk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    printReport(await verifyScoreJwt(vc.jwt, { offline }),
      `4. The platform signs a score computed as if ${venue.key} had 0 retractions (real: ${retr.value})`);
  }

  // 5. Someone edits the snapshot file after the score was signed
  {
    const srcDir = path.dirname(path.resolve(original.manifest.sources[0].file));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'didcal-tamper-'));
    for (const f of fs.readdirSync(srcDir)) fs.copyFileSync(path.join(srcDir, f), path.join(tmp, f));
    const rwFile = path.join(tmp, 'retraction-watch.json');
    const rw = JSON.parse(fs.readFileSync(rwFile, 'utf8'));
    if (rw.venues[venue.key]) rw.venues[venue.key].retractions = 0;
    fs.writeFileSync(rwFile, JSON.stringify(rw, null, 2));
    printReport(await verifyScoreJwt(original.jwt, { offline, snapshotDirOverride: tmp }),
      '5. The snapshot file is edited afterwards (retractions set to 0)');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 6. Old data
  {
    const in60 = new Date(Date.now() + 60 * 86_400_000);
    printReport(await verifyScoreJwt(original.jwt, { offline, now: in60 }),
      '6. The same credential checked 60 days from now');
  }

  console.log(chalk.bold('\nSummary'));
  console.log('  2  outsider edits the credential        → caught by the signature');
  console.log('  3  platform signs a score that does not follow from its inputs → caught by recomputation');
  console.log('  4  platform lies about the input data  → caught by checking inputs against the snapshot');
  console.log('  5  snapshot file edited later           → caught by the SHA-256 hashes');
  console.log('  6  data too old                         → flagged as a warning (score still authentic)');
  console.log(chalk.gray('\n  Scenario 4 relies on the verifier having the same snapshot files, which is why snapshots must be published.\n'));
}

main().catch((e) => { console.error(chalk.red(e instanceof Error ? e.message : e)); process.exit(1); });
