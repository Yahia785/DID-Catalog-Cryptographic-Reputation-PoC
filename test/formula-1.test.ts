import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { computeScore1, correctClass, classFromRank, citationClass, GGS_TABLE, ggsLookup, percentile } from '../src/scoring/formula-1.js';
import { FORMULAS } from '../src/scoring/compute-score.js';
import { issueScore } from '../src/scoring/issue-score.js';
import type { Identity, InputValue, ReputationScore, ScoreCohort, VenueType } from '../src/shared/types.js';
import { CONF, JOURNAL, T_SIGNED, journalInputs, makeFixtures, num, str } from '../src/testing/fixtures.js';
import type { DidResolver } from '../src/identity/resolve-did.js';
import type { VenueEntry } from '../src/venues/registry.js';
import { verifyScoreJwt, type VerifyReport } from '../src/verification/verify-score.js';

/** Formula 1.0: pure unit tests (no network, no files), then credentials signed with test fixtures. */

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);   // 1..n
// 100 conferences with h-indexes 1..100: position p = 101 - h, estimated rank r = 8p
// (h=100 → r 8 A++; h=95 → 48 A++; h=94 → 56 A+; h=91 → 80 A; h=75 → 208 A-; h=69 → 256 B; h=29 → 576 B-; h=19 → 656 C)
const confCohort: ScoreCohort = { id: 'test', populationSize: 800, values: { 'conf.openalex.hIndex': range(100), 'conf.scimago.hIndex': range(100) } };
// 50 journals with values 1..50: percentile of value v = 2 × (v - 1)  (50 → 98, 46 → 90, 39 → 76, 26 → 50, 14 → 26, 13 → 24)
const jCohort: ScoreCohort = { id: 'test', values: { 'journal.scimago.sjr': range(50), 'journal.openalex.twoYrMeanCitedness': range(50) } };

const oa = (h: number, avg: number): InputValue[] => [num('openalex.hIndex', h, 'openalex'), num('openalex.citedByCount', avg * 1000, 'openalex'), num('openalex.worksCount', 1000, 'openalex')];
const sc = (h: number): InputValue[] => [num('scimago.hIndex', h, 'scimago')];
const icore = (rank: string): InputValue[] => [str('icore.rank', rank, 'icore')];
const conf = (inputs: InputValue[], cohort = confCohort) => computeScore1('conference', inputs, cohort);
const jour = (sjr: number | null, cit: number | null, cohort = jCohort) =>
  computeScore1('journal', [
    ...(sjr === null ? [] : [num('scimago.sjr', sjr, 'scimago')]),
    ...(cit === null ? [] : [num('openalex.twoYrMeanCitedness', cit, 'openalex')]),
  ], cohort);

