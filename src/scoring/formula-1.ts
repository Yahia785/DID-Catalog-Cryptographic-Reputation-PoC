import type { InputValue, ScoreCohort, VenueType } from '../shared/types.js';
import { integrity, reader, stability, type ComputedScore } from './compute-score.js';

/**
 * Formula 1.0 — a PURE function, like 0.1-demo (no files, network or clock), so a verifier can
 * recompute a score from the credential alone: the inputs and the cohort are both in the manifest.
 *
 *   Conferences  GGS conference rating (Group of Intelligent Systems, Univ. of Málaga):
 *                ICORE class + h-index rank estimated within the sample + citations per paper
 *   Journals     the Polish ministry (2019) method: percentile within the sample of SJR and of
 *                OpenAlex 2-year mean citedness, banded 97 / 90 / 75 / 50 / 25
 */

export const FORMULA_1_VERSION = '1.0';

export const FORMULA_1_DESCRIPTION = [
  'Conferences (GGS rating): every source gives a class; the three classes are combined with the published GGS table.',
  'ICORE: A*→A++, A→A, B→B, C→C, anything else no class.',
  'OpenAlex and SCImago: position p = 1 + number of sample venues with a strictly larger h-index (ties share the best position), estimated rank r = ceil(p / N × 800) with N the sample size; class by rank: r≤50 A++, ≤75 A+, ≤200 A, ≤250 A-, ≤575 B, ≤650 B-, else C.',
  'OpenAlex is then corrected by lifetime average citations a = cited_by_count / works_count (≥25 A++, ≥23 A+, ≥18 A, ≥16 A-, ≥12 B, ≥10 B-, ≥7 C, else D) with the GGS correction rules; SCImago is not corrected.',
  'Three classes: table lookup. Two classes: a virtual third equal to the lower one is added, then the result is capped at A (flag "two sources only (capped at A)"). One or none: "Work in progress" (flag "not classifiable").',
  'Points = sum of the class scores of the three classes used (A++=7, A+=6, A=5, A-=4, B=3, B-=2, C=1), including a virtual third; confidence = sources with a class / 3.',
  'Journals (Polish method): percentile of each indicator within the sample = 100 × (venues strictly lower + 0.5 × other venues equal) / N, rounded to 1 decimal; band ≥97→200, ≥90→140, ≥75→100, ≥50→70, ≥25→40, else 20.',
  'Class = the higher band; points = the higher percentile; confidence = indicators present / 2. No indicator: "Not rated".',
  'Flags never change class or points: "not ranked (ICORE)", "not indexed (SCImago)", "sources disagree" (bands 2+ steps apart), "publication spike" (OpenAlex works per year over the last 10 full years) and "retraction wave", with the same rules and thresholds as 0.1-demo.',
].join(' ');

// ── classes ──────────────────────────────────────────────────
const CLASS_ORDER = ['A++', 'A+', 'A', 'A-', 'B', 'B-', 'C'] as const;
type GgsClass = (typeof CLASS_ORDER)[number];
const CLASS_POINTS: Record<GgsClass, number> = { 'A++': 7, 'A+': 6, A: 5, 'A-': 4, B: 3, 'B-': 2, C: 1 };
const rankOf = (c: string) => CLASS_ORDER.indexOf(c as GgsClass);   // 0 = best
const WIP = 'Work in progress';

/**
 * The GGS class-assignment table (every combination of three classes → final class).
 * Source: https://scie.lcc.uma.es/gii-grin-scie-rating/conferenceRating.jsf ("Class-Assignment Rules"),
 * retrieved 2026-10-28, copied from data/ggs/ggs-class-rules.json. Keys are the three classes
 * sorted best first; 84 entries = every multiset of 3 from the 7 classes.
 */
