/**
 * scan-retraction-trends.ts
 *
 * Question: across MANY venues, how do retractions line up with the other
 * metrics? Our 13 test venues are case studies; this looks at the population.
 *
 * Uses only the three local files (fast, no API calls):
 *   Part 1  Journals:    every Computer Science journal in SCImago, joined to
 *                        Retraction Watch by journal title.
 *   Part 2  Journals NOT in SCImago that have CS retractions (delisted or never indexed).
 *   Part 3  Conferences: every ICORE-ranked conference, joined to Retraction Watch
 *                        conference records by name (approximate text match).
 *
 * Raw values only. The summaries are simple counts per rank group.
 *
 * Run from the didcal-poc folder:  npx tsx src/scoring/scan-retraction-trends.ts
 * Writes: output/explore/cs-journals-retractions.csv
 *         output/explore/unindexed-journals-retractions.csv
 *         output/explore/core-conferences-retractions.csv
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

function parseCsv(text: string, delim = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const load = (path: string, delim = ',') => parseCsv(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''), delim);

/** Lowercase, "&" → "and", drop punctuation, collapse spaces. */
const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^the /, '');
const splitList = (s: string) => s.split(';').map((x) => x.replace(/^\+/, '').trim()).filter(Boolean);
const top = (t: Record<string, number>, n: number) =>
  Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join('; ');
const cell = (x: unknown) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (path: string, rows: unknown[][]) => writeFileSync(path, rows.map((r) => r.map(cell).join(',')).join('\n'));

// ── Retraction Watch: tally by normalized venue name ─────────────────────────
const rw = load('data/retraction_watch.csv');
const H = rw[0].map((h) => h.trim().toLowerCase());
const c = (n: string) => H.indexOf(n.toLowerCase());
const cJ = c('journal'), cNat = c('retractionnature'), cRea = c('reason'), cSub = c('subject'), cType = c('articletype'), cPub = c('publisher');

interface Tally { records: number; retractions: number; reasons: Record<string, number>; subjects: Set<string>; publishers: Set<string>; names: Set<string> }
const newTally = (): Tally => ({ records: 0, retractions: 0, reasons: {}, subjects: new Set(), publishers: new Set(), names: new Set() });
function add(t: Tally, r: string[]) {
  t.records++;
  if (/retraction/i.test(r[cNat] ?? '')) t.retractions++;
  for (const x of splitList(r[cRea] ?? '')) t.reasons[x] = (t.reasons[x] ?? 0) + 1;
  for (const x of splitList(r[cSub] ?? '')) t.subjects.add(x);
  t.publishers.add((r[cPub] ?? '').trim());
  t.names.add(r[cJ]);
}
const byJournal = new Map<string, Tally>();
const isConfRecord = (r: string[]) => /conference/i.test(r[cType] ?? '') || /conference|proceedings|symposium|workshop/i.test(r[cJ] ?? '');
const confNames = new Map<string, Tally>(); // keyed by normalized full name (editions not merged)
for (const r of rw.slice(1)) {
  const key = norm(r[cJ] ?? '');
  if (!key) continue;
  if (!byJournal.has(key)) byJournal.set(key, newTally());
  add(byJournal.get(key)!, r);
  if (isConfRecord(r)) {
    if (!confNames.has(key)) confNames.set(key, newTally());
    add(confNames.get(key)!, r);
  }
}
mkdirSync('output/explore', { recursive: true });

// ── Part 1: SCImago CS journals × Retraction Watch ───────────────────────────
const sci = load('data/scimago.csv', ';');
const sh = sci[0].map((h) => h.trim());
const s = (n: string) => sh.findIndex((h) => h.toLowerCase() === n.toLowerCase());
const sTitle = s('Title'), sType = s('Type'), sAreas = s('Areas'), sQ = s('SJR Best Quartile');
const keep = ['Title', 'Issn', 'Publisher', 'Country', 'SJR', 'SJR Best Quartile', 'H index', 'Total Docs. (3years)',
  'Citations / Doc. (2years)', 'Ref. / Doc.'].concat(sh.filter((h) => /^Total Docs\. \(\d{4}\)$/.test(h)));
const keepIdx = keep.map((k) => s(k));

