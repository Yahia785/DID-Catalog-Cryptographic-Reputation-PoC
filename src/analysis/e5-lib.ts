/**
 * E5 helpers (pure, no files): ordinal scales, cross-tables, Kendall's tau-b with a two-sided normal-approximation p-value.
 * Kept apart from e5-expert-lists.ts so tests can import them without running the analysis.
 */

export type VenueKind = 'conference' | 'journal';
export const WIP = 'Work in progress';
export const NOT_RATED = 'Not rated';
export const NOT_LISTED = 'not listed';

/** Our conference classes, best first. "Work in progress" is not on the scale. */
export const CONF_CLASSES = ['A++', 'A+', 'A', 'A-', 'B', 'B-', 'C'];
/** Our journal bands, best first. "Not rated" is not on the scale. */
export const JOURNAL_CLASSES = ['200', '140', '100', '70', '40', '20'];
export const CCF_GRADES = ['A', 'B', 'C'];
export const JUFO_LEVELS = ['3', '2', '1', '0 (other identified)'];

const CONF_SCALE: Record<string, number> = { 'A++': 7, 'A+': 6, A: 5, 'A-': 4, B: 3, 'B-': 2, C: 1 };
const JOURNAL_SCALE: Record<string, number> = { '200': 6, '140': 5, '100': 4, '70': 3, '40': 2, '20': 1 };
const CCF_SCALE: Record<string, number> = { A: 3, B: 2, C: 1 };
const JUFO_SCALE: Record<string, number> = { '3': 3, '2': 2, '1': 1, '0 (other identified)': 0 };

const look = (m: Record<string, number>, k: string): number | null => (Object.hasOwn(m, k) ? m[k] : null);

/** Our ordinal for a class/band string; null when it is off the scale (Work in progress, Not rated, unknown). */
export const ourOrdinal = (type: VenueKind, cls: string): number | null =>
  look(type === 'conference' ? CONF_SCALE : JOURNAL_SCALE, String(cls).trim());
export const ccfOrdinal = (grade: string): number | null => look(CCF_SCALE, grade.trim());
export const jufoOrdinal = (level: string): number | null => look(JUFO_SCALE, level.trim());

/** Row order for our classes: scale best-first, then the unrated label as its own row. */
export const ourRowOrder = (type: VenueKind) =>
  type === 'conference' ? [...CONF_CLASSES, WIP] : [...JOURNAL_CLASSES, NOT_RATED];

/**
 * A list match counts only if its status is "listed" and the confirmation column is not "no".
 * Returns whether the venue is treated as listed, and whether a "no" overrode a "listed".
 */
export function effectiveListed(status: string, confirm: string): { listed: boolean; rejected: boolean } {
  const listed = status.trim().toLowerCase() === 'listed';
  const rejected = listed && confirm.trim().toLowerCase() === 'no';
  return { listed: listed && !rejected, rejected };
}

export interface CrossTable {
  rowLabels: string[];
  colLabels: string[];            // grades, then "not listed"
  cells: number[][];              // [row][col]
  rowTotals: number[];
  colTotals: number[];
  total: number;
}

/** Cross-tabulate (ours, theirs) pairs. A label outside the given orders throws, so nothing is dropped silently. */
export function crossTable(pairs: { ours: string; theirs: string }[], rowOrder: string[], gradeOrder: string[]): CrossTable {
  const colLabels = [...gradeOrder, NOT_LISTED];
  const cells = rowOrder.map(() => colLabels.map(() => 0));
  for (const p of pairs) {
    const r = rowOrder.indexOf(p.ours), c = colLabels.indexOf(p.theirs);
    if (r < 0) throw new Error(`unknown class "${p.ours}"`);
    if (c < 0) throw new Error(`unknown list grade "${p.theirs}"`);
    cells[r][c]++;
  }
  const rowTotals = cells.map((r) => r.reduce((a, b) => a + b, 0));
  const colTotals = colLabels.map((_, c) => cells.reduce((a, r) => a + r[c], 0));
  return { rowLabels: rowOrder, colLabels, cells, rowTotals, colTotals, total: rowTotals.reduce((a, b) => a + b, 0) };
}

/** Complementary error function (Numerical Recipes erfcc, relative error < 1.2e-7). */
function erfc(x: number): number {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
/** Two-sided p-value for a standard-normal z. */
export const twoSidedP = (z: number) => erfc(Math.abs(z) / Math.SQRT2);

export const MIN_N = 5;

export interface Tau {
  n: number;
  tooFew: boolean;               // n < 5: no number is reported
  tau: number | null;            // null when too few, or when one variable is constant (undefined)
  z: number | null;
  p: number | null;
  concordant: number;
  discordant: number;
}

/**
 * Kendall's tau-b with the tie-corrected variance of S (Kendall 1970) and a normal approximation:
 *   tau_b = S / sqrt((n0 - n1)(n0 - n2)),  var(S) = (v0 - vt - vu)/18 + v1 + v2,  z = S / sqrt(var(S)).
 * Sign convention: positive = the two orderings agree.
 */
export function kendallTauB(x: number[], y: number[]): Tau {
  if (x.length !== y.length) throw new Error('x and y differ in length');
  const n = x.length;
  let conc = 0, disc = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const dx = Math.sign(x[i] - x[j]), dy = Math.sign(y[i] - y[j]);
    if (dx && dy) { if (dx === dy) conc++; else disc++; }
  }
  const base = { n, concordant: conc, discordant: disc };
  if (n < MIN_N) return { ...base, tooFew: true, tau: null, z: null, p: null };
  const groups = (v: number[]) => { const m = new Map<number, number>(); v.forEach((a) => m.set(a, (m.get(a) ?? 0) + 1)); return [...m.values()]; };
  const tx = groups(x), ty = groups(y);
  const sum = (g: number[], f: (t: number) => number) => g.reduce((a, t) => a + f(t), 0);
  const n0 = (n * (n - 1)) / 2;
  const n1 = sum(tx, (t) => (t * (t - 1)) / 2), n2 = sum(ty, (t) => (t * (t - 1)) / 2);
  const denom = Math.sqrt((n0 - n1) * (n0 - n2));
  if (denom === 0) return { ...base, tooFew: false, tau: null, z: null, p: null };
  const S = conc - disc;
  const v0 = n * (n - 1) * (2 * n + 5);
  const vt = sum(tx, (t) => t * (t - 1) * (2 * t + 5)), vu = sum(ty, (t) => t * (t - 1) * (2 * t + 5));
  const v1 = (sum(tx, (t) => t * (t - 1)) * sum(ty, (t) => t * (t - 1))) / (2 * n * (n - 1));
  const v2 = (sum(tx, (t) => t * (t - 1) * (t - 2)) * sum(ty, (t) => t * (t - 1) * (t - 2))) / (9 * n * (n - 1) * (n - 2));
  const variance = (v0 - vt - vu) / 18 + v1 + v2;
  const z = variance > 0 ? S / Math.sqrt(variance) : null;
  return { ...base, tooFew: false, tau: S / denom, z, p: z === null ? null : twoSidedP(z) };
}