describe('formula 1.0: GGS table and class steps', () => {
  it('the GGS table has every combination of three classes (84)', () => {
    const cls = ['A++', 'A+', 'A', 'A-', 'B', 'B-', 'C'];
    let n = 0;
    for (let a = 0; a < 7; a++) for (let b = a; b < 7; b++) for (let c = b; c < 7; c++) { assert.ok(GGS_TABLE[[cls[a], cls[b], cls[c]].join(',')], `missing ${cls[a]},${cls[b]},${cls[c]}`); n++; }
    assert.equal(n, 84);
    assert.equal(Object.keys(GGS_TABLE).length, 84);
  });

  it('table lookups ignore order and normalise Work in progress', () => {
    assert.equal(ggsLookup(['B', 'A', 'A']), 'A-');
    assert.equal(ggsLookup(['A', 'B', 'A']), 'A-');
    assert.equal(ggsLookup(['C', 'C', 'C']), 'Work in progress');
    assert.equal(ggsLookup(['A++', 'A++', 'A++']), 'A++');
  });

  it('rank cutoffs, including the boundaries', () => {
    const cases: [number, string][] = [[1, 'A++'], [50, 'A++'], [51, 'A+'], [75, 'A+'], [76, 'A'], [200, 'A'], [201, 'A-'], [250, 'A-'], [251, 'B'], [575, 'B'], [576, 'B-'], [650, 'B-'], [651, 'C'], [800, 'C']];
    for (const [r, c] of cases) assert.equal(classFromRank(r), c, `r=${r}`);
  });

  it('citation class cutoffs', () => {
    const cases: [number, string][] = [[25, 'A++'], [24.9, 'A+'], [23, 'A+'], [18, 'A'], [17.9, 'A-'], [16, 'A-'], [12, 'B'], [10, 'B-'], [7, 'C'], [6.99, 'D'], [0, 'D']];
    for (const [a, c] of cases) assert.equal(citationClass(a), c, `a=${a}`);
  });

  it('every correction rule, and the cases that stay unchanged', () => {
    const rules: [any, any, string][] = [
      ['A++', 'B', 'A+'], ['A++', 'B-', 'A+'], ['A++', 'C', 'A+'], ['A++', 'D', 'A+'],
      ['A+', 'B-', 'A'], ['A+', 'C', 'A'], ['A+', 'D', 'A'],
      ['A', 'C', 'A-'], ['A', 'D', 'A-'],
      ['A-', 'D', 'B'],
      ['A', 'A++', 'A+'],
      ['A-', 'A++', 'A'], ['A-', 'A+', 'A'], ['A-', 'A', 'A'],
      ['B', 'A++', 'A-'], ['B', 'A+', 'A-'], ['B', 'A', 'A-'],
      ['B-', 'A++', 'B'], ['B-', 'A+', 'B'], ['B-', 'A', 'B'], ['B-', 'A-', 'B'],
      ['C', 'A++', 'B-'], ['C', 'A+', 'B-'], ['C', 'A', 'B-'], ['C', 'A-', 'B-'],
    ];
    for (const [h, c, want] of rules) assert.equal(correctClass(h, c).cls, want, `${h} with ${c}`);
    const unchanged: [any, any][] = [['A++', 'A++'], ['A++', 'A-'], ['A+', 'B'], ['A+', 'A++'], ['A', 'A-'], ['A', 'B'], ['A-', 'B'], ['B', 'B'], ['B', 'D'], ['B-', 'B'], ['C', 'B-'], ['C', 'D']];
    for (const [h, c] of unchanged) assert.equal(correctClass(h, c).cls, h, `${h} with ${c} unchanged`);
    assert.equal(correctClass('B', 'B').rule, null);
  });
});

