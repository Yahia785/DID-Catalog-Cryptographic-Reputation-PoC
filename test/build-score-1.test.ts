import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCohort, buildInputs1, scoreFromInputs1 } from '../src/scoring/build-score-1.js';
import { FAILED, type Snapshot } from '../src/scoring/snapshot-store.js';
import { findVenue } from '../src/venues/registry.js';

/** Building formula 1.0 inputs and cohorts from a snapshot (a small hand-made one, no files). */

const src = (id: string, venues: Record<string, unknown>) => ({ source: { id, name: id, access: 'csv', url: '', retrievedAt: '' }, years: [2023, 2024, 2025], venues });
const snap = (overrides: Record<string, unknown> = {}): Snapshot => ({
  dir: 'data/snapshots/f1-test',
  index: { createdAt: '', dir: 'data/snapshots/f1-test', files: [], formula: '1.0' },
  sources: {
    icore: src('icore', { PST: { coreId: '127', title: 't', acronym: 'PST', edition: 'ICORE2026', rank: 'C' } }),
    scimago: src('scimago', { PST: { sourceid: '1', title: 'x', sjr: null, quartile: '-', hIndex: 30, totalDocs3y: 1, citesPerDoc2y: 1 }, TIFS: { sourceid: '2', title: 'y', sjr: 2.193, quartile: 'Q1', hIndex: 195, totalDocs3y: 1, citesPerDoc2y: 1 } }),
    openalex: src('openalex', {
      PST: { worksCount: 489, citedByCount: 4189, twoYrMeanCitedness: 1, hIndex: 29, worksByYear: { 2023: 20, 2024: 25 } },
      TIFS: { worksCount: 6983, citedByCount: 1, twoYrMeanCitedness: 7.95, hIndex: 209, worksByYear: {} },
    }),
    'retraction-watch': src('retraction-watch', { PST: { records: 0, retractions: 0, byYear: {}, topReasons: {} }, TIFS: { records: 0, retractions: 0, byYear: {}, topReasons: {} } }),
    ...overrides,
  } as unknown as Snapshot['sources'],
});

describe('formula 1.0 inputs and cohort', () => {
  const PST = findVenue('PST')!, TIFS = findVenue('TIFS')!;

  it('conference inputs use the names formula 1.0 reads', () => {
    const m = new Map(buildInputs1(PST, snap()).map((i) => [i.metric, i.value]));
    assert.equal(m.get('icore.rank'), 'C');
    assert.equal(m.get('openalex.hIndex'), 29);
    assert.equal(m.get('openalex.citedByCount'), 4189);
    assert.equal(m.get('openalex.worksCount'), 489);
    assert.equal(m.get('scimago.hIndex'), 30);
    assert.equal(m.get('openalex.works.2024'), 25);
    assert.equal(m.get('openalex.works.2025'), null);       // a year OpenAlex has no row for is missing, not zero
    assert.equal(m.get('rw.retractions'), 0);
  });

  it('journal inputs: SJR and 2-yr citedness', () => {
    const m = new Map(buildInputs1(TIFS, snap()).map((i) => [i.metric, i.value]));
    assert.equal(m.get('scimago.sjr'), 2.193);
    assert.equal(m.get('openalex.twoYrMeanCitedness'), 7.95);
  });

  it('a failed value can never become an input', () => {
    const failed = snap({ openalex: src('openalex', { PST: FAILED, TIFS: FAILED }) });
    assert.throws(() => buildInputs1(PST, failed), /failed to collect/);
    assert.throws(() => buildCohort(failed, 'conference'), /failed to collect/);
  });

  it('the cohort holds the sorted values of the venues of that type that have them, and its id follows its content', () => {
    const c = buildCohort(snap(), 'conference');
    assert.deepEqual(c.values['conf.openalex.hIndex'], [29]);
    assert.deepEqual(c.values['conf.scimago.hIndex'], [30]);
    assert.equal(c.populationSize, 800);
    assert.match(c.id, /^f1-test\/conference\/[0-9a-f]{16}$/);
    assert.equal(buildCohort(snap(), 'conference').id, c.id);                           // deterministic
    const other = buildCohort(snap({ scimago: src('scimago', { PST: { sourceid: '1', title: 'x', sjr: null, quartile: '-', hIndex: 31 } }) }), 'conference');
    assert.notEqual(other.id, c.id);                                                    // different values, different id
    const j = buildCohort(snap(), 'journal');
    assert.deepEqual(j.values['journal.scimago.sjr'], [2.193]);
    assert.equal(j.populationSize, undefined);
  });

  it('scoreFromInputs1 produces a 1.0 payload and manifest carrying the cohort', () => {
    const s = snap();
    const cohort = buildCohort(s, 'journal');
    const r = scoreFromInputs1({ venue: TIFS, venueDID: 'did:plc:v', platformDID: 'did:plc:p', snapshot: s, inputs: buildInputs1(TIFS, s), cohort, computedAt: '2026-10-28T00:00:00.000Z' });
    assert.equal(r.payload.formulaVersion, '1.0');
    assert.equal(r.payload.class, '20');                          // alone in its cohort: 0 other venues below
    assert.deepEqual(r.manifest.cohort, cohort);
    assert.equal(r.manifest.formulaVersion, '1.0');
  });
});
