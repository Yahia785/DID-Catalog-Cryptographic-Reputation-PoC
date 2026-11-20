/**
 * Pure helpers for the JUFO lookup (e5-jufo-lookup.ts): name and ISSN normalisation, reading a JUFO channel record, and
 * ranking candidates. Nothing here touches the network. No winner is chosen automatically: a candidate is only marked
 * "strong" when its ISSN or OpenAlex id equals the registry's.
 */

export type JufoBasis = 'ISSN' | 'OpenAlex id' | 'exact name' | 'abbreviation' | 'partial name';
export type JufoType = 'series' | 'conference' | 'publisher' | 'unknown';

/** Fields of a channel record from https://jufo-rest.csc.fi/v1.1/kanava/<id> that this lookup reads. */
export interface JufoRecord {
  Jufo_ID: string; Name: string; Abbreviation?: string; Type?: string; Level?: string; Field?: string; Fields?: string;
  ISSN1?: string; ISSN2?: string; ISSNL?: string; Jufo_history?: string; Publisher?: string; Country?: string; OpenAlex_ID?: string; openalex_id?: string;
}

export interface Candidate {
  jufoId: string; name: string; abbreviation: string; type: JufoType; level: string; panels: string[]; issns: string[];
  openalexId: string | null; publisher: string; basis: JufoBasis[]; strong: boolean; score: number;
}

export interface Target { name: string; key: string; issn?: string; openalexId?: string }

const STOP = new Set(['the', 'of', 'on', 'and', 'for', 'in', 'a', 'an', 'to', 'de', 'la', 'et']);

/** Lower case, accents removed, "&" read as "and", punctuation to spaces, spaces collapsed. */
export function normalizeName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Words of a normalised name without stop words. */
export function tokens(s: string): string[] {
  return normalizeName(s).split(' ').filter((t) => t && !STOP.has(t));
}

/** ISSN as NNNN-NNNN (upper case X), or null if it is not one. */
export function normalizeIssn(s: string | undefined | null): string | null {
  const c = (s ?? '').replace(/[^0-9xX]/g, '').toUpperCase();
  return /^\d{7}[\dX]$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

export function normalizeOpenalex(s: string | undefined | null): string | null {
  const m = /S\d+/i.exec(s ?? '');
  return m ? m[0].toUpperCase() : null;
}

export function typeOf(finnish: string | undefined): JufoType {
  const t = (finnish ?? '').toLowerCase();
  if (t.startsWith('lehti')) return 'series';
  if (t.startsWith('konferenssi')) return 'conference';
  if (t.startsWith('kustantaja')) return 'publisher';
  return 'unknown';
}

/** Panels from the record's Field value, e.g. ";1 Humanistiset;9 Muut;" -> ["1 Humanistiset", "9 Muut"]. */
export function panelsOf(field: string | undefined): string[] {
  return (field ?? '').split(';').map((x) => x.trim()).filter(Boolean);
}

/** Overlap of two token lists: Jaccard (0..1), and whether one contains all the tokens of the other. */
export function overlap(a: string[], b: string[]): { jaccard: number; contained: boolean } {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return { jaccard: 0, contained: false };
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return { jaccard: inter / (A.size + B.size - inter), contained: inter === A.size || inter === B.size };
}

/** Score of a name against the target's name: 100 exact (after normalisation), else partial by word overlap, else 0. */
export function nameScore(target: string, candidate: string): { score: number; basis: 'exact name' | 'partial name' | null } {
  if (normalizeName(target) === normalizeName(candidate)) return { score: 100, basis: 'exact name' };
  const { jaccard, contained } = overlap(tokens(target), tokens(candidate));
  if (jaccard >= 0.5 || (contained && jaccard >= 0.34)) return { score: Math.round(10 + 60 * jaccard + (contained ? 10 : 0)), basis: 'partial name' };
  return { score: 0, basis: null };
}

/** Candidate from a channel record, judged against the registry's venue. */
export function toCandidate(rec: JufoRecord, target: Target): Candidate {
  const issns = [...new Set([rec.ISSN1, rec.ISSN2, rec.ISSNL].map(normalizeIssn).filter((x): x is string => !!x))];
  const openalexId = normalizeOpenalex(rec.OpenAlex_ID ?? rec.openalex_id);
  const basis: JufoBasis[] = [];
  let score = 0;
  const tIssn = normalizeIssn(target.issn);
  if (tIssn && issns.includes(tIssn)) { basis.push('ISSN'); score += 1000; }
  const tOa = normalizeOpenalex(target.openalexId);
  if (tOa && openalexId === tOa) { basis.push('OpenAlex id'); score += 1000; }
  const nm = nameScore(target.name, rec.Name);
  if (nm.basis) { basis.push(nm.basis); score += nm.score; }
  if (rec.Abbreviation && normalizeName(rec.Abbreviation) === normalizeName(target.key) && normalizeName(target.key).length >= 2) { basis.push('abbreviation'); score += 90; }
  return {
    jufoId: String(rec.Jufo_ID), name: rec.Name, abbreviation: rec.Abbreviation ?? '', type: typeOf(rec.Type), level: levelOf(rec), panels: panelsOf(rec.Field),
    issns, openalexId, publisher: rec.Publisher ?? '', basis, strong: basis.includes('ISSN') || basis.includes('OpenAlex id'), score,
  };
}

/** Level as JUFO gives it for the newest year in its history if present, else the Level field ("" when unclassified). */
export function levelOf(rec: JufoRecord): string {
  const last = (rec.Jufo_history ?? '').split(';').map((x) => x.trim()).filter(Boolean).pop();
  const fromHistory = last ? last.split(':')[1] : undefined;
  return (rec.Level ?? fromHistory ?? '').trim();
}

/** Keep candidates with any basis, best first (ties: lower Jufo_ID first), at most `max`. */
export function rankCandidates(cands: Candidate[], max = 3): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of cands) { const o = seen.get(c.jufoId); if (!o || c.score > o.score) seen.set(c.jufoId, c); }
  return [...seen.values()].filter((c) => c.basis.length > 0).sort((a, b) => b.score - a.score || Number(a.jufoId) - Number(b.jufoId)).slice(0, max);
}

/** Which listed hits (id + name only) are worth fetching in full: best name scores first, at most `max`. */
export function pickForDetail(hits: { id: string; name: string }[], targetName: string, max: number): string[] {
  return hits.map((h) => ({ id: h.id, s: nameScore(targetName, h.name).score })).filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s || Number(a.id) - Number(b.id)).slice(0, max).map((h) => h.id);
}

/** Name without leading organisation and ordinal words, for a second search when the full name finds nothing. */
export function coreName(name: string): string {
  return name.replace(/^(?:\d+(?:st|nd|rd|th)?\s+|(?:the|annual|international|ieee|acm|ifip|ieee\/acm|acm\/ieee|ieee\/ifip)\s+)+/i, '').trim() || name;
}

export type Outcome = 'strong' | 'candidates only' | 'nothing found' | 'failed';
export function outcomeOf(cands: Candidate[], failed: boolean): Outcome {
  if (cands.some((c) => c.strong)) return 'strong';
  if (cands.length) return 'candidates only';
  return failed ? 'failed' : 'nothing found';
}