describe('formula 1.0: conferences', () => {
  it('three sources all A++ → A++, 21 points, confidence 3/3, no flags', () => {
    const r = conf([...icore('A*'), ...oa(100, 30), ...sc(100)]);
    assert.equal(r.class, 'A++');
    assert.equal(r.score, 21);
    assert.deepEqual(r.confidence, { present: 3, total: 3 });
    assert.deepEqual(r.flags, []);
    assert.equal(r.breakdown.icoreClass, 'A++');
    assert.equal(r.breakdown.openalexClass, 'A++');
    assert.equal(r.breakdown.scimagoClass, 'A++');
    assert.equal(r.breakdown.finalClass, 'A++');
  });

  it('three different classes use the table: A (ICORE) + B (OpenAlex) + A- (SCImago)', () => {
    // OpenAlex h=69 → r 256 → B, avg 14 → B (no correction); SCImago h=75 → r 208 → A-
    const r = conf([...icore('A'), ...oa(69, 14), ...sc(75)]);
    assert.equal(r.breakdown.openalexClass, 'B');
    assert.equal(r.breakdown.scimagoClass, 'A-');
    assert.equal(r.class, ggsLookup(['A', 'B', 'A-']));
    assert.equal(r.score, 5 + 3 + 4);
  });

  it('ICORE A* + OpenAlex A++ only → capped at A, virtual third, flag', () => {
    const r = conf([...icore('A*'), ...oa(100, 30)]);
    assert.equal(r.class, 'A');
    assert.equal(r.score, 21);                       // 7 + 7 + the virtual 7
    assert.equal(r.breakdown.virtualClass, 'A++');
    assert.deepEqual(r.confidence, { present: 2, total: 3 });
    assert.deepEqual(r.flags, ['two sources only (capped at A)']);
  });

  it('two sources of different class: the virtual third is the lower one, and a result below A is not capped', () => {
    const r = conf([...icore('B'), ...sc(76)]);      // SCImago h=76 → r 200 → A
    assert.equal(r.breakdown.scimagoClass, 'A');
    assert.equal(r.breakdown.virtualClass, 'B');
    assert.equal(r.class, ggsLookup(['A', 'B', 'B']));
    assert.equal(r.score, 5 + 3 + 3);
    assert.deepEqual(r.flags, ['two sources only (capped at A)']);
  });

  it('one source → Work in progress, no points, flag', () => {
    const r = conf(icore('C'));
    assert.equal(r.class, 'Work in progress');
    assert.equal(r.score, null);
    assert.deepEqual(r.confidence, { present: 1, total: 3 });
    assert.deepEqual(r.flags, ['not classifiable']);
  });

  it('no source at all → Work in progress, not ranked flag', () => {
    const r = conf([]);
    assert.equal(r.class, 'Work in progress');
    assert.equal(r.score, null);
    assert.deepEqual(r.confidence, { present: 0, total: 3 });
    assert.deepEqual(r.flags, ['not ranked (ICORE)', 'not classifiable']);
  });

  it('an ICORE rank outside A*/A/B/C gives no class and the flag', () => {
    const r = conf([...icore('National: USA'), ...oa(100, 30), ...sc(100)]);
    assert.equal(r.breakdown.icoreClass, null);
    assert.ok(r.flags.includes('not ranked (ICORE)'));
    assert.equal(r.class, 'A');                      // two sources, capped
  });

  it('corrections are applied to OpenAlex through the average citations (and only OpenAlex)', () => {
    // h=100 → A++, 12 citations/paper → B → A+
    let r = conf(oa(100, 12));
    assert.equal(r.breakdown.openalexHClass, 'A++');
    assert.equal(r.breakdown.openalexAvgCitations, 12);
    assert.equal(r.breakdown.openalexCitationClass, 'B');
    assert.equal(r.breakdown.openalexClass, 'A+');
    assert.equal(r.breakdown.openalexCorrection, 'A++ with B → A+');
    // h=91 → A (r 80... p=10, r=80 → A), 5 citations/paper → D → A-
    r = conf(oa(91, 5));
    assert.equal(r.breakdown.openalexHClass, 'A');
    assert.equal(r.breakdown.openalexClass, 'A-');
    // h=69 → B (r 256), 25 citations/paper → A++ → A-
    r = conf(oa(69, 25));
    assert.equal(r.breakdown.openalexHClass, 'B');
    assert.equal(r.breakdown.openalexClass, 'A-');
    // h=19 → C (r 656), 18 citations/paper → A → B-
    r = conf(oa(19, 18));
    assert.equal(r.breakdown.openalexHClass, 'C');
    assert.equal(r.breakdown.openalexClass, 'B-');
    // SCImago h=100 is A++ and is never corrected
    r = conf(sc(100));
    assert.equal(r.breakdown.scimagoClass, 'A++');
    assert.equal(r.breakdown.openalexClass, null);
  });

  it('missing citation counts: class from the h-index, no correction', () => {
    const r = conf([num('openalex.hIndex', 100, 'openalex')]);
    assert.equal(r.breakdown.openalexClass, 'A++');
    assert.equal(r.breakdown.openalexAvgCitations, null);
    assert.equal(r.breakdown.openalexCorrection, null);
  });

  it('ties share the best position', () => {
    // five venues: 10, 10, 10, 5, 1
    const tie: ScoreCohort = { id: 't', values: { 'conf.scimago.hIndex': [1, 5, 10, 10, 10] } };
    const top = conf(sc(10), tie);                   // p = 1 → r = ceil(1/5 × 800) = 160 → A
    assert.equal(top.breakdown.scimagoRank, 160);
    assert.equal(top.breakdown.scimagoClass, 'A');
    const mid = conf(sc(5), tie);                    // p = 1 + 3 = 4 → r = 640 → B-
    assert.equal(mid.breakdown.scimagoRank, 640);
    assert.equal(mid.breakdown.scimagoClass, 'B-');
    const low = conf(sc(1), tie);                    // p = 5 → r = 800 → C
    assert.equal(low.breakdown.scimagoRank, 800);
    assert.equal(low.breakdown.scimagoClass, 'C');
  });

  it('the population size comes from the cohort', () => {
    const c: ScoreCohort = { id: 't', populationSize: 400, values: { 'conf.scimago.hIndex': range(100) } };
    // h=100: p=1, r = ceil(1/100 × 400) = 4; h=50: p=51, r = 204
    assert.equal(conf(sc(100), c).breakdown.scimagoRank, 4);
    assert.equal(conf(sc(50), c).breakdown.scimagoRank, 204);
  });

  it('without a cohort the h-index sources give no class', () => {
    const r = computeScore1('conference', [...icore('A*'), ...oa(100, 30), ...sc(100)]);
    assert.equal(r.breakdown.openalexClass, null);
    assert.equal(r.breakdown.scimagoClass, null);
    assert.equal(r.class, 'Work in progress');
  });

  it('is deterministic and gives a working text for every step', () => {
    const inputs = [...icore('A*'), ...oa(100, 12), ...sc(94)];
    assert.deepEqual(conf(inputs), conf(inputs));
    const e = conf(inputs).explain;
    for (const k of ['icoreClass', 'openalexHClass', 'openalexCitationClass', 'openalexClass', 'scimagoClass', 'finalClass', 'score', 'class']) assert.ok(e[k], k);
  });
});

