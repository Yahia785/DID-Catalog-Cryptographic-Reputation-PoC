import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../shared/csv.js';
import { decodeScoreVC } from '../scoring/read-vc.js';
import { VENUES } from '../venues/registry.js';
import {
  CCF_GRADES, JUFO_LEVELS, NOT_LISTED, ccfOrdinal, crossTable, effectiveListed, jufoOrdinal, kendallTauB, ourOrdinal, ourRowOrder,
  type CrossTable, type Tau, type VenueKind,
} from './e5-lib.js';

/**
 * E5, comparison with two expert lists that were not inputs to the formula: CCF (7th edition, 2026) and JUFO.
 * Reads the 100 score credentials (decoded, not verified) and the hand-checked match table. No network.
 *
 *   npx tsx src/analysis/e5-expert-lists.ts
 */

const CSV = 'data/lists/e5-matches-draft-v2.csv';
const SCORES_DIR = 'output/scores/f1';
const OUT_DIR = 'output/analysis';
const TYPES: VenueKind[] = ['conference', 'journal'];

interface Row {
  key: string; group: string; type: VenueKind; ourClass: string; ourPoints: number | null;
  ccf: string | null; jufo: string | null;      // grade/level if (effectively) listed, else null
}
interface ListDef { id: 'ccf' | 'jufo'; label: string; grades: string[]; ord: (g: string) => number | null }
const LISTS: ListDef[] = [
  { id: 'ccf', label: 'CCF', grades: CCF_GRADES, ord: ccfOrdinal },
  { id: 'jufo', label: 'JUFO', grades: JUFO_LEVELS, ord: jufoOrdinal },
];

// ── load ──
function load(): { rows: Row[]; rejected: { key: string; list: string; grade: string }[] } {
  const [hd, ...data] = readCsv(CSV);
  const col = (n: string) => { const i = hd.indexOf(n); if (i < 0) throw new Error(`${CSV}: column "${n}" missing`); return i; };
  const c = { key: col('key'), group: col('group'), type: col('type'), cs: col('ccf_status'), cg: col('ccf_grade'),
    js: col('jufo_status'), jl: col('jufo_level'), cc: col('confirm_ccf (yes/no)'), cj: col('confirm_jufo (yes/no)') };
  const rows: Row[] = [], rejected: { key: string; list: string; grade: string }[] = [];
  const seen = new Set<string>();
  for (const r of data) {
    const key = r[c.key];
    const v = VENUES.find((x) => x.key === key);
    if (!v) throw new Error(`CSV key "${key}" is not in the registry`);
    if (seen.has(key)) throw new Error(`duplicate CSV key "${key}"`);
    seen.add(key);
    if (v.type !== r[c.type]) throw new Error(`${key}: CSV type ${r[c.type]} vs registry ${v.type}`);
    const file = path.join(SCORES_DIR, `${v.slug}.vc.jwt`);
    const s = decodeScoreVC(fs.readFileSync(file, 'utf8')).subject;
    if (s.venueType !== v.type) throw new Error(`${key}: credential venueType ${s.venueType} vs registry ${v.type}`);
    const ccf = effectiveListed(r[c.cs], r[c.cc]), jufo = effectiveListed(r[c.js], r[c.cj]);
    if (ccf.rejected) rejected.push({ key, list: 'CCF', grade: r[c.cg] });
    if (jufo.rejected) rejected.push({ key, list: 'JUFO', grade: r[c.jl] });
    rows.push({
      key, group: r[c.group], type: v.type, ourClass: String(s.class), ourPoints: typeof s.score === 'number' ? s.score : null,
      ccf: ccf.listed ? r[c.cg] : null, jufo: jufo.listed ? r[c.jl] : null,
    });
  }
  const missing = VENUES.filter((v) => !seen.has(v.key)).map((v) => v.key);
  if (missing.length) throw new Error(`registry venues missing from the CSV: ${missing.join(', ')}`);
  return { rows, rejected };
}

// ── analysis ──
interface Block {
  list: string; type: VenueKind;
  counts: { sample: number; listed: number; notListed: number; listedNotOnOurScale: number; onBothScales: number };
  table: CrossTable;
  tau: { all: Tau; sampled: Tau };
}
const tauOf = (type: VenueKind, list: ListDef, rows: Row[]): Tau => {
  const x: number[] = [], y: number[] = [];
  for (const r of rows) {
    const g = r[list.id]; if (g === null) continue;
    const o = ourOrdinal(type, r.ourClass), t = list.ord(g);
    if (o === null || t === null) continue;
    x.push(o); y.push(t);
  }
  return kendallTauB(x, y);
};
function block(list: ListDef, type: VenueKind, all: Row[]): Block {
  const rows = all.filter((r) => r.type === type);
  const listed = rows.filter((r) => r[list.id] !== null);
  const off = listed.filter((r) => ourOrdinal(type, r.ourClass) === null);
  return {
    list: list.label, type,
    counts: { sample: rows.length, listed: listed.length, notListed: rows.length - listed.length, listedNotOnOurScale: off.length, onBothScales: listed.length - off.length },
    table: crossTable(rows.map((r) => ({ ours: r.ourClass, theirs: r[list.id] ?? NOT_LISTED })), ourRowOrder(type), list.grades),
    tau: { all: tauOf(type, list, rows), sampled: tauOf(type, list, rows.filter((r) => r.group === 'sample')) },
  };
}
function ccfShare(rows: Row[], type: VenueKind) {
  const rs = rows.filter((r) => r.type === type);
  return ourRowOrder(type).map((cls) => {
    const g = rs.filter((r) => r.ourClass === cls);
    const inCcf = g.filter((r) => r.ccf !== null).length;
    return { class: cls, venues: g.length, inCcf, share: g.length ? inCcf / g.length : null };
  });
}

