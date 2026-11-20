import fs from 'node:fs';
import path from 'node:path';
import { readCsv } from '../shared/csv.js';
import { VENUES } from '../venues/registry.js';
import {
  coreName, outcomeOf, pickForDetail, rankCandidates, toCandidate, type Candidate, type JufoRecord, type Outcome, type Target,
} from './e5-jufo-lib.js';

/**
 * E5: look up the venues marked "look up" in data/lists/e5-matches-draft.csv in the JUFO (Finnish Publication Forum)
 * classification, across ALL panels, through JUFO's public REST API (https://jufo-rest.csc.fi/v1.1/). Read only.
 *
 *   npx tsx src/analysis/e5-jufo-lookup.ts
 *
 * Journals: by ISSN first, then by name. Conferences: by name and by short name (the registry key). Up to 3 candidates
 * per venue, with the basis of each match. No winner is picked: a candidate is "strong" only if its ISSN or OpenAlex id
 * equals the registry's (the REST API gives no OpenAlex id, so in practice only ISSN can make a candidate strong).
 * At most 1 request per second, User-Agent didcal-poc, a failed request is retried at most twice and then recorded.
 * Output: data/lists/jufo-lookup-<date>.json and .md
 */

const BASE = 'https://jufo-rest.csc.fi/v1.1';
const DRAFT = path.resolve('data/lists/e5-matches-draft.csv');
const MIN_GAP_MS = 1100;                  // a little over 1 s between request starts
const MAX_DETAIL = 7;                     // channel records fetched per venue
const UA = 'didcal-poc (academic research; read-only lookup)';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let lastStart = 0, requests = 0;
const failures: { url: string; error: string }[] = [];

/** One GET, at most 1/s, retried up to twice on transient failures. Returns parsed JSON, or null (failure recorded). */
async function get(url: string): Promise<unknown | null> {
  let error = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now(); requests++;
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.ok) {
        if (text.trim() === '') return [];
        try { return JSON.parse(text); } catch { error = `HTTP ${res.status}: not JSON`; }
      } else {
        error = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;   // not transient
      }
    } catch (e) { error = (e as Error).message; }
    await sleep(2000 * (attempt + 1));
  }
  failures.push({ url, error });
  return null;
}

interface Hit { id: string; name: string; type: string }
interface SearchLog { kind: string; url: string; hits: number; failed: boolean }

async function search(kind: string, qs: string, log: SearchLog[]): Promise<Hit[]> {
  const url = `${BASE}/etsi.php?${qs}`;
  const out = await get(url);
  const hits = Array.isArray(out) ? (out as { Jufo_ID: string; Name: string; Type: string }[]).map((h) => ({ id: String(h.Jufo_ID), name: h.Name, type: h.Type })) : [];
  log.push({ kind, url, hits: hits.length, failed: out === null });
  return hits;
}

const detailCache = new Map<string, JufoRecord | null>();
async function detail(id: string): Promise<JufoRecord | null> {
  if (detailCache.has(id)) return detailCache.get(id)!;
  const out = await get(`${BASE}/kanava/${id}`);
  const rec = Array.isArray(out) && out[0] ? (out[0] as JufoRecord) : null;
  detailCache.set(id, rec);
  return rec;
}

const q = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

interface VenueResult {
  key: string; name: string; type: string; issn: string | null; openalexId: string | null; outcome: Outcome;
  searches: SearchLog[]; candidates: Candidate[]; failedRequests: number;
}

async function lookup(t: Target & { type: string }): Promise<VenueResult> {
  const searches: SearchLog[] = [];
  const failedBefore = failures.length;
  const isConf = t.type === 'conference';
  const tyyppi = isConf ? '3' : '1';
  const ids: string[] = [];
  const add = (xs: string[]) => { for (const x of xs) if (!ids.includes(x)) ids.push(x); };

  if (t.issn) add((await search('ISSN', q({ issn: t.issn }), searches)).map((h) => h.id));
  let named = await search('name', q({ nimi: t.name, tyyppi }), searches);
  let short: Hit[] = [];
  if (isConf) short = await search('short name', q({ nimi: t.key, tyyppi }), searches);
  if (!pickForDetail(named, t.name, 1).length && !ids.length) {
    const core = coreName(t.name);
    named = [...named, ...(await search('name without leading words', q({ nimi: core }), searches))];
  }
  add(pickForDetail(named, t.name, 4));
  add(short.slice(0, 2).map((h) => h.id));

  const cands: Candidate[] = [];
  for (const id of ids.slice(0, MAX_DETAIL)) {
    const rec = await detail(id);
    if (rec) cands.push(toCandidate(rec, t));
  }
  const ranked = rankCandidates(cands, 3);
  const failedRequests = failures.length - failedBefore;
  return { key: t.key, name: t.name, type: t.type, issn: t.issn ?? null, openalexId: t.openalexId ?? null, outcome: outcomeOf(ranked, failedRequests > 0), searches, candidates: ranked, failedRequests };
}

