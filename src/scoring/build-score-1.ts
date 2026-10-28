import crypto from 'node:crypto';
import path from 'node:path';
import type { InputValue, ReputationScore, ScoreCohort, VenueType } from '../shared/types.js';
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

/** Run formula 1.0 on prepared inputs and assemble the (unsigned) payload and manifest. */
export function scoreFromInputs1(args: {
  venue: VenueEntry; venueDID: string; platformDID: string; snapshot: Snapshot; inputs: InputValue[]; cohort: ScoreCohort; computedAt: string;
}): ReputationScore {
  const { venue, venueDID, platformDID, snapshot, inputs, cohort, computedAt } = args;
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
      sources: sourcesFor(inputs, snapshot), inputs, cohort, computedAt,
    },
  };
}
