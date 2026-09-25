/**
 * scan-rw-conferences.ts
 *
 * Question: which conferences have retractions in the Retraction Watch database?
 * Instead of guessing venues, scan the whole file and let the data answer.
 *
 * A record counts as a conference record if EITHER
 *   - its ArticleType mentions "Conference", or
 *   - its Journal field looks like proceedings (conference, proceedings, symposium, workshop).
 *
 * Conference names usually include the year and edition ("2019 5th International
 * Conference on X"), so names are normalized (years, ordinals, "Proceedings of the"
 * removed) to group all editions of the same conference together.
 *
 * Run from the didcal-poc folder:  npx tsx src/scoring/scan-rw-conferences.ts
 * Reads:  data/retraction_watch.csv
 * Writes: output/explore/rw-conferences.csv  (one row per conference, most retractions first)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
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

/** Group all editions of a conference under one name. */
function normalize(name: string): string {
  return name
    .replace(/proceedings of (the )?/gi, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\b\d+(st|nd|rd|th)\b/gi, '')
    .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi, '')
    .replace(/[,:\-–]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const splitList = (s: string) => s.split(';').map((x) => x.replace(/^\+/, '').trim()).filter(Boolean);
const top = (t: Record<string, number>, n: number) =>
  Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join('; ');

const rows = parseCsv(readFileSync('data/retraction_watch.csv', 'utf8').replace(/^\uFEFF/, ''));
const header = rows[0].map((h) => h.trim());
const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
const cJournal = col('Journal'), cType = col('ArticleType'), cNature = col('RetractionNature'), cReason = col('Reason');
const cSubject = col('Subject'), cPublisher = col('Publisher'), cDate = col('RetractionDate');
const body = rows.slice(1);

const looksLikeProceedings = /conference|proceedings|symposium|workshop/i;
const conf = body.filter((r) =>
  /conference/i.test(r[cType] ?? '') || looksLikeProceedings.test(r[cJournal] ?? ''));

interface Group {
  names: Set<string>; count: number; retractions: number;
  publishers: Record<string, number>; subjects: Record<string, number>;
  reasons: Record<string, number>; years: Record<string, number>;
}
const groups = new Map<string, Group>();
const allReasons: Record<string, number> = {};
const allSubjects: Record<string, number> = {};

for (const r of conf) {
  const key = normalize(r[cJournal] ?? '') || '(blank)';
  if (!groups.has(key)) groups.set(key, { names: new Set(), count: 0, retractions: 0, publishers: {}, subjects: {}, reasons: {}, years: {} });
  const g = groups.get(key)!;
  g.names.add(r[cJournal]);
  g.count++;
  if (/retraction/i.test(r[cNature] ?? '')) g.retractions++;
  const pub = (r[cPublisher] ?? '').trim();
  g.publishers[pub] = (g.publishers[pub] ?? 0) + 1;
  for (const s of splitList(r[cSubject] ?? '')) { g.subjects[s] = (g.subjects[s] ?? 0) + 1; allSubjects[s] = (allSubjects[s] ?? 0) + 1; }
  for (const s of splitList(r[cReason] ?? '')) { g.reasons[s] = (g.reasons[s] ?? 0) + 1; allReasons[s] = (allReasons[s] ?? 0) + 1; }
  const y = (r[cDate] ?? '').match(/(19|20)\d{2}/)?.[0];
  if (y) g.years[y] = (g.years[y] ?? 0) + 1;
}

const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
const isCompSci = (g: Group) => Object.keys(g.subjects).some((s) => /computer|engineering|electrical|information/i.test(s));

console.log(`Records in file: ${body.length}`);
console.log(`Conference records: ${conf.length} (${((conf.length / body.length) * 100).toFixed(1)}%)`);
console.log(`Distinct conferences (editions grouped): ${groups.size}`);
console.log(`Of those, tagged computer science / engineering: ${sorted.filter(([, g]) => isCompSci(g)).length}`);
console.log(`\nTop subjects across conference records: ${top(allSubjects, 8)}`);
console.log(`Top reasons across conference records: ${top(allReasons, 8)}`);

console.log('\nTop 25 CS/engineering conferences by records:');
for (const [key, g] of sorted.filter(([, g]) => isCompSci(g)).slice(0, 25)) {
  console.log(`  ${String(g.count).padStart(5)}  ${key}  [${top(g.publishers, 1)}]`);
}

mkdirSync('output/explore', { recursive: true });
const cell = (x: unknown) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const out = [['conference (normalized)', 'records', 'retractions', 'CS/engineering?', 'publisher', 'top reasons', 'retraction years', 'example names']];
for (const [key, g] of sorted) {
  out.push([key, String(g.count), String(g.retractions), isCompSci(g) ? 'yes' : 'no', top(g.publishers, 2),
    top(g.reasons, 5), top(g.years, 6), [...g.names].slice(0, 3).join(' | ')]);
}
writeFileSync('output/explore/rw-conferences.csv', out.map((r) => r.map(cell).join(',')).join('\n'));
console.log(`\nFull list: output/explore/rw-conferences.csv (${sorted.length} conferences)`);