// ── report ───────────────────────────────────────────────────
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function markdown(meta: { date: string; endpoint: string; counts: Record<string, number>; requests: number }, results: VenueResult[]): string {
  const c = meta.counts;
  const lines = [
    `# JUFO lookup for the venues marked "look up" (all panels)`,
    '',
    `Date ${meta.date}. Endpoint: ${meta.endpoint} (public JUFO REST API, v1.1). ${results.length} venues: **${c.strong} strong** (ISSN or OpenAlex id equal), **${c['candidates only']} candidates only**, **${c['nothing found']} nothing found**, **${c.failed} failed**. ${meta.requests} requests.`,
    '',
    'No candidate was chosen automatically. "Strong" means the candidate\'s ISSN or OpenAlex id equals the registry\'s; the REST API returns no OpenAlex id, so only ISSN can make a candidate strong. Level is JUFO\'s level field (blank or 0 = not classified at the highest levels; check before use). Panels are the JUFO panels the channel belongs to.',
    '',
  ];
  for (const r of results) {
    lines.push(`## ${r.key} — ${r.name}`, '', `${r.type}${r.issn ? `, ISSN ${r.issn}` : ''}${r.openalexId ? `, OpenAlex ${r.openalexId}` : ''}. Result: **${r.outcome}**${r.failedRequests ? ` (${r.failedRequests} request(s) failed)` : ''}. Searches: ${r.searches.map((s) => `${s.kind} → ${s.failed ? 'failed' : `${s.hits} hits`}`).join('; ')}.`, '');
    if (!r.candidates.length) { lines.push('_No candidates._', ''); continue; }
    lines.push('| Jufo_ID | Name | Abbrev. | Type | Level | Panels | ISSNs | Basis | Strong |', '|---|---|---|---|---:|---|---|---|---|');
    for (const k of r.candidates) lines.push(`| ${k.jufoId} | ${cell(k.name)} | ${cell(k.abbreviation)} | ${k.type} | ${k.level} | ${cell(k.panels.join('; '))} | ${k.issns.join(', ')} | ${k.basis.join(', ')} | ${k.strong ? 'yes' : 'no'} |`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const rows = readCsv(DRAFT);
  const head = rows[0], col = (n: string) => head.indexOf(n);
  const todo = rows.slice(1).filter((r) => (r[col('jufo_status')] ?? '').startsWith('look up')).map((r) => r[col('key')]);
  console.log(`${todo.length} venues to look up`);
  const results: VenueResult[] = [];
  for (const [i, key] of todo.entries()) {
    const v = VENUES.find((x) => x.key === key);
    if (!v) { console.error(`${key}: not in the venue registry, skipped`); continue; }
    const r = await lookup({ name: v.name, key: v.key, issn: v.issn, openalexId: v.openalexId, type: v.type });
    results.push(r);
    console.log(`${String(i + 1).padStart(2)}/${todo.length} ${key.padEnd(9)} ${r.outcome}${r.candidates[0] ? `  best: ${r.candidates[0].jufoId} ${r.candidates[0].name} [${r.candidates[0].basis.join(', ')}] L${r.candidates[0].level}` : ''}`);
  }
  const counts: Record<string, number> = { strong: 0, 'candidates only': 0, 'nothing found': 0, failed: 0 };
  for (const r of results) counts[r.outcome]++;
  const date = new Date().toISOString().slice(0, 10);
  const meta = { date, runAt: new Date().toISOString(), endpoint: BASE, userAgent: UA, source: 'data/lists/e5-matches-draft.csv (jufo_status starts with "look up")', counts, requests, failures };
  const base = path.resolve(`data/lists/jufo-lookup-${date}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ meta, venues: results }, null, 1));
  fs.writeFileSync(`${base}.md`, markdown({ date, endpoint: BASE, counts, requests }, results));
  console.log(`\n${results.length} venues: ${counts.strong} strong, ${counts['candidates only']} candidates only, ${counts['nothing found']} nothing found, ${counts.failed} failed; ${requests} requests, ${failures.length} failed requests`);
  console.log(`saved ${path.relative('.', base)}.json and .md`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