describe('formula 1.0: journals', () => {
  it('percentile counts lower values and half of the other equal ones', () => {
    assert.equal(percentile(2, [1, 2, 2, 2, 3]), 40);       // (1 lower + 0.5 × 2 other ties) / 5
    assert.equal(percentile(3, [1, 2, 2, 2, 3]), 80);
    assert.equal(percentile(1, [1, 2, 2, 2, 3]), 0);
    assert.equal(percentile(50, range(50)), 98);
  });

  it('both indicators in the same band', () => {
    const r = jour(50, 50);                          // both 98 → 200
    assert.equal(r.class, '200');
    assert.equal(r.score, 98);
    assert.deepEqual(r.confidence, { present: 2, total: 2 });
    assert.deepEqual(r.flags, []);
  });

  it('different bands: the higher band and the higher percentile win', () => {
    const r = jour(46, 39);                          // 90 → 140, 76 → 100
    assert.equal(r.breakdown.sjrBand, 140);
    assert.equal(r.breakdown.citednessBand, 100);
    assert.equal(r.class, '140');
    assert.equal(r.score, 90);
    assert.deepEqual(r.flags, []);                   // one band step apart
    assert.equal(jour(39, 46).class, '140');         // the other way round
  });

  it('every band edge', () => {
    const cases: [number, string][] = [[50, '200'], [49, '140'], [46, '140'], [45, '100'], [39, '100'], [38, '70'], [26, '70'], [25, '40'], [14, '40'], [13, '20'], [1, '20']];
    // v → percentile 2 × (v - 1): 49 → 96 (140), 46 → 90 (140), 45 → 88 (100), 38 → 74 (70), 26 → 50 (70), 25 → 48 (40), 14 → 26 (40), 13 → 24 (20)
    for (const [v, c] of cases) assert.equal(jour(v, null).class, c, `v=${v}`);
  });

  it('bands two or more steps apart raise the flag, one step does not', () => {
    assert.ok(jour(50, 39).flags.includes('sources disagree'));   // 200 vs 100
    assert.ok(jour(46, 26).flags.includes('sources disagree'));   // 140 vs 70
    assert.ok(jour(50, 26).flags.includes('sources disagree'));   // 200 vs 70
    assert.ok(!jour(50, 46).flags.includes('sources disagree'));  // 200 vs 140
    assert.ok(!jour(39, 26).flags.includes('sources disagree'));  // 100 vs 70
    assert.equal(jour(50, 26).class, '200');                      // the flag never changes the class
  });

  it('one indicator only', () => {
    const noSjr = jour(null, 46);
    assert.equal(noSjr.class, '140');
    assert.deepEqual(noSjr.confidence, { present: 1, total: 2 });
    assert.deepEqual(noSjr.flags, ['not indexed (SCImago)']);
    const noCit = jour(46, null);
    assert.equal(noCit.class, '140');
    assert.deepEqual(noCit.flags, []);
  });

  it('no indicator → Not rated', () => {
    const r = jour(null, null);
    assert.equal(r.class, 'Not rated');
    assert.equal(r.score, null);
    assert.deepEqual(r.confidence, { present: 0, total: 2 });
    assert.deepEqual(r.flags, ['not indexed (SCImago)']);
  });

  it('percentile ties', () => {
    const tie: ScoreCohort = { id: 't', values: { 'journal.scimago.sjr': [1, 2, 2, 2, 3], 'journal.openalex.twoYrMeanCitedness': [1, 2, 2, 2, 3] } };
    const r = jour(2, null, tie);                    // 40 → band 40
    assert.equal(r.breakdown.sjrPercentile, 40);
    assert.equal(r.class, '40');
    assert.equal(jour(3, null, tie).breakdown.sjrPercentile, 80);
  });

  it('percentiles are rounded to one decimal', () => {
    const c: ScoreCohort = { id: 't', values: { 'journal.scimago.sjr': range(7) } };
    assert.equal(jour(6, null, c).breakdown.sjrPercentile, 71.4);   // 5/7 × 100
  });

  it('the publication spike reads OpenAlex works per year for conferences too (and ignores Semantic Scholar series)', () => {
    const years = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
    const series = (prefix: string, src: 'openalex' | 's2') => years.map((y, i) => num(`${prefix}.${y}`, i === 6 ? 900 : 100, src));
    const base = [...icore('A*'), ...oa(100, 30), ...sc(100)];
    const spike = conf([...base, ...series('openalex.works', 'openalex')]);
    assert.deepEqual(spike.flags, ['publication spike']);
    assert.equal(spike.class, 'A++');                                     // flags never change the class
    assert.deepEqual(conf([...base, ...series('s2.papers', 's2')]).flags, []);
    // a steady series gives no flag
    assert.deepEqual(conf([...base, ...years.map((y) => num(`openalex.works.${y}`, 100, 'openalex'))]).flags, []);
  });

  it('flags never change class or points: spike and retraction wave on a Q3-like journal', () => {
    const plain = computeScore1('journal', [num('scimago.sjr', 46, 'scimago')], jCohort);
    const flagged = computeScore1('journal', [num('scimago.sjr', 46, 'scimago'), ...journalInputs.filter((i) => i.metric !== 'scimago.quartile' && i.metric !== 'openalex.twoYrMeanCitedness')], jCohort);
    assert.deepEqual(flagged.flags, ['publication spike', 'retraction wave']);
    assert.equal(flagged.class, plain.class);
    assert.equal(flagged.score, plain.score);
  });
});