export const GGS_TABLE: Record<string, string> = {
  'A++,A++,A++': 'A++',
  'A++,A++,A+': 'A++',
  'A++,A++,A': 'A+',
  'A++,A++,A-': 'A+',
  'A++,A++,B': 'A',
  'A++,A++,B-': 'A',
  'A++,A++,C': 'A',
  'A++,A+,A+': 'A+',
  'A++,A+,A': 'A+',
  'A++,A+,A-': 'A',
  'A++,A+,B': 'A',
  'A++,A+,B-': 'A',
  'A++,A+,C': 'A-',
  'A++,A,A': 'A',
  'A++,A,A-': 'A',
  'A++,A,B': 'A',
  'A++,A,B-': 'A-',
  'A++,A,C': 'A-',
  'A++,A-,A-': 'A',
  'A++,A-,B': 'A-',
  'A++,A-,B-': 'A-',
  'A++,A-,C': 'A-',
  'A++,B,B': 'A-',
  'A++,B,B-': 'A-',
  'A++,B,C': 'B',
  'A++,B-,B-': 'B',
  'A++,B-,C': 'B',
  'A++,C,C': 'B',
  'A+,A+,A+': 'A+',
  'A+,A+,A': 'A+',
  'A+,A+,A-': 'A',
  'A+,A+,B': 'A',
  'A+,A+,B-': 'A-',
  'A+,A+,C': 'A-',
  'A+,A,A': 'A',
  'A+,A,A-': 'A',
  'A+,A,B': 'A-',
  'A+,A,B-': 'A-',
  'A+,A,C': 'A-',
  'A+,A-,A-': 'A-',
  'A+,A-,B': 'A-',
  'A+,A-,B-': 'A-',
  'A+,A-,C': 'B',
  'A+,B,B': 'A-',
  'A+,B,B-': 'B',
  'A+,B,C': 'B',
  'A+,B-,B-': 'B',
  'A+,B-,C': 'B',
  'A+,C,C': 'B-',
  'A,A,A': 'A',
  'A,A,A-': 'A',
  'A,A,B': 'A-',
  'A,A,B-': 'A-',
  'A,A,C': 'B',
  'A,A-,A-': 'A-',
  'A,A-,B': 'A-',
  'A,A-,B-': 'B',
  'A,A-,C': 'B',
  'A,B,B': 'B',
  'A,B,B-': 'B',
  'A,B,C': 'B',
  'A,B-,B-': 'B',
  'A,B-,C': 'B-',
  'A,C,C': 'B-',
  'A-,A-,A-': 'A-',
  'A-,A-,B': 'A-',
  'A-,A-,B-': 'B',
  'A-,A-,C': 'B',
  'A-,B,B': 'B',
  'A-,B,B-': 'B',
  'A-,B,C': 'B-',
  'A-,B-,B-': 'B-',
  'A-,B-,C': 'B-',
  'A-,C,C': 'B-',
  'B,B,B': 'B',
  'B,B,B-': 'B',
  'B,B,C': 'B-',
  'B,B-,B-': 'B-',
  'B,B-,C': 'B-',
  'B,C,C': 'Work in Progress',
  'B-,B-,B-': 'B-',
  'B-,B-,C': 'B-',
  'B-,C,C': 'Work in Progress',
  'C,C,C': 'Work in Progress',
};

const sortedKey = (classes: string[]) => [...classes].sort((a, b) => rankOf(a) - rankOf(b)).join(',');

/** Table lookup for three classes. */
export function ggsLookup(classes: string[]): string {
  const hit = GGS_TABLE[sortedKey(classes)];
  if (hit === undefined) throw new Error(`no GGS table entry for ${sortedKey(classes)}`);
  return hit === 'Work in Progress' ? WIP : hit;
}

// ── conference steps ─────────────────────────────────────────
const ICORE_CLASS: Record<string, GgsClass> = { 'A*': 'A++', A: 'A', B: 'B', C: 'C' };

/** Estimated rank r = ceil(p / N × M) in integer arithmetic. */
function estimatedRank(value: number, values: number[], population: number): { p: number; n: number; r: number } {
  const n = values.length;
  const p = 1 + values.filter((v) => v > value).length;
  return { p, n, r: Math.floor((p * population + n - 1) / n) };
}
export function classFromRank(r: number): GgsClass {
  return r <= 50 ? 'A++' : r <= 75 ? 'A+' : r <= 200 ? 'A' : r <= 250 ? 'A-' : r <= 575 ? 'B' : r <= 650 ? 'B-' : 'C';
}
export function citationClass(a: number): GgsClass | 'D' {
  return a >= 25 ? 'A++' : a >= 23 ? 'A+' : a >= 18 ? 'A' : a >= 16 ? 'A-' : a >= 12 ? 'B' : a >= 10 ? 'B-' : a >= 7 ? 'C' : 'D';
}
/** GGS's correction of the h-index class by the citation class. Returns the corrected class and the rule applied (if any). */
export function correctClass(h: GgsClass, cit: GgsClass | 'D'): { cls: GgsClass; rule: string | null } {
  const hit = (cls: GgsClass, rule: string) => ({ cls, rule });
  const worse = (...c: (GgsClass | 'D')[]) => c.includes(cit);
  if (h === 'A++' && worse('B', 'B-', 'C', 'D')) return hit('A+', `A++ with ${cit} → A+`);
  if (h === 'A+' && worse('B-', 'C', 'D')) return hit('A', `A+ with ${cit} → A`);
  if (h === 'A' && worse('C', 'D')) return hit('A-', `A with ${cit} → A-`);
  if (h === 'A-' && worse('D')) return hit('B', 'A- with D → B');
  if (h === 'A' && worse('A++')) return hit('A+', 'A with A++ → A+');
  if (h === 'A-' && worse('A++', 'A+', 'A')) return hit('A', `A- with ${cit} → A`);
  if (h === 'B' && worse('A++', 'A+', 'A')) return hit('A-', `B with ${cit} → A-`);
  if (h === 'B-' && worse('A++', 'A+', 'A', 'A-')) return hit('B', `B- with ${cit} → B`);
  if (h === 'C' && worse('A++', 'A+', 'A', 'A-')) return hit('B-', `C with ${cit} → B-`);
  return { cls: h, rule: null };
}

