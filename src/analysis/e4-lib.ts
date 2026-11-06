/**
 * E4 helpers (pure, no files): the shift measure, change statistics, and the seeded subset draw.
 * Kept apart from e4-sensitivity.ts so tests can import them without running the analysis.
 */

export type VenueKind = 'conference' | 'journal';

/** Conference classes, best first; each step is 1. */
export const CONF_ORDER = ['A++', 'A+', 'A', 'A-', 'B', 'B-', 'C', 'Work in progress'];
/** Journal bands, best first (as the strings the formula returns). */
export const JOURNAL_ORDER = ['200', '140', '100', '70', '40', '20'];
export const NOT_RATED = 'Not rated';
export const WIP = 'Work in progress';

/**
 * Signed shift in steps from `from` to `to`: positive = moved up (better), negative = moved down.
 * null when either side is "Not rated" (journals): that case is counted separately, not as steps.
 */
export function shift(type: VenueKind, from: string, to: string): number | null {
  if (type === 'journal' && (from === NOT_RATED || to === NOT_RATED)) return null;
  const order = type === 'conference' ? CONF_ORDER : JOURNAL_ORDER;
  const a = order.indexOf(from), b = order.indexOf(to);
  if (a < 0 || b < 0) throw new Error(`unknown ${type} class: "${a < 0 ? from : to}"`);
  return a - b;
}

export interface ChangeRow { key: string; from: string; to: string }
export interface Change extends ChangeRow { shift: number | null }

export interface ChangeStats {
  n: number;
  changed: number;
  shareChanged: number;            // percent of n
  meanAbsShift: number | null;     // over venues whose shift is defined (not involving "Not rated"); unchanged venues count as 0
  shiftN: number;                  // how many venues that mean is over
  maxShift: number;                // largest |shift|
  up: number;
  down: number;
  notRatedChanges: number;         // class changes that involve "Not rated" (not in the step statistics)
  unrated: { before: number; after: number };   // venues graded "Work in progress" (conferences) / "Not rated" (journals)
  changes: Change[];
}

export function summarizeChanges(type: VenueKind, rows: ChangeRow[]): ChangeStats {
  const unratedLabel = type === 'conference' ? WIP : NOT_RATED;
  const changes: Change[] = [];
  let sumAbs = 0, shiftN = 0, maxShift = 0, up = 0, down = 0, notRatedChanges = 0;
  for (const r of rows) {
    const s = shift(type, r.from, r.to);
    if (s === null) { if (r.from !== r.to) notRatedChanges++; }
    else { sumAbs += Math.abs(s); shiftN++; maxShift = Math.max(maxShift, Math.abs(s)); if (s > 0) up++; else if (s < 0) down++; }
    if (r.from !== r.to) changes.push({ ...r, shift: s });
  }
  return {
    n: rows.length, changed: changes.length, shareChanged: rows.length ? (100 * changes.length) / rows.length : 0,
    meanAbsShift: shiftN ? sumAbs / shiftN : null, shiftN, maxShift, up, down, notRatedChanges,
    unrated: { before: rows.filter((r) => r.from === unratedLabel).length, after: rows.filter((r) => r.to === unratedLabel).length },
    changes,
  };
}

/** Seeded PRNG (mulberry32), the same generator the sample selection uses. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` random subsets of `k` distinct items (partial Fisher-Yates), in a fixed order for a fixed seed. Each subset keeps the order of `items`. */
export function drawSubsets<T>(items: T[], k: number, count: number, seed: number): T[][] {
  if (k > items.length) throw new Error(`cannot draw ${k} from ${items.length}`);
  const rand = mulberry32(seed);
  const out: T[][] = [];
  for (let c = 0; c < count; c++) {
    const idx = items.map((_, i) => i);
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rand() * (idx.length - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    out.push(idx.slice(0, k).sort((a, b) => a - b).map((i) => items[i]));
  }
  return out;
}
