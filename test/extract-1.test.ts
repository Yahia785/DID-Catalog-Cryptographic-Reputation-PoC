import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  extractIcore, extractRetractionWatch, extractScimago, parseIcore, parseRetractionWatch, parseScimago, rwDateToIso,
} from '../src/scoring/extract-1.js';
import { VENUES } from '../src/venues/registry.js';

/** The extraction functions on small hand-made files, and a regression check against the real snapshot. */

describe('Retraction Watch dates', () => {
  it('month/day/year with a time becomes YYYY-MM-DD', () => {
    assert.equal(rwDateToIso('4/15/2026 0:00'), '2026-04-15');
    assert.equal(rwDateToIso('12/3/2019 10:05'), '2019-12-03');
    assert.equal(rwDateToIso('1/1/1900 0:00'), '1900-01-01');
    assert.equal(rwDateToIso('2026-04-15'), null);
    assert.equal(rwDateToIso('13/1/2020 0:00'), null);      // month 13 is not a month: it would be day-first
    assert.equal(rwDateToIso(''), null);
    assert.equal(rwDateToIso(undefined), null);
  });
});

describe('extraction from small files', () => {
  it('ICORE: row by coreId and the edition', () => {
    const f = parseIcore('12,ACM CCS,CCS,ICORE2026,A*,Yes,4604,,\r\n127,"Annual Conference on Privacy, Security and Trust",PST,ICORE2026,C,No,4604,,\r\n');
    assert.equal(f.edition, 'ICORE2026');
    assert.deepEqual(extractIcore(f, { coreId: '127' }), { coreId: '127', title: 'Annual Conference on Privacy, Security and Trust', acronym: 'PST', edition: 'ICORE2026', rank: 'C' });
    assert.equal(extractIcore(f, { coreId: '999' }), null);
  });

  it('SCImago: row by Sourceid, decimal commas, the edition year from the header', () => {
    const csv = 'Rank;Sourceid;Title;Type;Issn;SJR;SJR Best Quartile;H index;Total Docs. (2025);Total Docs. (3years);Citations / Doc. (2years);Categories;Areas\n'
      + '1;100;"Journal A";journal;"15424863, 00079235";2,193;Q1;195;48;1437;9,71;"Software (Q1)";"Computer Science"\n'
      + '2;200;"Journal B";journal;;-;-;;;;;;\n';
    const f = parseScimago(csv);
    assert.equal(f.edition, 'SJR 2025');
    assert.deepEqual(extractScimago(f, { sourceid: '100' }), {
      sourceid: '100', title: 'Journal A', sjr: 2.193, quartile: 'Q1', hIndex: 195, totalDocs3y: 1437, citesPerDoc2y: 9.71, categories: 'Software (Q1)', issn: '15424863, 00079235',
    });
    assert.equal(extractScimago(f, { sourceid: '200' })!.sjr, null);
    assert.equal(extractScimago(f, { sourceid: '300' }), null);
  });

  const rw = 'Record ID,Title,Journal,RetractionDate,RetractionNature,Reason\n'
    + '1,t,Security and Communication Networks,1/10/2023 0:00,Retraction,+Fake Peer Review;Concerns/Issues about Article;\n'
    + '2,t,Security and Communication Networks,3/5/2024 0:00,Correction,\n'
    + '3,t,Security and Communication Networks,9/19/2026 0:00,Retraction,Fake Peer Review;\n'
    + '4,t,IEEE Symposium on Security and Privacy (European),2/2/2022 0:00,Retraction,\n';

  it('Retraction Watch: matches the Journal column, counts only Retraction rows, knows its as-of date', () => {
    const f = parseRetractionWatch(rw);
    assert.equal(f.cutoff, '2026-09-19');
    assert.deepEqual(extractRetractionWatch(f, { rwMatch: '^security and communication networks' }), {
      records: 3, retractions: 2, byYear: { 2023: 1, 2024: 1, 2026: 1 }, topReasons: { 'Fake Peer Review': 2, 'Concerns/Issues about Article': 1 },
    });
    assert.equal(extractRetractionWatch(f, { rwMatch: 'security and privacy', rwExclude: 'european' }).records, 0);
    assert.equal(extractRetractionWatch(f, { rwMatch: 'security and privacy' }).retractions, 1);
  });

  it('Retraction Watch with a cutoff: only rows dated on or before it', () => {
    const f = parseRetractionWatch(rw);
    const rule = { rwMatch: '^security and communication networks' };
    assert.equal(extractRetractionWatch(f, { ...rule, cutoff: '2026-09-19' }).retractions, 2);   // the cutoff day itself counts
    assert.equal(extractRetractionWatch(f, { ...rule, cutoff: '2026-09-18' }).retractions, 1);
    assert.equal(extractRetractionWatch(f, { ...rule, cutoff: '2022-12-31' }).retractions, 0);
    assert.equal(extractRetractionWatch(f, { ...rule, cutoff: '2022-12-31' }).records, 0);
  });
});

