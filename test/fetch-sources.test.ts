import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { contentHash } from '../src/scoring/extract-1.js';
import { issueScore } from '../src/scoring/issue-score.js';
import type { Identity, ProvenanceManifest, ReputationScore, SourceSnapshot } from '../src/shared/types.js';
import { T_SIGNED, makeFixtures } from '../src/testing/fixtures.js';
import { fetchSources, planFetches } from '../src/verification/fetch-sources.js';
import { icoreExportUrl, rwRawUrl, type Download } from '../src/verification/provider-urls.js';

/** The helper that fetches provider files for a reader: what it asks for, and that it never writes into data/. */

const ICORE = '12,ACM CCS,CCS,ICORE2026,A*\n127,PST,PST,ICORE2026,C\n';
const RW = 'Record ID,Title,Journal,RetractionDate,RetractionNature,Reason\n1,t,J,1/1/2024 0:00,Retraction,x\n';
const COMMIT = '827665ab699e4a798060b95c40268de417b7f2e1';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const dirs: string[] = [];
const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const entry = (id: string, extra: Partial<SourceSnapshot> = {}): SourceSnapshot => ({ id, name: id, access: 'csv', url: '', retrievedAt: '', file: '', ...extra });
const manifest = (sources: SourceSnapshot[]): ProvenanceManifest => ({
  venueDID: 'did:plc:v', venueKey: 'X', venueType: 'conference', platformDID: 'did:plc:p', formula: '', formulaVersion: '1.0', sources, inputs: [], computedAt: T_SIGNED,
});
const standard = () => manifest([
  entry('icore', { edition: 'ICORE2026', sha256: sha(ICORE), contentHash: contentHash('icore', ICORE), verifiable: 'file', match: { coreId: '127' } }),
  entry('retraction-watch', { sha256: sha(RW), verifiable: 'file', match: { rwMatch: 'x', cutoff: '2026-10-15', commit: COMMIT } }),
  entry('scimago', { edition: 'SJR 2025', verifiable: 'file' }),
  entry('openalex', { access: 'api', verifiable: 'live' }),
]);

describe('planFetches', () => {
  it('asks for the ICORE edition, the pinned Retraction Watch commit, and lists SCImago for the manual steps', () => {
    const p = planFetches([standard(), standard()]);
    assert.equal(p.icore!.url, icoreExportUrl('ICORE2026'));
    assert.match(p.icore!.url, /source=ICORE2026.*do=Export/);
    assert.equal(p.retractionWatch!.url, rwRawUrl(COMMIT));
    assert.match(p.retractionWatch!.url, new RegExp(`/-/raw/${COMMIT}/retraction_watch.csv$`));      // the commit SHA, not "main"
    assert.deepEqual(p.scimago, { edition: 'SJR 2025' });
    assert.deepEqual(p.notes, []);
  });

  it('says so when the credentials pin no commit, or name several', () => {
    const noCommit = standard();
    noCommit.sources[1] = entry('retraction-watch', { verifiable: 'file', match: { rwMatch: 'x', cutoff: '2026-10-15' } });
    const p = planFetches([noCommit]);
    assert.equal(p.retractionWatch, undefined);
    assert.match(p.notes.join(' '), /do not pin a Retraction Watch commit/);
    const other = standard();
    other.sources[1] = entry('retraction-watch', { match: { rwMatch: 'x', cutoff: 'c', commit: 'f'.repeat(40) } });
    assert.match(planFetches([standard(), other]).notes.join(' '), /several Retraction Watch commits/);
    const two = standard();
    two.sources[0] = entry('icore', { edition: 'ICORE2025' });
    assert.match(planFetches([standard(), two]).notes.join(' '), /several ICORE editions/);
  });
});

describe('fetchSources', () => {
  let platform: Identity, journalVenue: Identity;
  before(async () => { ({ platform, journalVenue } = await makeFixtures()); });

  async function credentials(m: ProvenanceManifest) {
    const dir = mkdir();
    const score: ReputationScore = {
      payload: { type: 'VenueScore', platform: platform.did, venue: journalVenue.did, venueType: 'conference', verificationMethod: `${platform.did}#signing-1`, score: null, class: 'Work in progress', confidence: { present: 0, total: 3 }, breakdown: {}, flags: [], formulaVersion: '1.0', computedAt: T_SIGNED },
      manifest: { ...m, venueDID: journalVenue.did, platformDID: platform.did },
    };
    fs.writeFileSync(path.join(dir, 'x.vc.jwt'), (await issueScore(platform, score)).jwt);
    return dir;
  }
  /** A downloader that serves canned content instead of the network, and records what it was asked for. */
  const fake = (served: Record<string, string>, asked: string[] = []): typeof import('../src/verification/provider-urls.js').downloadTo => async (url, file) => {
    asked.push(url);
    const text = served[url];
    if (text === undefined) throw new Error(`unexpected URL ${url}`);
    fs.writeFileSync(file, text);
    return { url, file, bytes: Buffer.byteLength(text), ms: 12.5, sha256: sha(text), status: 200, attempts: 1 } satisfies Download;
  };

  it('downloads ICORE and the pinned Retraction Watch file into --out and compares them with the credentials', async () => {
    const out = mkdir(), asked: string[] = [];
    const reordered = '127,PST,PST,ICORE2026,C\n12,ACM CCS,CCS,ICORE2026,A*\n';       // the same rows in another order
    const r = await fetchSources(await credentials(standard()), out, fake({ [icoreExportUrl('ICORE2026')]: reordered, [rwRawUrl(COMMIT)]: RW }, asked));
    assert.deepEqual(asked, [icoreExportUrl('ICORE2026'), rwRawUrl(COMMIT)]);
    assert.equal(fs.readFileSync(path.join(out, 'icore.csv'), 'utf8'), reordered);
    assert.equal(fs.readFileSync(path.join(out, 'retraction_watch.csv'), 'utf8'), RW);
    const [ic, rw] = r.files;
    assert.equal(ic.sameBytesAsCredentials, false);          // another byte order ...
    assert.equal(ic.sameContentAsCredentials, true);         // ... but the same content
    assert.equal(rw.sameBytesAsCredentials, true);           // the pinned file is byte-identical
    assert.equal(rw.ms, 12.5);
  });

  it('prints the manual steps for SCImago (a script cannot pass its browser check)', async () => {
    const r = await fetchSources(await credentials(standard()), mkdir(), fake({ [icoreExportUrl('ICORE2026')]: ICORE, [rwRawUrl(COMMIT)]: RW }));
    const text = r.manualSteps.join('\n');
    assert.match(text, /cannot be downloaded by a script/);
    assert.match(text, /scimagojr.com\/journalrank.php/);
    assert.match(text, /Year to 2025/);
    assert.match(text, /scimago.csv/);
  });

  it('never writes into data/ (the issuer\'s own copies)', async () => {
    const creds = await credentials(standard());
    const asked: string[] = [];
    await assert.rejects(() => fetchSources(creds, 'data/l3', fake({}, asked)), /inside data\//);
    await assert.rejects(() => fetchSources(creds, path.resolve('data'), fake({}, asked)), /inside data\//);
    assert.deepEqual(asked, []);                              // refused before anything was fetched
    assert.equal(fs.existsSync('data/l3'), false);
  });

  it('a folder without credentials is an error', async () => {
    await assert.rejects(() => fetchSources(mkdir(), mkdir(), fake({})), /no \*\.vc\.jwt credentials/);
  });
});