const f = (x: number, d = 2) => Number(x.toFixed(d)).toString();
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;

function computeConference(inputs: InputValue[], cohort: ScoreCohort | undefined, flags: string[]): Omit<ComputedScore, 'confidence' | 'flags'> & { present: number } {
  const get = reader(inputs);
  const explain: Record<string, string> = {};
  const population = cohort?.populationSize ?? 800;

  // ICORE
  const icoreRank = get.str('icore.rank');
  const icore: GgsClass | null = icoreRank ? ICORE_CLASS[icoreRank] ?? null : null;
  explain.icoreClass = !icoreRank ? 'not listed in ICORE → no class'
    : icore ? `ICORE ${icoreRank} → ${icore}   (A*→A++, A→A, B→B, C→C)` : `ICORE rank "${icoreRank}" is not A*, A, B or C → no class`;
  if (!icore) flags.push('not ranked (ICORE)');

  // h-index based classes (OpenAlex, SCImago)
  const byH = (metric: string, key: string, label: string): { cls: GgsClass | null; r: number | null; text: string } => {
    const h = get.num(metric), values = cohort?.values[key] ?? [];
    if (h === null) return { cls: null, r: null, text: `no ${label} h-index → no class` };
    if (values.length === 0) return { cls: null, r: null, text: `h-index ${h}, but the cohort has no ${key} values → no class` };
    const { p, n, r } = estimatedRank(h, values, population);
    const cls = classFromRank(r);
    return { cls, r, text: `h-index ${h}: position p = 1 + ${p - 1} larger = ${p} of N = ${n}; r = ceil(${p} / ${n} × ${population}) = ${r} → ${cls}   (r≤50 A++, ≤75 A+, ≤200 A, ≤250 A-, ≤575 B, ≤650 B-, else C)` };
  };
  const oa = byH('openalex.hIndex', 'conf.openalex.hIndex', 'OpenAlex');
  const sc = byH('scimago.hIndex', 'conf.scimago.hIndex', 'SCImago');
  explain.openalexHClass = oa.text;
  explain.scimagoClass = sc.text;

  // OpenAlex correction by lifetime average citations
  const cites = get.num('openalex.citedByCount'), works = get.num('openalex.worksCount');
  let avg: number | null = null, citCls: GgsClass | 'D' | null = null, openalex: GgsClass | null = oa.cls, correction: string | null = null;
  if (cites !== null && works !== null && works > 0) {
    avg = r3(cites / works);
    citCls = citationClass(cites / works);
    explain.openalexCitationClass = `${cites} / ${works} = ${f(cites / works, 3)} citations per paper → ${citCls}   (≥25 A++, ≥23 A+, ≥18 A, ≥16 A-, ≥12 B, ≥10 B-, ≥7 C, else D)`;
  } else explain.openalexCitationClass = 'no citation count or paper count → no correction';
  if (oa.cls && citCls) {
    const c = correctClass(oa.cls, citCls);
    openalex = c.cls; correction = c.rule;
  }
  explain.openalexClass = !oa.cls ? 'no OpenAlex class'
    : correction ? `${oa.cls} corrected by citations (${citCls}): ${correction} → ${openalex}` : `no correction needed → ${openalex}`;

  // combine
  const used: string[] = [icore, openalex, sc.cls].filter((c): c is GgsClass => c !== null);
  let cls: string, points: number | null = null, virtual: string | null = null;
  if (used.length === 3) {
    cls = ggsLookup(used);
    points = used.reduce((s, c) => s + CLASS_POINTS[c as GgsClass], 0);
    explain.finalClass = `GGS table [${sortedKey(used)}] → ${cls}`;
  } else if (used.length === 2) {
    virtual = used.reduce((lo, c) => (rankOf(c) > rankOf(lo) ? c : lo));
    const all = [...used, virtual];
    const looked = ggsLookup(all);
    cls = looked === 'A++' || looked === 'A+' ? 'A' : looked;
    points = all.reduce((s, c) => s + CLASS_POINTS[c as GgsClass], 0);
    flags.push('two sources only (capped at A)');
    explain.finalClass = `two classes (${sortedKey(used)}): virtual third = ${virtual}; table [${sortedKey(all)}] → ${looked}${cls !== looked ? ` → capped at A` : ''}`;
  } else {
    cls = WIP;
    flags.push('not classifiable');
    explain.finalClass = `${used.length} class(es) → ${WIP}`;
  }
  explain.score = points === null ? 'no points (not classifiable)'
    : `${[...used, ...(virtual ? [virtual] : [])].map((c) => `${c}=${CLASS_POINTS[c as GgsClass]}`).join(' + ')} = ${points}`;
  explain.class = cls;

  return {
    breakdown: {
      icoreClass: icore, openalexRank: oa.r, openalexHClass: oa.cls, openalexAvgCitations: avg, openalexCitationClass: citCls,
      openalexCorrection: correction, openalexClass: openalex, scimagoRank: sc.r, scimagoClass: sc.cls, virtualClass: virtual, finalClass: cls,
    },
    score: points, class: cls, present: used.length, explain,
  };
}

