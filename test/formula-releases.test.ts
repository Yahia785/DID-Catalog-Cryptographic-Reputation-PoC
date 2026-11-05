import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { FORMULAS } from '../src/scoring/compute-score.js';
import {
  FORMULA_SOURCES, anchorHeadOf, anchorService, canonicalJson, chainProblems, hashFormulaCode, recordHash, sha256Hex, signRelease,
  type ReleaseList, type ReleaseRecord, type SignedRelease,
} from '../src/scoring/formula-releases.js';
import { issueScore } from '../src/scoring/issue-score.js';
import type { Identity, InputValue, ReputationScore, ScoreCohort } from '../src/shared/types.js';
import { JOURNAL, T_GENESIS, T_SIGNED, entry, genesisOf, makeFixtures, makeScore, memoryResolver, journalInputs, num } from '../src/testing/fixtures.js';
import type { AuditEntry } from '../src/identity/resolve-did.js';
import { verifyScoreJwt, type VerifyReport } from '../src/verification/verify-score.js';

/**
 * The formula release chain and its anchor in the platform DID (check 5, "Formula").
 * Everything in memory: throwaway identities, an in-memory resolver, no network, no real release file.
 */

const T_RELEASED = '2026-01-15T00:00:00.000Z';
const T_ANCHOR = '2026-02-01T00:00:00.000Z';        // after the release, before the credential (T_SIGNED, 2026-03-01)
const VERSIONS = ['0.1-demo', '0.5-test', '1.0', '1.1-test'];
const codeOf = (v: string) => sha256Hex(`code of ${v}`);

const jCohort: ScoreCohort = { id: 't', values: { 'journal.scimago.sjr': Array.from({ length: 50 }, (_, i) => i + 1), 'journal.openalex.twoYrMeanCitedness': Array.from({ length: 50 }, (_, i) => i + 1) } };
const journalIn: InputValue[] = [num('scimago.sjr', 46, 'scimago'), num('openalex.twoYrMeanCitedness', 39, 'openalex')];

const failed = (r: VerifyReport) => r.checks.filter((c) => c.status === 'fail').map((c) => c.name);
const formula = (r: VerifyReport) => r.checks.find((c) => c.name === 'Formula')!;

