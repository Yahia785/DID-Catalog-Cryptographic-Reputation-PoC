import type { InputValue, ScoreBreakdown, VenueType } from '../shared/types.js';

/**
 * The scoring formula. A PURE function: the same inputs always give the same
 * output, with no files, network or clock involved. The platform uses it to
 * issue scores; a verifier runs the exact same function on the inputs listed
 * in the manifest and must get the same number.
 *
 * Version 0.1-demo — a PLACEHOLDER for the infrastructure demo. Metrics,
 * scaling and weights are not final research decisions.
 */

export const FORMULA_VERSION = '0.1-demo';

export const FORMULA_DESCRIPTION = [
  'Four sub-scores on a 0–1 scale; the score is the unweighted mean of the sub-scores that have data, times 100.',
  'Missing inputs are left out (never counted as zero); confidence = sub-scores present / 4.',
  'Standing: conferences ICORE A*=1, A=0.8, B=0.6, C=0.4, National/Regional=0.3; journals SJR Q1=1, Q2=0.75, Q3=0.5, Q4=0.25.',
  'Impact: log scale, min(1, log10(1+x)/log10(1+cap)); journals x = OpenAlex 2-yr mean citedness, cap 10; conferences x = Semantic Scholar citations per paper of the cohort year, cap 40.',
  'Stability: r = largest yearly paper count / median active year over the last 10 full years (needs 3+ active years); 1 - (r-2)/8, clamped to 0–1.',
  'Integrity: journals: retractions per 1,000 papers (Retraction Watch / OpenAlex works), 1 - rate/50; conferences: 1 - retractions/50 when retractions > 0, otherwise no signal.',
  'All sub-scores rounded to 3 decimals and the score to 1 decimal, so recomputation matches exactly.',
].join(' ');

export interface ComputedScore {
  breakdown: ScoreBreakdown;
  score: number | null;
  confidence: { present: number; total: number };
  flags: string[];
  /** Human-readable working for each sub-score and the final score (display only, never signed). */
  explain: Record<keyof ScoreBreakdown | 'score', string>;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const logScale = (x: number, cap: number) => clamp(Math.log10(1 + x) / Math.log10(1 + cap));
const f = (x: number, d = 2) => Number(x.toFixed(d)).toString();
const clampNote = (raw: number) => (raw > 1 ? ' → capped at 1' : raw < 0 ? ' → raised to 0' : '');
const logText = (x: number, cap: number) => {
  const raw = Math.log10(1 + x) / Math.log10(1 + cap);
  return `log10(1 + ${f(x)}) / log10(1 + ${cap}) = ${f(raw, 3)}${clampNote(raw)}`;
};

/** Read one input by metric name; null if missing or not a number/string. */
function reader(inputs: InputValue[]) {
  const map = new Map(inputs.map((i) => [i.metric, i.value]));
  return {
    num: (m: string): number | null => { const v = map.get(m); return typeof v === 'number' && Number.isFinite(v) ? v : null; },
    str: (m: string): string | null => { const v = map.get(m); return typeof v === 'string' && v.trim() !== '' ? v.trim() : null; },
    series: (prefix: string): number[] =>
      [...map.entries()].filter(([k, v]) => k.startsWith(prefix) && typeof v === 'number').sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v as number),
  };
}

function standing(type: VenueType, get: ReturnType<typeof reader>): { value: number | null; text: string } {
  if (type === 'conference') {
    const rank = get.str('icore.rank');
    if (!rank) return { value: null, text: 'not listed in ICORE → no data' };
    const table: Record<string, number> = { 'A*': 1, A: 0.8, B: 0.6, C: 0.4 };
    const value = rank in table ? table[rank] : /national|regional/i.test(rank) ? 0.3 : null;
    return { value, text: value === null ? `ICORE rank "${rank}" not on the scale → no data` : `ICORE ${rank} → ${value}   (A*=1, A=0.8, B=0.6, C=0.4, National/Regional=0.3)` };
  }
  const q = get.str('scimago.quartile');
  const value = q ? ({ Q1: 1, Q2: 0.75, Q3: 0.5, Q4: 0.25 } as Record<string, number>)[q] ?? null : null;
  return { value, text: value === null ? 'not listed in SCImago → no data' : `SCImago ${q} → ${value}   (Q1=1, Q2=0.75, Q3=0.5, Q4=0.25)` };
}