// ── journals ─────────────────────────────────────────────────
const BANDS = [200, 140, 100, 70, 40, 20];
const bandOf = (pct: number) => (pct >= 97 ? 200 : pct >= 90 ? 140 : pct >= 75 ? 100 : pct >= 50 ? 70 : pct >= 25 ? 40 : 20);

/** 100 × (strictly lower + 0.5 × other venues equal) / N; the venue itself is in the cohort and not counted as its own tie. */
export function percentile(value: number, values: number[]): number {
  const lower = values.filter((v) => v < value).length;
  const equal = values.filter((v) => v === value).length;
  return (100 * (lower + 0.5 * Math.max(0, equal - 1))) / values.length;
}

function computeJournal(inputs: InputValue[], cohort: ScoreCohort | undefined, flags: string[]): Omit<ComputedScore, 'confidence' | 'flags'> & { present: number } {
  const get = reader(inputs);
  const explain: Record<string, string> = {};
  const one = (metric: string, key: string, label: string) => {
    const v = get.num(metric), values = cohort?.values[key] ?? [];
    if (v === null) return { pct: null as number | null, band: null as number | null, text: `no ${label} → no percentile` };
    if (values.length === 0) return { pct: null, band: null, text: `${label} ${v}, but the cohort has no ${key} values → no percentile` };
    const raw = percentile(v, values), pct = r1(raw), band = bandOf(pct);
    const lower = values.filter((x) => x < v).length, others = Math.max(0, values.filter((x) => x === v).length - 1);
    return { pct, band, text: `${label} ${f(v, 3)}: (${lower} lower + 0.5 × ${others} equal) / ${values.length} × 100 = ${f(raw, 3)} → ${pct} → band ${band}   (≥97→200, ≥90→140, ≥75→100, ≥50→70, ≥25→40, else 20)` };
  };
  const sjr = one('scimago.sjr', 'journal.scimago.sjr', 'SJR');
  const cit = one('openalex.twoYrMeanCitedness', 'journal.openalex.twoYrMeanCitedness', '2-yr mean citedness');
  explain.sjr = sjr.text;
  explain.citedness = cit.text;
  if (sjr.pct === null) flags.push('not indexed (SCImago)');
  const bands = [sjr.band, cit.band].filter((b): b is number => b !== null);
  const pcts = [sjr.pct, cit.pct].filter((p): p is number => p !== null);
  if (sjr.band !== null && cit.band !== null && Math.abs(BANDS.indexOf(sjr.band) - BANDS.indexOf(cit.band)) >= 2) flags.push('sources disagree');
  const cls = bands.length ? String(Math.max(...bands)) : 'Not rated';
  const points = pcts.length ? Math.max(...pcts) : null;
  explain.class = bands.length ? `higher band of [${bands.join(', ')}] → ${cls}` : 'no indicator → Not rated';
  explain.score = points === null ? 'no percentile → no points' : `higher percentile of [${pcts.join(', ')}] = ${points}`;
  return {
    breakdown: { sjrPercentile: sjr.pct, sjrBand: sjr.band, citednessPercentile: cit.pct, citednessBand: cit.band, finalClass: cls },
    score: points, class: cls, present: bands.length, explain,
  };
}

// ── entry point ──────────────────────────────────────────────
export function computeScore1(type: VenueType, inputs: InputValue[], cohort?: ScoreCohort): ComputedScore {
  const flags: string[] = [];
  const r = type === 'conference' ? computeConference(inputs, cohort, flags) : computeJournal(inputs, cohort, flags);

  // flags that never change class or points (same inputs and thresholds as 0.1-demo)
  const get = reader(inputs);
  const stab = stability(get.series('openalex.works.'));   // OpenAlex works per year, for conferences and journals alike
  if (stab.ratio !== null && stab.ratio > 4) flags.push('publication spike');
  if (integrity(type, get).wave) flags.push('retraction wave');

  const { present, ...rest } = r;
  return { ...rest, confidence: { present, total: type === 'conference' ? 3 : 2 }, flags } as ComputedScore;
}
