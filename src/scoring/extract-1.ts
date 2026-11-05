import { parseCsv } from '../shared/csv.js';
import type { IcoreData, RetractionData, ScimagoData } from './snapshot-store.js';

/**
 * Extraction of one venue's values from the three provider files (ICORE, SCImago, Retraction Watch).
 * Pure functions: file text in, values out; no files, network or clock. The snapshot (snapshot-1.ts)
 * and the L3 "Inputs" check (verification/check-inputs.ts) both call these, so the issuer and the
 * checker run the same extraction code on the same kind of file.
 *
 * Each source has a parse step (once per file) and an extract step (once per venue and matching rule).
 */

const stripBom = (s: string) => s.replace(/^﻿/, '');
const decimal = (s: string | undefined) => {
  if (s === undefined || s.trim() === '') return null;
  const n = Number(s.replace(',', '.'));   // SCImago uses decimal commas
  return Number.isFinite(n) ? n : null;
};

// ── ICORE ────────────────────────────────────────────────────
// data/core.csv has no header row: id, title, acronym, edition, rank, ...

export interface IcoreFile { rows: string[][]; byId: Map<string, string[]>; edition: string | null }
export interface IcoreRule { coreId: string }

export function parseIcore(text: string): IcoreFile {
  const rows = parseCsv(stripBom(text));
  return { rows, byId: new Map(rows.map((r) => [r[0], r])), edition: rows[0]?.[3] || null };   // e.g. "ICORE2026"
}

export function extractIcore(file: IcoreFile, rule: IcoreRule): IcoreData | null {
  const r = file.byId.get(rule.coreId);
  return r ? { coreId: r[0], title: r[1], acronym: r[2], edition: r[3], rank: r[4] } : null;
}

// ── SCImago ──────────────────────────────────────────────────
// Semicolon separated, decimal commas; the edition is the year in the header "Total Docs. (2025)".

export interface ScimagoFile {
  rows: string[][]; byId: Map<string, string[]>; edition: string | null;
  col: { id: number; title: number; issn: number; sjr: number; quartile: number; h: number; docs3y: number; citesPerDoc: number; categories: number };
}
export interface ScimagoRule { sourceid: string }

export function parseScimago(text: string): ScimagoFile {
  const rows = parseCsv(stripBom(text), ';');
  const h = (rows[0] ?? []).map((x) => x.trim());
  const c = (name: string) => h.findIndex((x) => x.toLowerCase() === name.toLowerCase());
  const col = {
    id: c('Sourceid'), title: c('Title'), issn: c('Issn'), sjr: c('SJR'), quartile: c('SJR Best Quartile'), h: c('H index'),
    docs3y: c('Total Docs. (3years)'), citesPerDoc: c('Citations / Doc. (2years)'), categories: c('Categories'),
  };
  const year = h.find((x) => /^Total Docs\. \(\d{4}\)$/.test(x))?.match(/\d{4}/)?.[0];
  return { rows, col, byId: new Map(rows.slice(1).map((r) => [r[col.id], r])), edition: year ? `SJR ${year}` : null };
}

export function extractScimago(file: ScimagoFile, rule: ScimagoRule): ScimagoData | null {
  const r = file.byId.get(rule.sourceid);
  if (!r) return null;
  const k = file.col;
  return {
    sourceid: r[k.id], title: r[k.title], sjr: decimal(r[k.sjr]), quartile: r[k.quartile], hIndex: decimal(r[k.h]),
    totalDocs3y: decimal(r[k.docs3y]), citesPerDoc2y: decimal(r[k.citesPerDoc]), categories: r[k.categories], issn: (r[k.issn] ?? '').trim(),
  };
}

// ── Retraction Watch ─────────────────────────────────────────
// RetractionDate looks like "4/15/2026 0:00": month/day/year, then a time (checked on the real file:
// the first number never exceeds 12, the second often does). It is converted to YYYY-MM-DD.

export interface RetractionFile {
  body: string[][]; col: { journal: number; nature: number; reason: number; date: number };
  /** The file's "as of" date: the latest RetractionDate in it (YYYY-MM-DD), or null if it has none. */
  cutoff: string | null;
}
export interface RetractionRule { rwMatch: string; rwExclude?: string; cutoff?: string }

/** "4/15/2026 0:00" → "2026-04-15"; null when it is not in that form. */
export function rwDateToIso(s: string | undefined): string | null {
  const m = (s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);
  if (!m) return null;
  const [mo, d] = [Number(m[1]), Number(m[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseRetractionWatch(text: string): RetractionFile {
  const rows = parseCsv(stripBom(text));
  const h = (rows[0] ?? []).map((x) => x.trim().toLowerCase());
  const col = { journal: h.indexOf('journal'), nature: h.indexOf('retractionnature'), reason: h.indexOf('reason'), date: h.indexOf('retractiondate') };
  const body = rows.slice(1);
  let cutoff: string | null = null;
  for (const r of body) { const d = rwDateToIso(r[col.date]); if (d && (cutoff === null || d > cutoff)) cutoff = d; }
  return { body, col, cutoff };
}

/**
 * The venue's Journal-column matches. A row counts as a retraction when RetractionNature matches
 * /retraction/i. With rule.cutoff only rows dated on or before it are used (a row without a readable
 * date is kept, since nothing says it came later).
 */
export function extractRetractionWatch(file: RetractionFile, rule: RetractionRule): RetractionData {
  const { col } = file;
  const inc = new RegExp(rule.rwMatch, 'i');
  const exc = rule.rwExclude ? new RegExp(rule.rwExclude, 'i') : null;
  const hits = file.body.filter((r) => {
    if (!inc.test(r[col.journal] ?? '') || exc?.test(r[col.journal] ?? '')) return false;
    if (rule.cutoff === undefined) return true;
    const d = rwDateToIso(r[col.date]);
    return d === null || d <= rule.cutoff;
  });
  const byYear: Record<string, number> = {}, reasons: Record<string, number> = {};
  let retractions = 0;
  for (const r of hits) {
    if (/retraction/i.test(r[col.nature] ?? '')) retractions++;
    const y = (r[col.date] ?? '').match(/(19|20)\d{2}/)?.[0];
    if (y) byYear[y] = (byYear[y] ?? 0) + 1;
    for (const x of (r[col.reason] ?? '').split(';').map((s) => s.replace(/^\+/, '').trim()).filter(Boolean)) reasons[x] = (reasons[x] ?? 0) + 1;
  }
  // Zero matches is recorded as zero records (the file was checked), not as missing
  return { records: hits.length, retractions, byYear, topReasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5)) };
}
