import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { drawSubsets, shift, summarizeChanges } from '../src/analysis/e4-lib.js';

describe('shift', () => {
  it('conferences: one step per class, positive = up, Work in progress is the last step', () => {
    assert.equal(shift('conference', 'A', 'A+'), 1);
    assert.equal(shift('conference', 'A+', 'A'), -1);
    assert.equal(shift('conference', 'A++', 'C'), -6);
    assert.equal(shift('conference', 'C', 'Work in progress'), -1);
    assert.equal(shift('conference', 'B', 'B'), 0);
  });
  it('journals: bands 200..20, "Not rated" has no step', () => {
    assert.equal(shift('journal', '70', '140'), 2);
    assert.equal(shift('journal', '20', '200'), 5);
    assert.equal(shift('journal', '100', '70'), -1);
    assert.equal(shift('journal', '70', 'Not rated'), null);
    assert.equal(shift('journal', 'Not rated', '20'), null);
  });
  it('an unknown class is an error, not a silent zero', () => {
    assert.throws(() => shift('conference', 'A', 'D'));
  });
});

describe('summarizeChanges', () => {
  it('counts changed, direction, mean and largest shift', () => {
    const s = summarizeChanges('conference', [
      { key: 'a', from: 'A', to: 'A' }, { key: 'b', from: 'A', to: 'A+' }, { key: 'c', from: 'B', to: 'C' }, { key: 'd', from: 'A++', to: 'B' },
    ]);
    assert.equal(s.n, 4); assert.equal(s.changed, 3); assert.equal(s.shareChanged, 75);
    assert.equal(s.up, 1); assert.equal(s.down, 2);
    assert.equal(s.maxShift, 4);
    assert.equal(s.meanAbsShift, (0 + 1 + 2 + 4) / 4);
    assert.deepEqual(s.changes.map((c) => c.key), ['b', 'c', 'd']);
  });
  it('"Not rated" counts as changed but stays out of the step average', () => {
    const s = summarizeChanges('journal', [
      { key: 'a', from: '70', to: '40' }, { key: 'b', from: '70', to: 'Not rated' }, { key: 'c', from: '100', to: '100' },
    ]);
    assert.equal(s.changed, 2); assert.equal(s.notRatedChanges, 1); assert.equal(s.shiftN, 2);
    assert.equal(s.meanAbsShift, 0.5); assert.equal(s.down, 1); assert.deepEqual(s.unrated, { before: 0, after: 1 });
  });
  it('an empty list gives no mean', () => {
    assert.equal(summarizeChanges('journal', []).meanAbsShift, null);
  });
});

describe('drawSubsets', () => {
  const items = Array.from({ length: 50 }, (_, i) => `v${i}`);
  it('the same seed gives the same subsets', () => {
    assert.deepEqual(drawSubsets(items, 40, 30, 4242), drawSubsets(items, 40, 30, 4242));
  });
  it('a different seed gives different subsets', () => {
    assert.notDeepEqual(drawSubsets(items, 40, 30, 4242), drawSubsets(items, 40, 30, 4243));
  });
  it('each subset has k distinct items from the list', () => {
    for (const sub of drawSubsets(items, 40, 30, 1)) {
      assert.equal(sub.length, 40); assert.equal(new Set(sub).size, 40);
      assert.ok(sub.every((x) => items.includes(x)));
    }
  });
  it('rejects k larger than the list', () => {
    assert.throws(() => drawSubsets(items, 51, 1, 1));
  });
});
