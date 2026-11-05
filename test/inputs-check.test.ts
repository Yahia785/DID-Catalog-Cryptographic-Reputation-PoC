import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FORMULAS } from '../src/scoring/compute-score.js';
import { contentHash } from '../src/scoring/extract-1.js';
import { issueScore } from '../src/scoring/issue-score.js';
import type { Identity, InputValue, ProvenanceManifest, ReputationScore, ScoreCohort, SourceSnapshot } from '../src/shared/types.js';
import { JOURNAL, T_SIGNED, makeFixtures, num, str } from '../src/testing/fixtures.js';
import { ProviderFiles, assertNotOwnData, checkInputs, type InputsResult } from '../src/verification/check-inputs.js';
import { checkRunCohorts } from '../src/verification/check-run.js';
import { verifyScoreJwt } from '../src/verification/verify-score.js';

/**
 * L3, the Inputs check, on small synthetic provider files in a temp folder (no network, no data/).
 * The credentials here are hand-made manifests: what is under test is the comparison with the files.
 */

const ICORE = '12,ACM CCS,CCS,ICORE2026,A*,Yes,4604,,\n127,"Annual Conference on Privacy, Security and Trust",PST,ICORE2026,C,No,4604,,\n';
const SCIMAGO_HEADER = 'Rank;Sourceid;Title;Type;Issn;SJR;SJR Best Quartile;H index;Total Docs. (2025);Total Docs. (3years);Citations / Doc. (2years);Categories;Areas\n';
const SCIMAGO = SCIMAGO_HEADER
  + '1;100;"Security and Communication Networks";journal;"19390114, 19390122";2,193;Q1;195;48;1437;9,71;"Computer Networks (Q1)";"Computer Science"\n'
  + '2;200;"Other Journal";journal;"11111111";0,5;Q3;10;5;50;1,1;"Software (Q3)";"Computer Science"\n';
const RW_HEADER = 'Record ID,Title,Journal,RetractionDate,RetractionNature,Reason\n';
const scnRows = ['1,t,Security and Communication Networks,1/10/2023 0:00,Retraction,x', '2,t,Security and Communication Networks,6/1/2024 0:00,Retraction,x', '3,t,Security and Communication Networks,8/2/2025 0:00,Retraction,x'];
const otherRow = '4,t,Another Journal,9/19/2026 0:00,Retraction,x';   // makes the file's as-of date 2026-09-19
const rwFile = (rows = scnRows) => RW_HEADER + [...rows, otherRow].join('\n') + '\n';

