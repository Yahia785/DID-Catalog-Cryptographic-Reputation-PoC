import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { fetchJson, getJson, setRequestObserver, type RequestRecord } from '../src/shared/http.js';
import { slot, FAILED, type SnapshotFile } from '../src/scoring/snapshot-store.js';

/**
 * Collection must never turn a failed request into "no data".
 *   - fetchJson tells ok / not-found / failed apart (fetch is mocked, no network)
 *   - the formula 1.0 snapshot, run as a real process with every OpenAlex request failing,
 *     exits 1 and writes nothing, or with --allow-failures writes "failed" (not null)
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
let n = 0;
const freshUrl = () => `https://host${++n}.test/x`;   // a new host each time, so the politeness gap never delays a test

describe('fetchJson', () => {
  afterEach(() => { mock.restoreAll(); setRequestObserver(null); });

  it('ok: data and byte count', async () => {
    mock.method(globalThis, 'fetch', async () => json({ a: 1 }));
    const r = await fetchJson(freshUrl());
    assert.deepEqual(r, { status: 'ok', data: { a: 1 }, bytes: 7 });
  });

  it('404 is "not-found", not a failure', async () => {
    mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
    assert.deepEqual(await fetchJson(freshUrl()), { status: 'not-found' });
  });

  it('busy hosts are retried and then reported as failed', async () => {
    const calls = mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 429, headers: { 'retry-after': '0.001' } }));
    const r = await fetchJson(freshUrl(), { maxTries: 3 });
    assert.equal(r.status, 'failed');
    assert.match((r as any).reason, /gave up after 3 tries: HTTP 429/);
    assert.equal(calls.mock.callCount(), 3);
  });

  it('a server error recovers on retry', async () => {
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => (++calls === 1 ? new Response('', { status: 500, headers: { 'retry-after': '0.001' } }) : json({ ok: true })));
    const r = await fetchJson(freshUrl());
    assert.equal(r.status, 'ok');
    assert.equal(calls, 2);
  });

  it('network errors and HTML pages are failures', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error('socket hang up'); });
    const net = await fetchJson(freshUrl(), { maxTries: 1 });
    assert.equal(net.status, 'failed');
    assert.match((net as any).reason, /socket hang up/);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => new Response('<html>busy</html>', { status: 200 }));
    const html = await fetchJson(freshUrl(), { maxTries: 1 });
    assert.equal(html.status, 'failed');
    assert.match((html as any).reason, /HTML/);
  });

  it('other HTTP errors fail at once', async () => {
    const calls = mock.method(globalThis, 'fetch', async () => new Response('no', { status: 401 }));
    const r = await fetchJson(freshUrl());
    assert.deepEqual(r, { status: 'failed', reason: 'HTTP 401' });
    assert.equal(calls.mock.callCount(), 1);
  });

  it('getJson still returns the data, or null for not-found and for failures', async () => {
    mock.method(globalThis, 'fetch', async () => json([1, 2]));
    assert.deepEqual(await getJson(freshUrl()), [1, 2]);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
    assert.equal(await getJson(freshUrl()), null);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => new Response('no', { status: 403 }));
    mock.method(console, 'warn', () => {});
    assert.equal(await getJson(freshUrl()), null);
  });

  it('every request is reported with its timing, and retry waiting is not part of the duration', async () => {
    const seen: RequestRecord[] = [];
    setRequestObserver((r) => seen.push(r));
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => (++calls === 1 ? new Response('', { status: 503, headers: { 'retry-after': '0.05' } }) : json({ ok: 1 })));
    await fetchJson(freshUrl(), { tag: { source: 'test', venues: 3 } });
    assert.equal(seen.length, 1);
    const r = seen[0];
    assert.deepEqual(r.tag, { source: 'test', venues: 3 });
    assert.equal(r.attempts, 2);
    assert.equal(r.outcome, 'ok');
    assert.ok(r.bytes > 0);
    assert.ok(r.backoffMs >= 49, `backoff ${r.backoffMs}`);
    assert.ok(r.durationMs < r.backoffMs, `duration ${r.durationMs} should not include the ${r.backoffMs} ms wait`);
  });
});

describe('slot()', () => {
  const file = (v: unknown) => ({ source: { id: 'openalex' }, years: [], venues: { X: v } }) as unknown as SnapshotFile<{ a: number }>;
  it('returns data, null for not in the source, and throws for failed', () => {
    assert.deepEqual(slot(file({ a: 1 }), 'X'), { a: 1 });
    assert.equal(slot(file(null), 'X'), null);
    assert.equal(slot(undefined, 'X'), null);
    assert.throws(() => slot(file(FAILED), 'X'), /failed to collect/);
  });
});

describe('snapshot --formula=1.0 with failing OpenAlex requests', () => {
  const root = process.cwd();
  const run = (cwd: string, ...extra: string[]) => {
    try {
      const stdout = execFileSync(process.execPath, [
        path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--import', pathToFileURL(path.join(root, 'test/helpers/mock-fetch.mjs')).href,
        path.join(root, 'src/scoring/snapshot.ts'), '--formula=1.0', ...extra,
      ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, stdout };
    } catch (e: any) {
      return { status: e.status as number, stdout: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
  };
  /** A project folder with empty (header-only) copies of the three CSVs: only OpenAlex has anything to fetch. */
  const stubProject = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap1-'));
    fs.mkdirSync(path.join(tmp, 'data'));
    fs.writeFileSync(path.join(tmp, 'data/core.csv'), '');
    fs.writeFileSync(path.join(tmp, 'data/scimago.csv'), 'Rank;Sourceid;Title;Type;Issn;SJR;SJR Best Quartile;H index;Total Docs. (2025);Total Docs. (3years);Citations / Doc. (2years);Categories;Areas\n');
    fs.writeFileSync(path.join(tmp, 'data/retraction_watch.csv'), 'Record ID,Title,Journal,RetractionNature,Reason,RetractionDate\n');
    return tmp;
  };

  it('without --allow-failures: exit code 1, the failures are listed, nothing is written as a snapshot', () => {
    const tmp = stubProject();
    const r = run(tmp);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /value\(s\) failed to collect/);
    assert.match(r.stdout, /openalex \/ S&P: gave up after 5 tries: HTTP 429/);
    assert.match(r.stdout, /No snapshot written/);
    assert.equal(fs.existsSync(path.join(tmp, 'data/snapshots')), false);
    const bench = JSON.parse(fs.readFileSync(path.join(tmp, 'output/bench', fs.readdirSync(path.join(tmp, 'output/bench'))[0]), 'utf8'));
    assert.ok(bench.failures.length > 90);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('with --allow-failures: saved as "failed" (not null) and listed in index.json', () => {
    const tmp = stubProject();
    const r = run(tmp, '--dir=t', '--allow-failures');
    assert.equal(r.status, 0, r.stdout);
    const dir = path.join(tmp, 'data/snapshots/t');
    const oa = JSON.parse(fs.readFileSync(path.join(dir, 'openalex.json'), 'utf8'));
    assert.equal(oa.venues['S&P'], 'failed');
    assert.equal(oa.venues['TIFS'], 'failed');
    assert.equal(oa.venues['ACNS'], null);            // no OpenAlex id in the registry: not asked, so genuinely "no data"
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    assert.equal(index.formula, '1.0');
    assert.ok(index.failures.length > 90);
    assert.deepEqual(index.failures[0], { source: 'openalex', venue: index.failures[0].venue, reason: index.failures[0].reason });
    assert.ok(fs.existsSync(path.join(dir, 'icore.json')));
    assert.ok(fs.existsSync(path.join(dir, 'retraction-watch.json')));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