function impact(type: VenueType, get: ReturnType<typeof reader>): { value: number | null; text: string } {
  if (type === 'journal') {
    const c = get.num('openalex.twoYrMeanCitedness');
    if (c === null) return { value: null, text: 'no citation data → no data' };
    return { value: logScale(c, 10), text: logText(c, 10) };
  }
  const papers = get.num('s2.cohortPapers'), cites = get.num('s2.cohortCitations');
  if (!papers || cites === null) return { value: null, text: 'no citation data → no data' };
  const perPaper = cites / papers;
  return { value: logScale(perPaper, 40), text: `${cites} / ${papers} = ${f(perPaper)} per paper → ${logText(perPaper, 40)}` };
}

function stability(series: number[]): { value: number | null; ratio: number | null; text: string } {
  const active = series.filter((n) => n > 0).sort((a, b) => a - b);
  if (active.length < 3) return { value: null, ratio: null, text: `only ${active.length} year(s) with papers (needs 3) → no data` };
  const median = active[Math.floor(active.length / 2)];
  const peak = Math.max(...active);
  const ratio = peak / median;
  const raw = 1 - (ratio - 2) / 8;
  return { value: clamp(raw), ratio, text: `peak ${peak} / median ${median} = ${f(ratio)} → 1 - (${f(ratio)} - 2) / 8 = ${f(raw, 3)}${clampNote(raw)}` };
}

function integrity(type: VenueType, get: ReturnType<typeof reader>): { value: number | null; wave: boolean; text: string } {
  const ret = get.num('rw.retractions');
  if (ret === null) return { value: null, wave: false, text: 'no retraction data → no data' };
  if (type === 'journal') {
    const works = get.num('openalex.worksCount');
    if (!works) return { value: null, wave: false, text: 'no paper count → no data' };
    const ratePer1000 = (ret / works) * 1000;
    const raw = 1 - ratePer1000 / 50;
    return { value: clamp(raw), wave: ret >= 100 || ratePer1000 >= 10,
      text: `${ret} / ${works} × 1000 = ${f(ratePer1000)} per 1,000 → 1 - ${f(ratePer1000)} / 50 = ${f(raw, 3)}${clampNote(raw)}` };
  }
  // Conferences: zero retractions carries no signal (top venues and predatory ones both show zero)
  if (ret === 0) return { value: null, wave: false, text: '0 retractions → no signal for conferences → no data' };
  const raw = 1 - ret / 50;
  return { value: clamp(raw), wave: ret >= 20, text: `1 - ${ret} / 50 = ${f(raw, 3)}${clampNote(raw)}` };
}

export function computeScore(type: VenueType, inputs: InputValue[]): ComputedScore {
  const get = reader(inputs);
  const flags: string[] = [];

  const st = standing(type, get);
  if (st.value === null) flags.push(type === 'journal' ? 'not indexed (SCImago)' : 'not ranked (ICORE)');

  const im = impact(type, get);

  const stab = stability(get.series(type === 'journal' ? 'openalex.works.' : 's2.papers.'));
  if (stab.ratio !== null && stab.ratio > 4) flags.push('publication spike');

  const integ = integrity(type, get);
  if (integ.wave) flags.push('retraction wave');

  const breakdown: ScoreBreakdown = {
    standing: st.value === null ? null : r3(st.value),
    impact: im.value === null ? null : r3(im.value),
    stability: stab.value === null ? null : r3(stab.value),
    integrity: integ.value === null ? null : r3(integ.value),
  };
  const present = Object.values(breakdown).filter((v): v is number => v !== null);
  if (present.length === 0) flags.push('no data');
  else if (present.length <= 1) flags.push('low confidence');

  const score = present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 1000) / 10 : null;
  const scoreText = present.length
    ? `(${present.join(' + ')}) / ${present.length} × 100 = ${score}   (sub-scores with no data are left out)`
    : 'no sub-score has data → no score';

  return {
    breakdown, score, confidence: { present: present.length, total: 4 }, flags,
    explain: { standing: st.text, impact: im.text, stability: stab.text, integrity: integ.text, score: scoreText },
  };
}