// ── regression against the real files and the real snapshot (skipped where they are not present) ──
const SNAP = 'data/snapshots/f1-2026-10-28';
const haveFiles = ['data/core.csv', 'data/scimago.csv', 'data/retraction_watch.csv', `${SNAP}/icore.json`, `${SNAP}/scimago.json`, `${SNAP}/retraction-watch.json`].every((p) => fs.existsSync(p));

describe('extraction reproduces the formula 1.0 snapshot (data/ is used here only as a regression test, never as evidence)', { skip: !haveFiles && 'data/ or the snapshot is not present' }, () => {
  it('0 mismatches over all 100 venues and the three file sources', () => {
    const load = (id: string) => JSON.parse(fs.readFileSync(path.join(SNAP, `${id}.json`), 'utf8')).venues as Record<string, any>;
    const [snapIcore, snapScimago, snapRw] = [load('icore'), load('scimago'), load('retraction-watch')];
    const icore = parseIcore(fs.readFileSync('data/core.csv', 'utf8'));
    const scimago = parseScimago(fs.readFileSync('data/scimago.csv', 'utf8'));
    const retraction = parseRetractionWatch(fs.readFileSync('data/retraction_watch.csv', 'utf8'));

    const mismatches: string[] = [];
    let compared = 0;
    // every key the snapshot recorded must be reproduced exactly (the snapshot may lack newer fields such as issn)
    const compare = (source: string, key: string, snap: any, got: any) => {
      compared++;
      if (snap === null || snap === undefined) { if (got !== null) mismatches.push(`${source} ${key}: snapshot has none, extraction found a row`); return; }
      if (got === null) { mismatches.push(`${source} ${key}: snapshot has a row, extraction found none`); return; }
      for (const k of Object.keys(snap)) if (JSON.stringify(snap[k]) !== JSON.stringify(got[k])) mismatches.push(`${source} ${key}.${k}: snapshot ${JSON.stringify(snap[k])}, extraction ${JSON.stringify(got[k])}`);
    };
    for (const v of VENUES) {
      if (v.type === 'conference') compare('icore', v.key, snapIcore[v.key], v.coreId ? extractIcore(icore, { coreId: v.coreId }) : null);
      compare('scimago', v.key, snapScimago[v.key], v.scimagoId ? extractScimago(scimago, { sourceid: v.scimagoId }) : null);
      compare('retraction-watch', v.key, snapRw[v.key], v.rwMatch ? extractRetractionWatch(retraction, { rwMatch: v.rwMatch, rwExclude: v.rwExclude }) : null);
    }
    console.log(`  regression: ${compared} venue values compared (icore ${VENUES.filter((v) => v.type === 'conference').length}, scimago ${VENUES.length}, retraction-watch ${VENUES.length}), ${mismatches.length} mismatch(es)`);
    assert.deepEqual(mismatches, []);
    assert.equal(compared, 50 + 100 + 100);
  });

  it('the file\'s as-of date is the cutoff, and applying it changes nothing', () => {
    const retraction = parseRetractionWatch(fs.readFileSync('data/retraction_watch.csv', 'utf8'));
    assert.match(retraction.cutoff!, /^\d{4}-\d{2}-\d{2}$/);
    for (const v of VENUES.filter((x) => x.rwMatch)) {
      assert.deepEqual(extractRetractionWatch(retraction, { rwMatch: v.rwMatch!, rwExclude: v.rwExclude, cutoff: retraction.cutoff! }), extractRetractionWatch(retraction, { rwMatch: v.rwMatch!, rwExclude: v.rwExclude }), v.key);
    }
  });
});
