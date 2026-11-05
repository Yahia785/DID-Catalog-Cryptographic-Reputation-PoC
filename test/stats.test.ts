import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarize } from '../src/bench/stats.js';

describe('summarize', () => {
  it('sample standard deviation (n - 1): the textbook example', () => {
    // 2 4 4 4 5 5 7 9: mean 5, sum of squares 32; population SD 2, sample SD sqrt(32 / 7)
    const s = summarize([2, 4, 4, 4, 5, 5, 7, 9])!;
    assert.equal(s.mean, 5);
    assert.ok(Math.abs(s.sd - Math.sqrt(32 / 7)) < 1e-12, `sd ${s.sd}`);
    assert.ok(Math.abs(s.sd - 2.138089935299395) < 1e-12);
  });

  it('two values, and order does not matter', () => {
    assert.ok(Math.abs(summarize([1, 3])!.sd - Math.SQRT2) < 1e-12);          // sqrt(((1-2)^2 + (3-2)^2) / 1)
    assert.equal(summarize([9, 2, 7, 4, 5, 4, 5, 4])!.sd, summarize([2, 4, 4, 4, 5, 5, 7, 9])!.sd);
  });

  it('one value has no spread (sd 0), identical values have sd 0', () => {
    assert.equal(summarize([42])!.sd, 0);
    assert.equal(summarize([3, 3, 3, 3])!.sd, 0);
  });

  it('the other fields are unchanged: n, mean, median, p95 (nearest rank), min, max', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);                    // 1..20
    const s = summarize(xs)!;
    assert.deepEqual({ n: s.n, mean: s.mean, median: s.median, p95: s.p95, min: s.min, max: s.max }, { n: 20, mean: 10.5, median: 10.5, p95: 19, min: 1, max: 20 });
    assert.equal(summarize([5, 1, 3])!.median, 3);
  });

  it('empty input gives null', () => {
    assert.equal(summarize([]), null);
  });

  it('does not change the input array', () => {
    const xs = [3, 1, 2];
    summarize(xs);
    assert.deepEqual(xs, [3, 1, 2]);
  });
});