// ── render ──
const f3 = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
const fp = (p: number | null) => (p === null ? 'n/a' : p < 0.001 ? '<0.001' : p.toFixed(3));
const tauText = (t: Tau) => (t.tooFew ? `too few (n=${t.n})` : `tau-b ${f3(t.tau)}, n=${t.n}, z=${f3(t.z)}, p=${fp(t.p)}`);
const pct = (v: number | null) => (v === null ? '–' : `${(100 * v).toFixed(0)}%`);

function mdTable(t: CrossTable, header: string): string {
  const L = [`| ${header} | ${t.colLabels.join(' | ')} | total |`, `|---|${t.colLabels.map(() => '---:').join('|')}|---:|`];
  t.rowLabels.forEach((r, i) => L.push(`| ${r} | ${t.cells[i].join(' | ')} | ${t.rowTotals[i]} |`));
  L.push(`| **total** | ${t.colTotals.join(' | ')} | ${t.total} |`);
  return L.join('\n');
}

function main() {
  const { rows, rejected } = load();
  const iso = new Date().toISOString().replace(/:/g, '-');
  const blocks = LISTS.flatMap((l) => TYPES.map((t) => block(l, t, rows)));
  const shares = TYPES.map((t) => ({ type: t, rows: ccfShare(rows, t) }));

  const editions = {
    CCF: 'CCF Recommended International Academic Conferences and Journals, 7th edition (2026), official PDF in data/lists/. Matched by DBLP key / name by hand.',
    JUFO: 'JUFO (Publication Forum, Finland). Panel 2 export (data/lists/jfp-export.csv), plus an all-panel lookup via the JUFO REST API v1.1 (data/lists/jufo-lookup-2026-11-20.json). Downloaded 2026-11-19/20.',
  };
  const note = 'Agreement with these lists is supporting evidence, not proof: the lists have their own scope (CCF lists only recommended venues; JUFO has its own panels and levels), their own scales, and our sample is small.';

  const json = {
    generated: new Date().toISOString(), input: CSV, credentials: SCORES_DIR, venues: rows.length, editions, note,
    scales: {
      ours_conference: 'A++ 7, A+ 6, A 5, A- 4, B 3, B- 2, C 1 (Work in progress: off scale)',
      ours_journal: 'band 200 6, 140 5, 100 4, 70 3, 40 2, 20 1 (Not rated: off scale)',
      ccf: 'A 3, B 2, C 1', jufo: '3, 2, 1, "0 (other identified)" 0',
    },
    confirmedNo: rejected, blocks, ccfShareByOurClass: shares,
    venueTable: rows,
  };

  const md: string[] = [];
  md.push('# E5: our grades against two expert lists', '', `Generated ${json.generated}. ${rows.length} venues (13 test + 87 sampled), grades read from the credentials in \`${SCORES_DIR}\` (decoded, signatures not checked).`, '');
  md.push('## Lists', '', `- **CCF:** ${editions.CCF}`, `- **JUFO:** ${editions.JUFO}`, '', `> ${note}`, '');
  md.push('## Confirmations marked "no"', '');
  if (rejected.length) { md.push('| venue | list | grade as drafted |', '|---|---|---|', ...rejected.map((r) => `| ${r.key} | ${r.list} | ${r.grade || '–'} |`), '', 'These matches are treated as not listed.'); }
  else md.push('None: no row has "no" in confirm_ccf or confirm_jufo, so every drafted match is used as listed. (Blank confirm cells are not "no".)');
  md.push('', '## Scales', '', '- Ours, conferences: A++ 7, A+ 6, A 5, A- 4, B 3, B- 2, C 1. "Work in progress" is not on the scale.',
    '- Ours, journals: band 200 → 6, 140 → 5, 100 → 4, 70 → 3, 40 → 2, 20 → 1. "Not rated" is not on the scale.',
    '- CCF: A 3, B 2, C 1. JUFO: 3, 2, 1, "0 (other identified)" = 0.', '- Kendall tau-b over venues that are listed and on our scale; two-sided p from the normal approximation with the tie-corrected variance; n < 5 is reported as "too few".', '');
  for (const l of LISTS) {
    md.push(`## ${l.label}`, '');
    for (const t of TYPES) {
      const b = blocks.find((x) => x.list === l.label && x.type === t)!;
      md.push(`### ${l.label}, ${t}s`, '', `Venues in sample: **${b.counts.sample}**; listed: **${b.counts.listed}**; not listed: **${b.counts.notListed}**; listed but left out of the correlation (${t === 'conference' ? 'Work in progress' : 'Not rated'}): **${b.counts.listedNotOnOurScale}**; in the correlation (all venues): **${b.counts.onBothScales}**.`, '',
        mdTable(b.table, `our class \\ ${l.label} grade`), '',
        `- Kendall, all venues: ${tauText(b.tau.all)}`, `- Kendall, 87 sampled venues only: ${tauText(b.tau.sampled)}`, '');
    }
  }
  md.push('## Share of our classes that appear in CCF', '', 'CCF lists only recommended venues, so absence is expected for lower classes; a share that rises with our class is the check.', '');
  for (const s of shares) {
    md.push(`### ${s.type}s`, '', '| our class | venues | in CCF | share |', '|---|---:|---:|---:|', ...s.rows.map((r) => `| ${r.class} | ${r.venues} | ${r.inCcf} | ${pct(r.share)} |`), '');
  }
  md.push('## Note', '', note, '');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const base = path.join(OUT_DIR, `e5-${iso}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(json, null, 2) + '\n');
  fs.writeFileSync(`${base}.md`, md.join('\n'));
  console.log(`wrote ${base}.json and ${base}.md`);
}

main();
