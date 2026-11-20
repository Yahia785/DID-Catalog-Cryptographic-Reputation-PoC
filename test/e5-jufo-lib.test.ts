import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coreName, levelOf, nameScore, normalizeIssn, normalizeName, outcomeOf, overlap, panelsOf, pickForDetail, rankCandidates, toCandidate, tokens, typeOf, type Candidate } from '../src/analysis/e5-jufo-lib.js';

describe('name and ISSN normalisation', () => {
  it('lower case, no accents, & as and, punctuation removed', () => {
    assert.equal(normalizeName('IEEE Security & Privacy'), 'ieee security and privacy');
    assert.equal(normalizeName('  Réseaux, Systèmes -- (RS) '), 'reseaux systemes rs');
  });
  it('tokens drop stop words', () => assert.deepEqual(tokens('Conference on the Theory of Computing'), ['conference', 'theory', 'computing']));
  it('ISSN: with or without hyphen, x upper-cased, junk rejected', () => {
    assert.equal(normalizeIssn('0028-0836'), '0028-0836'); assert.equal(normalizeIssn('2169 3536'), '2169-3536');
    assert.equal(normalizeIssn('1748-068x'), '1748-068X'); assert.equal(normalizeIssn('12345'), null); assert.equal(normalizeIssn(''), null); assert.equal(normalizeIssn(undefined), null);
  });
  it('type and panels', () => {
    assert.equal(typeOf('Lehti/sarja'), 'series'); assert.equal(typeOf('Konferenssi'), 'conference'); assert.equal(typeOf('Kustantaja'), 'publisher'); assert.equal(typeOf('x'), 'unknown');
    assert.deepEqual(panelsOf(';1 Humanistiset;9 Muut;'), ['1 Humanistiset', '9 Muut']); assert.deepEqual(panelsOf(undefined), []);
  });
  it('level: the Level field, else the newest year in the history', () => {
    assert.equal(levelOf({ Jufo_ID: '1', Name: 'x', Level: '2' }), '2');
    assert.equal(levelOf({ Jufo_ID: '1', Name: 'x', Jufo_history: '2024:1;2025:2;' }), '2');
    assert.equal(levelOf({ Jufo_ID: '1', Name: 'x' }), '');
  });
  it('coreName strips leading organisation and ordinal words', () => {
    assert.equal(coreName('IEEE International Conference on Cloud Computing'), 'Conference on Cloud Computing');
    assert.equal(coreName('12th Annual Symposium on X'), 'Symposium on X');
  });
});

describe('name scoring', () => {
  it('exact after normalisation is 100', () => assert.deepEqual(nameScore('IEEE Symposium on Security and Privacy', 'IEEE Symposium on security and privacy'), { score: 100, basis: 'exact name' }));
  it('partial by word overlap, unrelated is 0', () => {
    const p = nameScore('Applied Cryptography and Network Security', 'International conference on applied cryptography and network security');
    assert.equal(p.basis, 'partial name'); assert.ok(p.score > 40 && p.score < 100);
    assert.deepEqual(nameScore('Applied Cryptography and Network Security', 'European conference on computer vision'), { score: 0, basis: null });
  });
  it('overlap: jaccard and containment', () => {
    assert.deepEqual(overlap(['a', 'b'], ['a', 'b', 'c']), { jaccard: 2 / 3, contained: true });
    assert.deepEqual(overlap([], ['a']), { jaccard: 0, contained: false });
  });
  it('a longer name containing the target does not beat the exact one', () => {
    const exact = nameScore('Security and Privacy', 'Security and privacy').score, longer = nameScore('Security and Privacy', 'IEEE European symposium on security and privacy workshops').score;
    assert.ok(exact > longer);
  });
});

const rec = (over: object) => ({ Jufo_ID: '1', Name: 'IEEE access', Abbreviation: '', Type: 'Lehti/sarja', Level: '1', Field: ';9 Muut;', ISSN1: '2169-3536', ISSN2: '', ISSNL: '2169-3536', ...over });

describe('candidates: basis, strong, ranking', () => {
  it('equal ISSN makes a candidate strong, and ranks above a name-only match', () => {
    const t = { name: 'IEEE Access', key: 'Access', issn: '2169-3536' };
    const a = toCandidate(rec({}), t);
    assert.deepEqual(a.basis, ['ISSN', 'exact name']); assert.equal(a.strong, true); assert.deepEqual(a.issns, ['2169-3536']); assert.deepEqual(a.panels, ['9 Muut']);
    const b = toCandidate(rec({ Jufo_ID: '2', Name: 'IEEE Access', ISSN1: '1111-1111', ISSNL: '' }), t);
    assert.equal(b.strong, false);
    assert.equal(rankCandidates([b, a])[0].jufoId, '1');
  });
  it('a name match alone is never strong', () => {
    const c = toCandidate(rec({ ISSN1: '', ISSNL: '' }), { name: 'IEEE Access', key: 'Access', issn: '2169-3536' });
    assert.equal(c.strong, false); assert.deepEqual(c.basis, ['exact name']);
  });
  it('equal OpenAlex id makes a candidate strong; a different one does not', () => {
    const t = { name: 'Other name', key: 'ZZ', openalexId: 'S123' };
    assert.equal(toCandidate(rec({ OpenAlex_ID: 'https://openalex.org/S123' }), t).strong, true);
    assert.equal(toCandidate(rec({ OpenAlex_ID: 'S999' }), t).strong, false);
  });
  it('abbreviation equal to the registry key is a basis, not strong', () => {
    const c = toCandidate(rec({ Name: 'Asia Joint Conference', Abbreviation: 'ACNS', ISSN1: '', ISSNL: '' }), { name: 'Applied Cryptography and Network Security', key: 'ACNS' });
    assert.deepEqual(c.basis, ['abbreviation']); assert.equal(c.strong, false);
  });
  it('rank: best first, ties by lower id, drops no-basis and duplicates, keeps at most 3', () => {
    const mk = (id: string, score: number, basis: Candidate['basis'] = ['partial name']): Candidate => ({ jufoId: id, name: id, abbreviation: '', type: 'series', level: '', panels: [], issns: [], openalexId: null, publisher: '', basis, strong: false, score });
    const r = rankCandidates([mk('9', 50), mk('3', 50), mk('7', 80), mk('5', 10, []), mk('8', 60), mk('7', 20)]);
    assert.deepEqual(r.map((c) => c.jufoId), ['7', '8', '3']);
  });
  it('pickForDetail takes the best name matches only', () => {
    const hits = [{ id: '1', name: 'European conference on computer vision' }, { id: '2', name: 'ACM conference on computer and communications security' }, { id: '3', name: 'Conference on computer and communications security' }];
    assert.deepEqual(pickForDetail(hits, 'ACM Conference on Computer and Communications Security', 2), ['2', '3']);
  });
  it('outcome: strong, candidates only, nothing found, failed', () => {
    const c = (strong: boolean) => ({ strong }) as Candidate;
    assert.equal(outcomeOf([c(false), c(true)], false), 'strong'); assert.equal(outcomeOf([c(false)], true), 'candidates only');
    assert.equal(outcomeOf([], false), 'nothing found'); assert.equal(outcomeOf([], true), 'failed');
  });
});
