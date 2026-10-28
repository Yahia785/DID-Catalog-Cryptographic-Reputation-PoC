/** Summary of a list of numbers for the benchmark tables. p95 is the nearest-rank percentile. */
export interface Summary { n: number; mean: number; median: number; p95: number; min: number; max: number }

export function summarize(xs: number[]): Summary | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median: mid, p95: at(0.95), min: s[0], max: s[s.length - 1] };
}
