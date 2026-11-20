import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ccfOrdinal, crossTable, effectiveListed, jufoOrdinal, kendallTauB, ourOrdinal, ourRowOrder, twoSidedP } from '../src/analysis/e5-lib.js';

describe('ordinal scales', () => {
  it('our conference classes', () => {
    const exp: Record<string, number> = { 'A++': 7, 'A+': 6, A: 5, 'A-': 4, B: 3, 'B-': 2, C: 1 };
    for (const [k, v] of Object.entries(exp)) assert.equal(ourOrdinal('conference', k), v);
    assert.equal(ourOrdinal('conference', 'Work in progress'), null);
  });
  it('our journal bands', () => {
    const exp: Record<string, number> = { '200': 6, '140': 5, '100': 4, '70': 3, '40': 2, '20': 1 };
    for (const [k, v] of Object.entries(exp)) assert.equal(ourOrdinal('journal', k), v);
    assert.equal(ourOrdinal('journal', 'Not rated'), null);
    assert.equal(ourOrdinal('journal', 'A'), null);
  });
  it('CCF and JUFO', () => {
    assert.deepEqual(['A', 'B', 'C'].map(ccfOrdinal), [3, 2, 1]);
    assert.equal(ccfOrdinal(''), null);
    assert.deepEqual(['3', '2', '1', '0 (other identified)'].map(jufoOrdinal), [3, 2, 1, 0]);
    assert.equal(jufoOrdinal(''), null);
  });
  it('listed status honours a "no" confirmation', () => {
    assert.deepEqual(effectiveListed('listed', ''), { listed: true, rejected: false });
    assert.deepEqual(effectiveListed('listed', 'yes'), { listed: true, rejected: false });
    assert.deepEqual(effectiveListed('listed', 'no'), { listed: false, rejected: true });
    assert.deepEqual(effectiveListed('not listed', ''), { listed: false, rejected: false });
  });
});

describe('crossTable', () => {
  it('counts a small example, with the unrated row and the not-listed column', () => {
    const t = crossTable([
      { ours: 'A', theirs: 'A' }, { ours: 'A', theirs: 'B' }, { ours: 'B', theirs: 'not listed' },
      { ours: 'Work in progress', theirs: 'C' }, { ours: 'Work in progress', theirs: 'not listed' }, { ours: 'A', theirs: 'A' },
    ], ourRowOrder('conference'), ['A', 'B', 'C']);
    assert.deepEqual(t.colLabels, ['A', 'B', 'C', 'not listed']);
    const row = (l: string) => t.cells[t.rowLabels.indexOf(l)];
    assert.deepEqual(row('A'), [2, 1, 0, 0]);
    assert.deepEqual(row('B'), [0, 0, 0, 1]);
    assert.deepEqual(row('Work in progress'), [0, 0, 1, 1]);
    assert.equal(t.total, 6);
    assert.deepEqual(t.colTotals, [2, 1, 1, 2]);
  });
  it('rejects an unknown label', () => {
    assert.throws(() => crossTable([{ ours: 'Z', theirs: 'A' }], ['A'], ['A']));
  });
});

describe('kendallTauB', () => {
  it('matches scipy on a tied example (tau-b to 4 decimals, p loosely)', () => {
    const r = kendallTauB([1, 2, 2, 3, 3, 3, 4, 5, 5, 6], [1, 1, 2, 2, 3, 2, 3, 3, 3, 3]);
    assert.equal(r.n, 10);
    assert.ok(Math.abs(r.tau! - 0.795147) < 5e-5, `tau ${r.tau}`);
    assert.ok(Math.abs(r.p! - 0.005026) < 0.003, `p ${r.p}`);
  });
  it('perfect disagreement is -1', () => {
    const r = kendallTauB([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]);
    assert.ok(Math.abs(r.tau! + 1) < 1e-12);
    assert.ok(r.p! < 0.05);
  });
  it('n < 5 is "too few"; a constant variable has no tau', () => {
    const r = kendallTauB([1, 2, 3, 4], [1, 2, 3, 4]);
    assert.equal(r.tooFew, true);
    assert.equal(r.tau, null);
    assert.equal(r.p, null);
    assert.equal(kendallTauB([1, 2, 3, 4, 5], [2, 2, 2, 2, 2]).tau, null);
  });
  it('normal p-value helper', () => {
    assert.ok(Math.abs(twoSidedP(1.96) - 0.05) < 1e-3);
    assert.ok(Math.abs(twoSidedP(0) - 1) < 1e-6);
  });
});