const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');
const tmpDirs: string[] = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'l3-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A folder with the three provider files; `over` replaces or (with null) removes one. */
function sources(over: Partial<Record<'icore.csv' | 'scimago.csv' | 'retraction_watch.csv', string | null>> = {}) {
  const dir = mkdir();
  const files = { 'icore.csv': ICORE, 'scimago.csv': SCIMAGO, 'retraction_watch.csv': rwFile(), ...over };
  for (const [name, text] of Object.entries(files)) if (text !== null) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const base = (id: string, edition?: string, text?: string): SourceSnapshot => ({
  id, name: id, access: id === 'openalex' ? 'api' : 'csv', url: '', retrievedAt: '', file: '', ...(edition ? { edition } : {}), ...(text !== undefined ? { sha256: sha(text), bytes: text.length } : {}),
  ...(text !== undefined && (id === 'icore' || id === 'scimago') ? { contentHash: contentHash(id, text) } : {}),
});
const SCN_RULE = '^security and communication networks';

/** A journal credential's manifest as formula 1.0 would sign it, built to match the synthetic files (or not). */
function journal(o: { sjr?: number; retractions?: number; sourceid?: string; edition?: string; cutoff?: string; scimagoText?: string; rwText?: string; commit?: string } = {}): ProvenanceManifest {
  const inputs: InputValue[] = [
    num('scimago.sjr', o.sjr ?? 2.193, 'scimago'), num('openalex.twoYrMeanCitedness', 0.745, 'openalex'), num('openalex.worksCount', 5995, 'openalex'),
    num('rw.retractions', o.retractions ?? 3, 'retraction-watch'),
  ];
  return {
    venueDID: 'did:plc:v', venueKey: JOURNAL.key, venueType: 'journal', platformDID: 'did:plc:p', formula: '', formulaVersion: '1.0', computedAt: T_SIGNED, inputs,
    sources: [
      { ...base('scimago', o.edition ?? 'SJR 2025', o.scimagoText ?? SCIMAGO), verifiable: 'file', match: { sourceid: o.sourceid ?? '100', issn: '19390114, 19390122' } },
      { ...base('retraction-watch', 'file dated 2026-09-24', o.rwText ?? rwFile()), verifiable: 'file', match: { rwMatch: SCN_RULE, cutoff: o.cutoff ?? '2026-09-19', ...(o.commit ? { commit: o.commit } : {}) } },
      { ...base('openalex'), verifiable: 'live', verifiableReason: 'live API, no fixed edition', match: { openalexId: 'S120683614' } },
    ],
  };
}
function conference(rank = 'C'): ProvenanceManifest {
  return {
    venueDID: 'did:plc:v', venueKey: 'PST', venueType: 'conference', platformDID: 'did:plc:p', formula: '', formulaVersion: '1.0', computedAt: T_SIGNED,
    inputs: [str('icore.rank', rank, 'icore'), num('openalex.hIndex', 29, 'openalex')],
    sources: [{ ...base('icore', 'ICORE2026', ICORE), verifiable: 'file', match: { coreId: '127' } }, { ...base('openalex'), verifiable: 'live', match: { openalexId: 'S7407087549' } }],
  };
}

const run = (m: ProvenanceManifest, dir: string): InputsResult => checkInputs(m, new ProviderFiles(dir));
const of = (r: InputsResult, source: string) => r.sources.find((s) => s.source === source)!;

describe('Inputs check (L3): one credential against the provider\'s files', () => {
  it('honest credential: pass, with the matched row\'s title, and OpenAlex listed as not verifiable', () => {
    const r = run(journal(), sources());
    assert.equal(r.status, 'pass', r.detail);
    assert.equal(of(r, 'scimago').status, 'pass');
    assert.equal(of(r, 'scimago').title, 'Security and Communication Networks');
    assert.equal(of(r, 'retraction-watch').status, 'pass');
    assert.equal(of(r, 'openalex').status, 'not-verifiable');
    assert.match(of(r, 'openalex').reason, /live API, no fixed edition/);
    assert.match(r.detail, /openalex.twoYrMeanCitedness/);        // the OpenAlex inputs are named
    assert.match(r.detail, /openalex.worksCount/);
  });

  it('a conference: the ICORE row\'s title is shown, a wrong rank fails', () => {
    const ok = run(conference(), sources());
    assert.equal(ok.status, 'pass', ok.detail);
    assert.equal(of(ok, 'icore').title, 'Annual Conference on Privacy, Security and Trust');
    const bad = run(conference('A*'), sources());
    assert.equal(bad.status, 'fail');
    assert.match(of(bad, 'icore').reason, /icore.rank: the credential says A\*, the provider's file says C/);
  });

  it('retractions recorded as 0 while the provider\'s file has 3: fail', () => {
    const r = run(journal({ retractions: 0 }), sources());
    assert.equal(r.status, 'fail');
    assert.equal(of(r, 'retraction-watch').status, 'fail');
    assert.match(of(r, 'retraction-watch').reason, /too many to be late additions/);
    assert.equal(of(r, 'scimago').status, 'pass');                    // only the lie is flagged
  });

  it('an SJR value changed: fail', () => {
    const r = run(journal({ sjr: 9.9 }), sources());
    assert.equal(r.status, 'fail');
    assert.match(of(r, 'scimago').reason, /scimago.sjr: the credential says 9.9, the provider's file says 2.193/);
  });

  it('a file edited but the values unchanged: warn', () => {
    const edited = SCIMAGO.replace('"Other Journal"', '"Another Journal"');
    const r = run(journal(), sources({ 'scimago.csv': edited }));
    assert.equal(of(r, 'scimago').status, 'warn');
    assert.match(of(r, 'scimago').reason, /content differs.*other rows changed/);
    assert.equal(r.status, 'warn');
  });

  describe('order-independent content hash (ICORE and SCImago)', () => {
    const reorder = (text: string, header: boolean) => { const l = text.trimEnd().split('\n'); const h = header ? l.splice(0, 1) : []; return [...h, ...l.reverse()].join('\n') + '\n'; };

    it('the same rows in a different order: pass, "same content, different byte order"', () => {
      const ic = run(conference(), sources({ 'icore.csv': reorder(ICORE, false) }));
      assert.equal(of(ic, 'icore').status, 'pass', of(ic, 'icore').reason);
      assert.match(of(ic, 'icore').reason, /same content, different byte order/);
      const sc = run(journal(), sources({ 'scimago.csv': reorder(SCIMAGO, true) }));
      assert.equal(of(sc, 'scimago').status, 'pass', of(sc, 'scimago').reason);
      assert.match(of(sc, 'scimago').reason, /same content, different byte order/);
      assert.equal(sc.status, 'pass');
    });

    it('identical bytes say "same file bytes"', () => {
      assert.match(of(run(journal(), sources()), 'scimago').reason, /same file bytes/);
    });

    it('a changed unrelated row warns (the content differs, the venue\'s values are equal)', () => {
      const r = run(conference(), sources({ 'icore.csv': ICORE.replace('ACM CCS,CCS,ICORE2026,A*', 'ACM CCS,CCS,ICORE2026,A') }));
      assert.equal(of(r, 'icore').status, 'warn');
      assert.match(of(r, 'icore').reason, /content differs/);
    });

    it('a changed venue value fails, even when the rows are reordered', () => {
      const r = run(journal(), sources({ 'scimago.csv': reorder(SCIMAGO.replace('2,193', '3,5'), true) }));
      assert.equal(of(r, 'scimago').status, 'fail');
      assert.match(of(r, 'scimago').reason, /scimago.sjr: the credential says 2.193, the provider's file says 3.5/);
    });

    it('a credential without a content hash falls back to the old warn on different bytes', () => {
      const m = conference();
      delete m.sources[0].contentHash;
      const r = run(m, sources({ 'icore.csv': reorder(ICORE, false) }));
      assert.equal(of(r, 'icore').status, 'warn');
      assert.match(of(r, 'icore').reason, /no content hash/);
    });
  });

  it('a different edition: not verifiable (and not a failure)', () => {
    const r = run(journal(), sources({ 'scimago.csv': SCIMAGO.replace('(2025)', '(2024)') }));
    assert.equal(of(r, 'scimago').status, 'not-verifiable');
    assert.match(of(r, 'scimago').reason, /edition not available.*SJR 2024.*SJR 2025/);
    assert.notEqual(r.status, 'fail');
    // a false SJR is not caught against another edition, by design: the edition has to match
    assert.equal(run(journal({ sjr: 9.9 }), sources({ 'scimago.csv': SCIMAGO.replace('(2025)', '(2024)') })).sources.find((s) => s.source === 'scimago')!.status, 'not-verifiable');
    const ic = run(conference(), sources({ 'icore.csv': ICORE.replaceAll('ICORE2026', 'ICORE2025') }));
    assert.equal(of(ic, 'icore').status, 'not-verifiable');
  });

  it('a missing file: not verifiable (and not a failure)', () => {
    const r = run(journal(), sources({ 'scimago.csv': null }));
    assert.equal(of(r, 'scimago').status, 'not-verifiable');
    assert.match(of(r, 'scimago').reason, /scimago.csv is not in the sources folder/);
    assert.equal(r.status, 'pass');                                     // the Retraction Watch part is still checked
    const none = run(journal(), sources({ 'scimago.csv': null, 'retraction_watch.csv': null }));
    assert.equal(none.status, 'skip');                                  // nothing could be checked: not a pass either
  });

  it('a matching rule that finds no row although the credential has a value: fail', () => {
    const r = run(journal({ sourceid: '999' }), sources());
    assert.equal(of(r, 'scimago').status, 'fail');
    assert.match(of(r, 'scimago').reason, /Sourceid 999\) finds no row.*scimago.sjr = 2.193/);
    const ic = run({ ...conference(), sources: [{ ...conference().sources[0], match: { coreId: '99999' } }] }, sources());
    assert.equal(of(ic, 'icore').status, 'fail');
  });

  describe('SCImago absence by ISSN (journals only)', () => {
    /** A journal credential for a journal with no SCImago id: no SJR, and the rule says it is absent. */
    const absent = (issn: string[]): ProvenanceManifest => ({
      venueDID: 'did:plc:v', venueKey: 'CIN', venueType: 'journal', platformDID: 'did:plc:p', formula: '', formulaVersion: '1.0', computedAt: T_SIGNED,
      inputs: [{ metric: 'scimago.sjr', value: null, sourceId: 'scimago' }, num('openalex.twoYrMeanCitedness', 0.029, 'openalex')],
      sources: [{ ...base('scimago', 'SJR 2025', SCIMAGO), verifiable: 'file', match: { issn, absent: true } }, { ...base('openalex'), verifiable: 'live' }],
    });

    it('a journal that is not in the file: pass, "confirmed not in SCImago"', () => {
      const r = run(absent(['16875265']), sources());
      assert.equal(of(r, 'scimago').status, 'pass', of(r, 'scimago').reason);
      assert.match(of(r, 'scimago').reason, /confirmed not in SCImago/);
      assert.equal(r.status, 'pass');
    });

    it('a journal found by ISSN (either of its ISSNs, hyphens ignored): warn, naming the row', () => {
      for (const issn of [['19390114'], ['1939-0122'], ['16875265', '19390122']]) {
        const r = run(absent(issn), sources());
        assert.equal(of(r, 'scimago').status, 'warn', issn.join());
        assert.match(of(r, 'scimago').reason, /listed in SCImago \(Security and Communication Networks, Sourceid 100\) but the credential has no SCImago input/);
      }
    });

    it('another edition of the file is not verifiable, as for every SCImago rule', () => {
      assert.equal(of(run(absent(['16875265']), sources({ 'scimago.csv': SCIMAGO.replace('(2025)', '(2024)') })), 'scimago').status, 'not-verifiable');
    });

    it('a conference with no SCImago id has no rule and stays "not verifiable (no matching rule)"', () => {
      const m = conference();
      m.sources.push({ ...base('scimago', 'SJR 2025', SCIMAGO), verifiable: 'file' });   // no match: no id and no ISSN to search by
      const r = run(m, sources());
      assert.equal(of(r, 'scimago').status, 'not-verifiable');
      assert.match(of(r, 'scimago').reason, /no matching rule/);
    });
  });

  it('a credential without a matching rule (issued before the Inputs check) is not verifiable', () => {
    const m = journal();
    m.sources = m.sources.map(({ verifiable: _v, match: _m, ...rest }) => rest);
    const r = run(m, sources());
    assert.equal(r.status, 'skip');
    assert.ok(r.sources.filter((s) => s.source !== 'openalex').every((s) => /issued before the Inputs check/.test(s.reason)));
  });

  describe('Retraction Watch (the file changes daily: counted up to the credential\'s cutoff, hash not compared)', () => {
    it('a newer file with newer rows: still pass', () => {
      const newer = rwFile([...scnRows, '5,t,Security and Communication Networks,10/1/2026 0:00,Retraction,x']);
      const r = run(journal(), sources({ 'retraction_watch.csv': newer }));
      assert.equal(of(r, 'retraction-watch').status, 'pass', of(r, 'retraction-watch').reason);
    });

    it('a row added later with an older date: warn', () => {
      const added = rwFile([...scnRows, '5,t,Security and Communication Networks,2/2/2022 0:00,Retraction,x']);
      const r = run(journal(), sources({ 'retraction_watch.csv': added }));
      assert.equal(of(r, 'retraction-watch').status, 'warn');
      assert.match(of(r, 'retraction-watch').reason, /1 record\(s\) dated before the cutoff 2026-09-19 were added later/);
      assert.equal(r.status, 'warn');
    });

    it('a row removed: fail', () => {
      const r = run(journal(), sources({ 'retraction_watch.csv': rwFile(scnRows.slice(0, 2)) }));
      assert.equal(of(r, 'retraction-watch').status, 'fail');
      assert.match(of(r, 'retraction-watch').reason, /credential says 3, the provider's file has only 2/);
    });

    it('a file older than the credential\'s cutoff cannot judge it: not verifiable', () => {
      const r = run(journal({ cutoff: '2026-12-31' }), sources());
      assert.equal(of(r, 'retraction-watch').status, 'not-verifiable');
    });

    describe('pinned to a GitLab commit', () => {
      const COMMIT = '827665ab699e4a798060b95c40268de417b7f2e1';
      it('the pinned file (same hash) with matching values: pass, compared exactly', () => {
        const r = run(journal({ commit: COMMIT }), sources());
        assert.equal(of(r, 'retraction-watch').status, 'pass', of(r, 'retraction-watch').reason);
        assert.match(of(r, 'retraction-watch').reason, /pinned version, commit 827665ab, same file bytes; compared exactly/);
      });

      it('the pinned file with a lowered count fails, with NO tolerance (the unpinned rule would only warn)', () => {
        const m = journal({ commit: COMMIT, retractions: 2 });          // file has 3: one more than the credential, inside the tolerance of 1
        assert.equal(of(run(m, sources()), 'retraction-watch').status, 'fail');
        assert.match(of(run(m, sources()), 'retraction-watch').reason, /the pinned file \(commit 827665ab\) says 3/);
        const unpinned = journal({ retractions: 2 });                   // same numbers, no commit: the tolerance applies
        assert.equal(of(run(unpinned, sources()), 'retraction-watch').status, 'warn');
      });

      it('the pinned file with a raised count fails too', () => {
        assert.equal(of(run(journal({ commit: COMMIT, retractions: 4 }), sources()), 'retraction-watch').status, 'fail');
      });

      it('a different file falls back to the count rule, and says it is not the pinned version', () => {
        const other = rwFile([...scnRows, '5,t,Security and Communication Networks,2/2/2022 0:00,Retraction,x']);
        const r = run(journal({ commit: COMMIT }), sources({ 'retraction_watch.csv': other }));
        assert.equal(of(r, 'retraction-watch').status, 'warn');                 // one late addition, inside the tolerance
        assert.match(of(r, 'retraction-watch').reason, /1 record\(s\) dated before the cutoff.*file is not the pinned version \(commit 827665ab\)/);
        const same = run(journal({ commit: COMMIT }), sources({ 'retraction_watch.csv': rwFile([...scnRows, '5,t,Another Journal,1/1/2022 0:00,Retraction,x']) }));
        assert.equal(of(same, 'retraction-watch').status, 'pass');
        assert.match(of(same, 'retraction-watch').reason, /not the pinned version/);
      });

      it('a credential without a commit keeps the existing rule (no note)', () => {
        const r = run(journal(), sources());
        assert.doesNotMatch(of(r, 'retraction-watch').reason, /pinned/);
      });
    });

    it('a different file (other bytes) is no problem by itself', () => {
      const r = run(journal({ rwText: 'something else entirely' }), sources());
      assert.equal(of(r, 'retraction-watch').status, 'pass');
    });
  });

  it('each provider file is parsed once per run, not once per credential', () => {
    const files = new ProviderFiles(sources());
    for (let i = 0; i < 20; i++) checkInputs(journal(), files);
    assert.equal(files.loads.length, 2);                                 // scimago and retraction-watch, each loaded one time
    const before = files.load('scimago');
    checkInputs(journal(), files);
    assert.equal(files.load('scimago'), before);
  });
});

describe('--sources-dir must not be our own data/', () => {
  it('data/ and anything inside it are refused', () => {
    assert.throws(() => assertNotOwnData('data'), /inside data\//);
    assert.throws(() => assertNotOwnData('./data/snapshots/f1-2026-10-28'), /inside data\//);
    assert.throws(() => assertNotOwnData(path.resolve('data', 'ggs')), /inside data\//);
    assert.throws(() => new ProviderFiles('data'), /inside data\//);
  });
  it('another folder is fine, also one that merely starts with the same letters', () => {
    assert.doesNotThrow(() => assertNotOwnData(sources()));
    assert.doesNotThrow(() => assertNotOwnData('l3-sources'));
    assert.doesNotThrow(() => assertNotOwnData('data-from-providers'));
  });
});

describe('Inputs as the sixth check of verifyScoreJwt', () => {
  let platform: Identity, journalVenue: Identity, resolver: Awaited<ReturnType<typeof makeFixtures>>['resolver'];
  before(async () => { ({ platform, journalVenue, resolver } = await makeFixtures()); });

  const cohort: ScoreCohort = { id: 't', values: { 'journal.scimago.sjr': Array.from({ length: 50 }, (_, i) => i + 1), 'journal.openalex.twoYrMeanCitedness': Array.from({ length: 50 }, (_, i) => i + 1) } };
  async function credential(m: ProvenanceManifest) {
    const r = FORMULAS['1.0'].compute('journal', m.inputs, cohort);
    const score: ReputationScore = {
      payload: { type: 'VenueScore', platform: platform.did, venue: journalVenue.did, venueType: 'journal', verificationMethod: `${platform.did}#signing-1`,
        score: r.score, class: r.class, confidence: r.confidence, breakdown: r.breakdown, flags: r.flags, formulaVersion: '1.0', computedAt: T_SIGNED },
      manifest: { ...m, venueDID: journalVenue.did, platformDID: platform.did, formula: FORMULAS['1.0'].description, cohort },
    };
    return (await issueScore(platform, score)).jwt;
  }

  it('without a sources folder there is no Inputs row (five checks, as before)', async () => {
    const r = await verifyScoreJwt(await credential(journal()), { resolver });
    assert.deepEqual(r.checks.map((c) => c.name), ['Signature', 'Identities', 'Venue', 'Recompute', 'Formula']);
  });

  it('with one: honest passes, a lie about retractions fails Inputs while Signature and Recompute still pass', async () => {
    const dir = sources();
    const ok = await verifyScoreJwt(await credential(journal()), { resolver, sourcesDir: dir });
    assert.equal(ok.checks.at(-1)!.name, 'Inputs');
    assert.equal(ok.checks.at(-1)!.status, 'pass', ok.checks.at(-1)!.detail);
    assert.equal(ok.ok, true);
    const lie = await verifyScoreJwt(await credential(journal({ retractions: 0 })), { resolver, sourcesDir: dir });
    const status = (n: string) => lie.checks.find((c) => c.name === n)!.status;
    assert.equal(status('Signature'), 'pass');
    assert.equal(status('Recompute'), 'pass');
    assert.equal(status('Inputs'), 'fail');
    assert.equal(lie.ok, false);
  });

  it('a sources folder inside data/ is an error, not a quiet pass', async () => {
    const jwt = await credential(journal());
    await assert.rejects(() => verifyScoreJwt(jwt, { resolver, sourcesDir: 'data' }), /inside data\//);
  });
});

describe('cohort consistency across a run (--run-dir)', () => {
  let platform: Identity, journalVenue: Identity;
  before(async () => { ({ platform, journalVenue } = await makeFixtures()); });

  /** Write one journal credential (only its manifest matters here) into a run folder. */
  async function write(dir: string, key: string, sjr: number, cit: number, cohort: ScoreCohort) {
    const inputs = [num('scimago.sjr', sjr, 'scimago'), num('openalex.twoYrMeanCitedness', cit, 'openalex')];
    const score: ReputationScore = {
      payload: { type: 'VenueScore', platform: platform.did, venue: journalVenue.did, venueType: 'journal', verificationMethod: `${platform.did}#signing-1`, score: null, class: '20', confidence: { present: 2, total: 2 }, breakdown: {}, flags: [], formulaVersion: '1.0', computedAt: T_SIGNED },
      manifest: { venueDID: journalVenue.did, venueKey: key, venueType: 'journal', platformDID: platform.did, formula: '', formulaVersion: '1.0', sources: [], inputs, cohort, computedAt: T_SIGNED },
    };
    fs.writeFileSync(path.join(dir, `${key}.vc.jwt`), (await issueScore(platform, score)).jwt);
  }
  const cohortOf = (id = 'run/journal/aaaa', sjr = [1, 2, 3], cit = [10, 20, 30]): ScoreCohort => ({ id, values: { 'journal.openalex.twoYrMeanCitedness': cit, 'journal.scimago.sjr': sjr } });
  const honestRun = async (mutate: (i: number, c: ScoreCohort) => ScoreCohort = (_, c) => c) => {
    const dir = mkdir();
    for (const [i, key] of ['J1', 'J2', 'J3'].entries()) await write(dir, key, i + 1, (i + 1) * 10, mutate(i, cohortOf()));
    return dir;
  };

  it('a consistent run passes', async () => {
    const r = checkRunCohorts(await honestRun());
    assert.equal(r.status, 'pass', r.problems.join('; '));
    assert.equal(r.credentials, 3);
    assert.equal(r.perType[0].cohortId, 'run/journal/aaaa');
  });

  it('cohort ids differ across the run: fail, naming the credential', async () => {
    const r = checkRunCohorts(await honestRun((i, c) => (i === 2 ? { ...c, id: 'run/journal/bbbb' } : c)));
    assert.equal(r.status, 'fail');
    assert.match(r.problems.join(';'), /J3: cohort id run\/journal\/bbbb differs from run\/journal\/aaaa/);
  });

  it('the same id but different values: fail', async () => {
    const r = checkRunCohorts(await honestRun((i, c) => (i === 1 ? cohortOf('run/journal/aaaa', [1, 2, 3], [10, 20, 31]) : c)));
    assert.equal(r.status, 'fail');
    assert.match(r.problems.join(';'), /J2: same cohort id .* but different values/);
  });

  it('a cohort value that no credential in the run has: fail', async () => {
    const extra = cohortOf('run/journal/aaaa', [1, 2, 3, 4], [10, 20, 30]);
    const dir = mkdir();
    for (const [i, key] of ['J1', 'J2', 'J3'].entries()) await write(dir, key, i + 1, (i + 1) * 10, extra);
    const r = checkRunCohorts(dir);
    assert.equal(r.status, 'fail');
    assert.match(r.problems.join(';'), /journal.scimago.sjr: the cohort has the value 4, but no credential in the run has it as scimago.sjr/);
  });

  it('an input that is missing from the cohort: fail, naming the venue', async () => {
    const dir = mkdir();
    for (const [i, key] of ['J1', 'J2', 'J3'].entries()) await write(dir, key, i === 2 ? 7 : i + 1, (i + 1) * 10, cohortOf());
    const r = checkRunCohorts(dir);
    assert.equal(r.status, 'fail');
    assert.match(r.problems.join(';'), /J3's scimago.sjr 7 is not in the cohort/);
  });

  it('an empty folder fails', () => {
    assert.equal(checkRunCohorts(mkdir()).status, 'fail');
  });
});