const csJournals = sci.slice(1).filter((r) => /journal/i.test(r[sType] ?? '') && /computer science/i.test(r[sAreas] ?? ''));
const matchedKeys = new Set<string>();
const out1: unknown[][] = [[...keep, 'RW records', 'RW retractions', 'RW top reasons']];
const byQ: Record<string, { journals: number; withRetraction: number; retractions: number }> = {};
for (const r of csJournals) {
  const key = norm(r[sTitle] ?? '');
  const t = byJournal.get(key);
  if (t) matchedKeys.add(key);
  out1.push([...keepIdx.map((i) => (i >= 0 ? r[i] : '')), t?.records ?? 0, t?.retractions ?? 0, t ? top(t.reasons, 4) : '']);
  const q = r[sQ] || '(none)';
  byQ[q] ??= { journals: 0, withRetraction: 0, retractions: 0 };
  byQ[q].journals++;
  if (t && t.retractions > 0) { byQ[q].withRetraction++; byQ[q].retractions += t.retractions; }
}
writeCsv('output/explore/cs-journals-retractions.csv', out1);
console.log(`PART 1 — Computer Science journals in SCImago: ${csJournals.length}`);
console.log('  quartile | journals | with ≥1 retraction | total retractions');
for (const q of Object.keys(byQ).sort()) console.log(`  ${q.padEnd(8)} | ${String(byQ[q].journals).padStart(8)} | ${String(byQ[q].withRetraction).padStart(18)} | ${byQ[q].retractions}`);
const topJ = out1.slice(1).sort((a, b) => Number(b[keep.length + 1]) - Number(a[keep.length + 1])).slice(0, 15);
console.log('  Top 15 by retractions:');
for (const r of topJ) console.log(`    ${String(r[keep.length + 1]).padStart(5)}  ${r[0]}  [${r[5] || 'no quartile'}]`);

// ── Part 2: CS journals with retractions that are NOT in SCImago ─────────────
const out2: unknown[][] = [['journal', 'RW records', 'RW retractions', 'publishers', 'top reasons']];
const unindexed = [...byJournal.entries()]
  .filter(([k, t]) => !matchedKeys.has(k) && t.retractions > 0 && !confNames.has(k)
    && [...t.subjects].some((x) => /computer science/i.test(x)))
  .sort((a, b) => b[1].retractions - a[1].retractions);
for (const [, t] of unindexed) out2.push([[...t.names][0], t.records, t.retractions, [...t.publishers].join('; '), top(t.reasons, 4)]);
writeCsv('output/explore/unindexed-journals-retractions.csv', out2);
console.log(`\nPART 2 — CS-tagged journals with retractions but NOT in SCImago CS list: ${unindexed.length}`);
for (const [, t] of unindexed.slice(0, 15)) console.log(`    ${String(t.retractions).padStart(5)}  ${[...t.names][0]}  [${[...t.publishers][0]}]`);

// ── Part 3: ICORE conferences × Retraction Watch conference records ──────────
// core.csv has no header: id, title, acronym, edition, rank, flag, field codes...
const core = load('data/core.csv');
const strip = (t: string) => norm(t).replace(/^(acm|ieee|ifip|usenix|international|annual|the|joint|\s)+/g, '').trim();
const confList = [...confNames.entries()];
const out3: unknown[][] = [['acronym', 'title', 'rank', 'RW records', 'RW retractions', 'top reasons', 'matched RW names (sample)']];
const byRank: Record<string, { conferences: number; withRetraction: number; retractions: number }> = {};
for (const r of core) {
  const [, title, acronym, , rank] = r;
  const needle = strip(title ?? '');
  const t = newTally();
  if (needle.length >= 15) {
    for (const [name, tally] of confList) {
      if (name.includes(needle)) {
        t.records += tally.records; t.retractions += tally.retractions;
        for (const [k, v] of Object.entries(tally.reasons)) t.reasons[k] = (t.reasons[k] ?? 0) + v;
        for (const n of tally.names) t.names.add(n);
      }
    }
  }
  out3.push([acronym, title, rank, t.records, t.retractions, top(t.reasons, 4), [...t.names].slice(0, 3).join(' | ')]);
  const k = rank || '(blank)';
  byRank[k] ??= { conferences: 0, withRetraction: 0, retractions: 0 };
  byRank[k].conferences++;
  if (t.retractions > 0) { byRank[k].withRetraction++; byRank[k].retractions += t.retractions; }
}
writeCsv('output/explore/core-conferences-retractions.csv', out3);
console.log(`\nPART 3 — ICORE conferences: ${core.length} (name match is approximate)`);
console.log('  rank     | conferences | with ≥1 retraction | total retractions');
for (const k of Object.keys(byRank).sort()) console.log(`  ${k.padEnd(8)} | ${String(byRank[k].conferences).padStart(11)} | ${String(byRank[k].withRetraction).padStart(18)} | ${byRank[k].retractions}`);
const topC = out3.slice(1).sort((a, b) => Number(b[4]) - Number(a[4])).slice(0, 15);
console.log('  Top 15 by retractions:');
for (const r of topC) console.log(`    ${String(r[4]).padStart(5)}  ${r[0]} (${r[2]})  ${r[1]}`);

console.log('\nFiles written to output/explore/');