describe('formula 1.0: credentials', () => {
  let platform: Identity, confVenue: Identity, journalVenue: Identity;
  let resolver: DidResolver;
  const failed = (r: VerifyReport) => r.checks.filter((c) => c.status === 'fail').map((c) => c.name);
  const check = (r: VerifyReport, name: string) => r.checks.find((c) => c.name === name)!;
  const verify = (jwt: string) => verifyScoreJwt(jwt, { resolver });

  const confIn: InputValue[] = [...icore('B'), ...oa(76, 20), ...sc(50), num('rw.retractions', 3, 'retraction-watch')];
  const journalIn: InputValue[] = [num('scimago.sjr', 46, 'scimago'), num('openalex.twoYrMeanCitedness', 39, 'openalex')];

  /** A 1.0 score built the way the platform would: the formula's own output, plus the cohort in the manifest. */
  function make(venue: VenueEntry, venueDID: string, inputs: InputValue[], cohort: ScoreCohort, type: VenueType = venue.type): ReputationScore {
    const f = FORMULAS['1.0'];
    const r = f.compute(type, inputs, cohort);
    return {
      payload: {
        type: 'VenueScore', platform: platform.did, venue: venueDID, venueType: type, verificationMethod: `${platform.did}#signing-1`,
        score: r.score, class: r.class, confidence: r.confidence, breakdown: r.breakdown, flags: r.flags, formulaVersion: '1.0', computedAt: T_SIGNED,
      },
      manifest: {
        venueDID, venueKey: venue.key, venueType: type, platformDID: platform.did, formula: f.description, formulaVersion: '1.0',
        sources: [], inputs, cohort, computedAt: T_SIGNED,
      },
    };
  }
  const confScore = () => make(CONF, confVenue.did, confIn, confCohort);
  const journalScore = () => make(JOURNAL, journalVenue.did, journalIn, jCohort);
  const sign = async (s: ReputationScore) => (await issueScore(platform, s)).jwt;

  /** Edit a signed JWT's credential subject without re-signing. */
  const edit = (jwt: string, change: (subject: any) => void) => {
    const [h, p, s] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    change(claims.vc.credentialSubject);
    return `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
  };

  before(async () => {
    ({ platform, confVenue, journalVenue, resolver } = await makeFixtures());
  });

  it('1.0 is registered next to 0.1-demo', () => {
    assert.ok(FORMULAS['0.1-demo']);
    assert.ok(FORMULAS['1.0']);
    assert.match(FORMULAS['1.0'].description, /GGS/);
  });

  for (const [label, get] of [['conference', confScore], ['journal', journalScore]] as const) {
    it(`honest 1.0 credential (${label}): all checks pass`, async () => {
      const s = get();
      assert.ok(s.payload.class);
      const r = await verify(await sign(s));
      assert.equal(r.ok, true, JSON.stringify(r.checks));
      assert.deepEqual(r.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass']);
    });
  }

  it('the conference credential carries the expected class and points', () => {
    const s = confScore();
    assert.equal(s.payload.class, 'B');                      // ICORE B + OpenAlex A (h76 → r 200; 20 cites: A, no correction) + SCImago B (h50 → r 408): table [A,B,B] → B
    assert.equal(s.payload.score, 3 + 5 + 3);
    assert.equal(journalScore().payload.class, '140');
    assert.equal(journalScore().payload.score, 90);
  });

  const afterSigning: [string, (subject: any) => void][] = [
    ['class', (s) => { s.class = 'A++'; }],
    ['points', (s) => { s.score = 99; }],
    ['a cohort value', (s) => { s.provenanceManifest.cohort.values[Object.keys(s.provenanceManifest.cohort.values)[0]][0] += 1; }],
    ['an input', (s) => { s.provenanceManifest.inputs[0].value = s.provenanceManifest.inputs[0].value === 'A*' ? 'B' : 'A*'; }],
  ];
  for (const [what, change] of afterSigning) {
    it(`changing ${what} after signing: Signature fails`, async () => {
      const r = await verify(edit(await sign(confScore()), change));
      assert.equal(r.ok, false);
      assert.equal(check(r, 'Signature').status, 'fail');
    });
  }

  it('the platform signs a wrong class: Recompute fails and names the class', async () => {
    const s = confScore();
    const r = await verify(await sign({ ...s, payload: { ...s.payload, class: 'A++' } }));
    assert.deepEqual(failed(r), ['Recompute']);
    assert.match(check(r, 'Recompute').detail, /class: expected "B"/);
  });

  it('the platform signs wrong points: Recompute fails', async () => {
    const s = journalScore();
    const r = await verify(await sign({ ...s, payload: { ...s.payload, score: 97 } }));
    assert.deepEqual(failed(r), ['Recompute']);
    assert.match(check(r, 'Recompute').detail, /score: expected/);
  });

  it('the platform signs a cohort that does not give the signed class: Recompute fails', async () => {
    const s = confScore();
    const worse: ScoreCohort = { ...confCohort, values: { ...confCohort.values, 'conf.openalex.hIndex': range(100).map((v) => v + 100) } };   // everybody beats h=76
    const r = await verify(await sign({ ...s, manifest: { ...s.manifest, cohort: worse } }));
    assert.deepEqual(failed(r), ['Recompute']);
  });

  it('removing the cohort from a 1.0 credential: Recompute fails', async () => {
    const s = confScore();
    const { cohort: _drop, ...manifest } = s.manifest;
    const r = await verify(await sign({ ...s, manifest }));
    assert.deepEqual(failed(r), ['Recompute']);
  });

  it('a class added to a 0.1-demo credential is caught', async () => {
    const f = FORMULAS['0.1-demo'];
    const r0 = f.compute('journal', [str('scimago.quartile', 'Q1', 'scimago')]);
    const s: ReputationScore = {
      payload: { type: 'VenueScore', platform: platform.did, venue: journalVenue.did, venueType: 'journal', verificationMethod: `${platform.did}#signing-1`,
        score: r0.score, class: 'A++', confidence: r0.confidence, breakdown: r0.breakdown, flags: r0.flags, formulaVersion: '0.1-demo', computedAt: T_SIGNED },
      manifest: { venueDID: journalVenue.did, venueKey: JOURNAL.key, venueType: 'journal', platformDID: platform.did, formula: f.description, formulaVersion: '0.1-demo',
        sources: [], inputs: [str('scimago.quartile', 'Q1', 'scimago')], computedAt: T_SIGNED },
    };
    const r = await verify(await sign(s));
    assert.deepEqual(failed(r), ['Recompute']);
    assert.match(check(r, 'Recompute').detail, /class/);
  });
});
