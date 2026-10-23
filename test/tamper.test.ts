import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { createIdentity } from '../src/identity/create-identity.js';
import type { AuditEntry, DidResolver } from '../src/identity/resolve-did.js';
import { issueScore } from '../src/scoring/issue-score.js';
import type { Identity, ReputationScore } from '../src/shared/types.js';
import {
  CONF, JOURNAL, T_AFTER_ROTATION, T_GENESIS, T_ROTATED, T_SIGNED, confInputs, entry, genesisOf, journalInputs, makeFixtures, makeScore, memoryResolver,
} from '../src/testing/fixtures.js';
import { verifyScoreJwt, type VerifyReport } from '../src/verification/verify-score.js';

/**
 * Tamper scenarios as automated tests. Fully offline and self-contained: throwaway
 * identities and an in-memory resolver (src/testing/fixtures.ts). Nothing in output/ is read or written.
 */

/** Names of the checks that failed. */
const failed = (r: VerifyReport) => r.checks.filter((c) => c.status === 'fail').map((c) => c.name);
const check = (r: VerifyReport, name: string) => r.checks.find((c) => c.name === name)!;

describe('tamper scenarios', () => {
  let platform: Identity, confVenue: Identity, journalVenue: Identity;
  let resolver: DidResolver;
  let confScore: ReputationScore, journalScore: ReputationScore;
  const verify = (jwt: string, r: DidResolver = resolver) => verifyScoreJwt(jwt, { resolver: r });
  const sign = async (s: ReputationScore, as: Identity = platform) => (await issueScore(as, s)).jwt;

  before(async () => {
    ({ platform, confVenue, journalVenue, resolver, confScore, journalScore } = await makeFixtures());
  });

  it('fixture sanity: the journal has flags', () => {
    assert.ok(journalScore.payload.flags.length > 0, `flags: ${journalScore.payload.flags}`);
  });

  for (const [label, get] of [['conference', () => confScore], ['journal with flags', () => journalScore]] as const) {
    it(`1  honest credential (${label}): all checks pass`, async () => {
      const r = await verify(await sign(get()));
      assert.equal(r.ok, true, JSON.stringify(r.checks));
      assert.deepEqual(r.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass']);
    });
  }

  it('2  outsider edits the score, keeps the old signature: Signature fails', async () => {
    const [h, p, s] = (await sign(journalScore)).split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.vc.credentialSubject.score = 92;
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
    const r = await verify(forged);
    assert.equal(r.ok, false);
    assert.equal(check(r, 'Signature').status, 'fail');
    assert.equal(check(r, 'Identities').status, 'pass');
    assert.equal(check(r, 'Venue').status, 'pass');
  });

  it('3  platform signs an inflated score: Recompute fails', async () => {
    const r = await verify(await sign({ ...journalScore, payload: { ...journalScore.payload, score: 92 } }));
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['Recompute']);
    assert.match(check(r, 'Recompute').detail, /score: expected/);
  });

  it('A  platform removes a flag and sets confidence 4/4: Recompute fails, detail names flags and confidence', async () => {
    // not listed in SCImago: only 3 of 4 sub-scores, so confidence 3/4 and a 'not indexed' flag to hide
    const partial = makeScore(JOURNAL, journalVenue.did, platform.did, journalInputs.filter((i) => i.metric !== 'scimago.quartile'));
    assert.deepEqual(partial.payload.confidence, { present: 3, total: 4 });
    const r = await verify(await sign({ ...partial, payload: { ...partial.payload, flags: [], confidence: { present: 4, total: 4 } } }));
    assert.deepEqual(failed(r), ['Recompute']);
    const d = check(r, 'Recompute').detail;
    assert.match(d, /flags: expected/);
    assert.match(d, /confidence: expected/);
  });

  it('D  formulaVersion "9.9": Recompute fails with "unknown formula version"', async () => {
    const s: ReputationScore = {
      payload: { ...journalScore.payload, formulaVersion: '9.9' },
      manifest: { ...journalScore.manifest, formulaVersion: '9.9' },
    };
    const r = await verify(await sign(s));
    assert.deepEqual(failed(r), ['Recompute']);
    assert.match(check(r, 'Recompute').detail, /unknown formula version 9\.9/);
  });

  it('B  one venue inputs and score put on another venue DID: Venue fails', async () => {
    const s = makeScore(CONF, journalVenue.did, platform.did, confInputs); // PST data, claimed for SCN DID
    const r = await verify(await sign(s));
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['Venue']);
  });

  it('E  computedAt changed in the payload only: Recompute fails', async () => {
    const r = await verify(await sign({ ...journalScore, payload: { ...journalScore.payload, computedAt: '2026-03-02T00:00:00.000Z' } }));
    assert.deepEqual(failed(r), ['Recompute']);
    assert.match(check(r, 'Recompute').detail, /computedAt/);
  });

  describe('F  key rotation', () => {
    let newKeyHolder: Identity;
    let oldOp: AuditEntry['operation'], newOp: AuditEntry['operation'];
    // the same platform DID after rotation: signs with the new key
    const asNewKey = (): Identity => ({ ...platform, signingKeyPair: newKeyHolder.signingKeyPair });
    const rotatedResolver = (nullified = false): DidResolver => memoryResolver({
      [confVenue.did]: [genesisOf(confVenue)],
      [journalVenue.did]: [genesisOf(journalVenue)],
      [platform.did]: [entry(platform.did, oldOp, T_GENESIS), entry(platform.did, newOp, T_ROTATED, nullified)],
    });
    const at = (computedAt: string) => makeScore(JOURNAL, journalVenue.did, platform.did, journalInputs, computedAt);

    before(async () => {
      newKeyHolder = await createIdentity('platform', 'new-key', { dryRun: true });
      oldOp = platform.plcOperation as AuditEntry['operation'];
      newOp = { ...oldOp, verificationMethods: { ...oldOp.verificationMethods, 'signing-1': newKeyHolder.signingKeyPair.did } };
    });

    it('F1 old key, dated before the rotation: passes', async () => {
      const r = await verify(await sign(at(T_SIGNED)), rotatedResolver());
      assert.equal(r.ok, true, JSON.stringify(r.checks));
      assert.match(check(r, 'Signature').detail, /operation 1 of 2/);
    });

    it('F2 old key, dated after the rotation: Signature fails', async () => {
      const r = await verify(await sign(at(T_AFTER_ROTATION)), rotatedResolver());
      assert.deepEqual(failed(r), ['Signature']);
    });

    it('F3 new key, dated after the rotation: passes', async () => {
      const r = await verify(await sign(at(T_AFTER_ROTATION), asNewKey()), rotatedResolver());
      assert.equal(r.ok, true, JSON.stringify(r.checks));
      assert.match(check(r, 'Signature').detail, /operation 2 of 2/);
    });

    it('F4 a nullified entry is ignored', async () => {
      // the rotation is nullified, so the old key is still the key after T_ROTATED
      const old = await verify(await sign(at(T_AFTER_ROTATION)), rotatedResolver(true));
      assert.equal(old.ok, true, JSON.stringify(old.checks));
      assert.match(check(old, 'Signature').detail, /operation 1 of 1/);
      // and the key from the nullified operation is not accepted
      const fromNullified = await verify(await sign(at(T_AFTER_ROTATION), asNewKey()), rotatedResolver(true));
      assert.deepEqual(failed(fromNullified), ['Signature']);
    });

    it('F5 signed before the DID existed: Signature fails', async () => {
      const r = await verify(await sign(at('2025-12-01T00:00:00.000Z')));
      assert.deepEqual(failed(r), ['Signature']);
      assert.match(check(r, 'Signature').detail, /before the issuer DID existed/);
    });
  });

  it('G  issuer DID unknown to the resolver: Signature fails', async () => {
    const venuesOnly = memoryResolver({ [confVenue.did]: [genesisOf(confVenue)], [journalVenue.did]: [genesisOf(journalVenue)] });
    const r = await verify(await sign(journalScore), venuesOnly);
    assert.deepEqual(failed(r), ['Signature']);
  });

  it('KNOWN OPEN: platform lies about inputs (needs check against public source edition)', async () => {
    const lied = journalInputs.map((i) => (i.metric === 'rw.retractions' ? { ...i, value: 0 } : i));
    const r = await verify(await sign(makeScore(JOURNAL, journalVenue.did, platform.did, lied)));
    assert.equal(r.ok, true, 'if this starts failing, the gap has been closed: turn this into a normal test');
    assert.notEqual(r.score, journalScore.payload.score);
  });
});