describe('release chain helpers', () => {
  it('canonical JSON sorts keys and ignores their order', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  it('the code hash ignores line endings (CRLF and LF files hash the same)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codehash-'));
    fs.mkdirSync(path.join(dir, 'src/scoring'), { recursive: true });
    const file = path.join(dir, FORMULA_SOURCES['1.0']);
    fs.writeFileSync(file, 'line one\nline two\n');
    const lf = hashFormulaCode('1.0', dir);
    fs.writeFileSync(file, 'line one\r\nline two\r\n');
    assert.equal(hashFormulaCode('1.0', dir), lf);
    fs.writeFileSync(file, 'line one\nline TWO\n');
    assert.notEqual(hashFormulaCode('1.0', dir), lf);
    assert.throws(() => hashFormulaCode('9.9', dir), /no source file/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('anchor endpoints round-trip', () => {
    const h = sha256Hex('x');
    assert.equal(anchorHeadOf(anchorService(h)), h);
    assert.equal(anchorHeadOf({ endpoint: 'https://didcal.io/formulas' }), null);
    assert.equal(anchorHeadOf(undefined), null);
  });
});

describe('check 5: Formula', () => {
  let platform: Identity, journalVenue: Identity;
  let records: SignedRelease[];

  before(async () => {
    ({ platform, journalVenue } = await makeFixtures());
    records = [];
    for (const v of VERSIONS) {
      const record: ReleaseRecord = { formulaVersion: v, codeHash: codeOf(v), description: `formula ${v}`, releasedAt: T_RELEASED, prevHash: records.length ? recordHash(records[records.length - 1].record) : null };
      records.push({ record, jws: await signRelease(record, platform) });
    }
  });

  const list = (recs = records): ReleaseList => ({ platform: platform.did, records: recs });
  const headOf = (recs: SignedRelease[]) => recordHash(recs[recs.length - 1].record);

  /** A 1.0 credential carrying a code hash, signed at T_SIGNED, plus a platform audit log with an anchor operation. */
  async function scenario(o: {
    releases?: ReleaseList | null; anchored?: ReleaseList; anchorAt?: string; noAnchor?: boolean;
    version?: string; codeHash?: string | null; codeHashOf?: (v: string) => string; signer?: Identity;
  } = {}) {
    const version = o.version ?? '1.0';
    const f = FORMULAS['1.0'];
    const r = f.compute('journal', journalIn, jCohort);
    const manifestCodeHash = o.codeHash === undefined ? codeOf(version) : o.codeHash;
    const score: ReputationScore = {
      payload: { type: 'VenueScore', platform: platform.did, venue: journalVenue.did, venueType: 'journal', verificationMethod: `${platform.did}#signing-1`,
        score: r.score, class: r.class, confidence: r.confidence, breakdown: r.breakdown, flags: r.flags, formulaVersion: version, computedAt: T_SIGNED },
      manifest: { venueDID: journalVenue.did, venueKey: JOURNAL.key, venueType: 'journal', platformDID: platform.did, formula: f.description, formulaVersion: version,
        sources: [], inputs: journalIn, cohort: jCohort, ...(manifestCodeHash ? { codeHash: manifestCodeHash } : {}), computedAt: T_SIGNED },
    };
    const genesis = genesisOf(platform);
    const anchorOp = { ...(platform.plcOperation as AuditEntry['operation']), services: { ...(platform.plcOperation as { services: object }).services, didcal_formulas: anchorService(headOf((o.anchored ?? list()).records)) } };
    const log: AuditEntry[] = o.noAnchor ? [genesis] : [genesis, entry(platform.did, anchorOp, o.anchorAt ?? T_ANCHOR)];
    const resolver = memoryResolver({ [platform.did]: log, [journalVenue.did]: [genesisOf(journalVenue)] });
    const jwt = (await issueScore(o.signer ?? platform, score)).jwt;
    return verifyScoreJwt(jwt, { resolver, releases: o.releases === undefined ? list() : o.releases, codeHashOf: o.codeHashOf ?? codeOf });
  }

  it('honest: all five checks pass', async () => {
    const r = await scenario();
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.deepEqual(r.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
    assert.deepEqual(r.checks.map((c) => c.name), ['Signature', 'Identities', 'Venue', 'Recompute', 'Formula']);
    assert.match(formula(r).detail, /4 release\(s\) chained and signed/);
  });

  it('edited formula code: this checker\'s copy no longer hashes to the release', async () => {
    const r = await scenario({ codeHashOf: (v) => (v === '1.0' ? sha256Hex('edited') : codeOf(v)) });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /code was edited/);
  });

  it('a credential whose codeHash is not the released one fails', async () => {
    const r = await scenario({ codeHash: sha256Hex('something else') });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /not the released one/);
  });

  it('a record removed from the middle of the chain breaks it', async () => {
    const r = await scenario({ releases: list([records[0], records[2], records[3]]) });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /chain broken/);
  });

  it('the first record removed breaks it too', async () => {
    const r = await scenario({ releases: list(records.slice(1)) });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /earlier records were removed/);
  });

  it('a record edited after anchoring fails (the signature no longer holds, the chain no longer links)', async () => {
    const edited = records.map((s, i) => (i === 2 ? { ...s, record: { ...s.record, description: 'quietly changed' } } : s));
    const r = await scenario({ releases: list(edited) });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /chain broken|changed after it was signed/);
  });

  it('the newest record edited (and re-linked correctly) no longer matches the anchored head', async () => {
    const forged: ReleaseRecord = { ...records[3].record, description: 'rewritten' };
    const forgedSigned: SignedRelease = { record: forged, jws: await signRelease(forged, platform) };   // even properly signed
    const r = await scenario({ releases: list([...records.slice(0, 3), forgedSigned]) });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /not anchored/);
  });

  it('a record signed by someone else fails', async () => {
    const { platform: other } = await makeFixtures();
    const recs: SignedRelease[] = [];
    for (const v of VERSIONS) {
      const record: ReleaseRecord = { formulaVersion: v, codeHash: codeOf(v), description: `formula ${v}`, releasedAt: T_RELEASED, prevHash: recs.length ? recordHash(recs[recs.length - 1].record) : null };
      recs.push({ record, jws: await signRelease(record, other) });
    }
    const r = await scenario({ releases: list(recs), anchored: list(recs) });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /does not match the platform signing key/);
  });

  it('a formula anchored after the credential was signed (back-dated use) fails', async () => {
    const r = await scenario({ anchorAt: '2026-04-01T00:00:00.000Z' });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /after the credential was signed/);
  });

  it('never anchored: fails', async () => {
    const r = await scenario({ noAnchor: true });
    assert.deepEqual(failed(r), ['Formula']);
    assert.match(formula(r).detail, /not anchored/);
  });

  it('an anchor of an earlier head still covers the formulas up to it', async () => {
    // anchored when the chain ended at 1.0; a later record (1.1-test) exists in the list but is not anchored yet: the head check fails
    const upTo10 = list(records.slice(0, 3));
    const ok = await scenario({ releases: upTo10, anchored: upTo10 });
    assert.equal(formula(ok).status, 'pass', formula(ok).detail);
    const ahead = await scenario({ releases: list(), anchored: upTo10 });
    assert.deepEqual(failed(ahead), ['Formula']);
  });

  it('an unknown formulaVersion fails', async () => {
    const r = await scenario({ version: '9.9' });
    assert.ok(failed(r).includes('Formula'));
    assert.match(formula(r).detail, /formula 9\.9 has no release record/);
  });

  it('no release list at all fails', async () => {
    const r = await scenario({ releases: null });
    assert.deepEqual(failed(r), ['Formula']);
  });

  it('a credential without a codeHash (issued before releases) only warns', async () => {
    const r = await scenario({ codeHash: null });
    assert.equal(formula(r).status, 'warn');
    assert.match(formula(r).detail, /no fingerprint \(issued before releases\)/);
    assert.equal(r.ok, true);
  });

  it('a 0.1-demo credential from the fixtures (no codeHash) warns and stays valid', async () => {
    const { platform: p, journalVenue: jv, resolver } = await makeFixtures();
    const s = makeScore(JOURNAL, jv.did, p.did, journalInputs);
    const r = await verifyScoreJwt((await issueScore(p, s)).jwt, { resolver });
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.deepEqual(r.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass', 'warn']);
  });

  it('chainProblems also catches a duplicated formula', () => {
    assert.match(chainProblems([records[0].record, { ...records[0].record, prevHash: recordHash(records[0].record) }]).join(';'), /more than one record/);
  });
});
