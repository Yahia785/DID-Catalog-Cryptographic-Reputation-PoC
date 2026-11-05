import crypto from 'node:crypto';
import path from 'node:path';
import type { InputValue, ReputationScore, ScoreCohort, SourceSnapshot, VenueType } from '../shared/types.js';
import { VENUES, type VenueEntry } from '../venues/registry.js';
import { sourcesFor } from './build-score.js';
import { FORMULAS } from './compute-score.js';
import { slot, type Snapshot, type SourceId } from './snapshot-store.js';

/**
 * Formula 1.0: turn a formula-1.0 snapshot (npx tsx src/scoring/snapshot.ts --formula=1.0) into the
 * inputs and the cohort formula-1.ts expects, and assemble the unsigned score. Every value goes
 * through slot(), so a value that failed to collect can never silently become an input.
 */

/** The raw values formula 1.0 uses for one venue, each tagged with its source. */
export function buildInputs1(venue: VenueEntry, snap: Snapshot): InputValue[] {
  const s = snap.sources;
  const inputs: InputValue[] = [];
  const add = (metric: string, value: number | string | null | undefined, sourceId: SourceId) =>
    inputs.push({ metric, value: value ?? null, sourceId });

  const oa = slot(s.openalex, venue.key);
  if (venue.type === 'conference') {
    add('icore.rank', slot(s.icore, venue.key)?.rank, 'icore');
    add('openalex.hIndex', oa?.hIndex, 'openalex');
    add('openalex.citedByCount', oa?.citedByCount, 'openalex');
    add('scimago.hIndex', slot(s.scimago, venue.key)?.hIndex, 'scimago');
  } else {
    const sc = slot(s.scimago, venue.key);
    add('scimago.sjr', sc?.sjr, 'scimago');
    add('openalex.twoYrMeanCitedness', oa?.twoYrMeanCitedness, 'openalex');
  }
  add('openalex.worksCount', oa?.worksCount, 'openalex');
  for (const y of s.openalex?.years ?? []) add(`openalex.works.${y}`, oa?.worksByYear[y], 'openalex');
  add('rw.retractions', slot(s['retraction-watch'], venue.key)?.retractions, 'retraction-watch');
  return inputs;
}

/**
 * The cohort of one venue type: for each ranked indicator, the sorted values of all sample venues
 * of that type that have it. The id carries the snapshot and a hash of the cohort's content, so two
 * credentials with the same id were ranked against exactly the same values.
 */
export function buildCohort(snap: Snapshot, type: VenueType, venues: VenueEntry[] = VENUES): ScoreCohort {
  const s = snap.sources;
  const ofType = venues.filter((v) => v.type === type);
  const col = (get: (v: VenueEntry) => number | null | undefined) =>
    ofType.map(get).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  // keys in alphabetical order: the hash is taken over this exact JSON
  const body: { populationSize?: number; values: Record<string, number[]> } = type === 'conference'
    ? { populationSize: 800, values: {
        'conf.openalex.hIndex': col((v) => slot(s.openalex, v.key)?.hIndex),
        'conf.scimago.hIndex': col((v) => slot(s.scimago, v.key)?.hIndex),
      } }
    : { values: {
        'journal.openalex.twoYrMeanCitedness': col((v) => slot(s.openalex, v.key)?.twoYrMeanCitedness),
        'journal.scimago.sjr': col((v) => slot(s.scimago, v.key)?.sjr),
      } };
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { id: `${path.basename(snap.dir)}/${type}/${hash}`, ...body };
}

/** ISSNs (8 characters, no hyphen) for the SCImago absence rule: the registry's, else OpenAlex's issn_l and issn from the snapshot. */
export function journalIssns(venue: VenueEntry, snap: Snapshot): string[] {
  const plain = (s: string) => s.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (venue.issn) return [plain(venue.issn)];
  const oa = slot(snap.sources.openalex, venue.key);
  return [...new Set([oa?.issnL, ...(oa?.issn ?? [])].filter((x): x is string => !!x).map(plain))];
}

/**
 * Add what the L3 "Inputs" check needs to each source entry: whether the provider publishes a fixed file
 * (verifiable) and the rule that finds this venue's row in it (match). Nothing the formula reads changes.
 */
export function withVerifiability(sources: SourceSnapshot[], venue: VenueEntry, snap: Snapshot): SourceSnapshot[] {
  return sources.map((s): SourceSnapshot => {
    if (s.id === 'openalex') {
      return { ...s, verifiable: 'live', verifiableReason: 'live API, no fixed edition', ...(venue.openalexId ? { match: { openalexId: venue.openalexId } } : {}) };
    }
    const file: SourceSnapshot = { ...s, verifiable: 'file' };
    const contentHash = snap.sources[s.id as 'icore' | 'scimago']?.source.contentHash;   // order-independent hash of the rows (icore, scimago)
    if (contentHash && (s.id === 'icore' || s.id === 'scimago')) file.contentHash = contentHash;
    if (s.id === 'icore' && venue.coreId) file.match = { coreId: venue.coreId };
    if (s.id === 'scimago' && venue.scimagoId) {
      const issn = slot(snap.sources.scimago, venue.key)?.issn;
      file.match = { sourceid: venue.scimagoId, ...(issn ? { issn } : {}) };
    } else if (s.id === 'scimago' && venue.type === 'journal') {
      // A journal with no SCImago id is said to be NOT in SCImago: let the checker confirm it by ISSN.
      // (A conference with no SCImago id gets no rule: SCImago has no ISSN to search by for conferences.)
      const issns = journalIssns(venue, snap);
      if (issns.length) file.match = { issn: issns, absent: true };
    }
    if (s.id === 'retraction-watch' && venue.rwMatch) {
      const cutoff = snap.sources['retraction-watch']?.source.cutoff;
      if (!cutoff) throw new Error(`${snap.dir} has no Retraction Watch cutoff (the latest RetractionDate in the file): run  npx tsx src/scoring/snapshot.ts --formula=1.0 --upgrade-l3=${snap.dir.split('/').pop()}`);
      const commit = snap.sources['retraction-watch']?.source.commit;   // the file was pinned to a GitLab commit
      file.match = { rwMatch: venue.rwMatch, ...(venue.rwExclude ? { rwExclude: venue.rwExclude } : {}), cutoff, ...(commit ? { commit } : {}) };
    }
    return file;
  });
}

/** Run formula 1.0 on prepared inputs and assemble the (unsigned) payload and manifest. */
export function scoreFromInputs1(args: {
  venue: VenueEntry; venueDID: string; platformDID: string; snapshot: Snapshot; inputs: InputValue[]; cohort: ScoreCohort; computedAt: string;
  fingerprint?: { codeHash: string; softwareCommit: { commit: string; dirty: boolean } };
}): ReputationScore {
  const { venue, venueDID, platformDID, snapshot, inputs, cohort, computedAt, fingerprint } = args;
  const f = FORMULAS['1.0'];
  const r = f.compute(venue.type, inputs, cohort);
  return {
    payload: {
      type: 'VenueScore', platform: platformDID, venue: venueDID, venueType: venue.type,
      verificationMethod: `${platformDID}#signing-1`,
      score: r.score, class: r.class, confidence: r.confidence, breakdown: r.breakdown, flags: r.flags,
      formulaVersion: '1.0', computedAt,
    },
    manifest: {
      venueDID, venueKey: venue.key, venueType: venue.type, platformDID,
      formula: f.description, formulaVersion: '1.0',
      sources: withVerifiability(sourcesFor(inputs, snapshot), venue, snapshot), inputs, cohort, ...(fingerprint ?? {}), computedAt,
    },
  };
}
