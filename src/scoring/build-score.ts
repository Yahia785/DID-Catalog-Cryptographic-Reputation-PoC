import type { InputValue, ReputationScore, SourceSnapshot } from '../shared/types.js';
import type { VenueEntry } from '../venues/registry.js';
import { computeScore, FORMULA_DESCRIPTION, FORMULA_VERSION } from './compute-score.js';
import type { Snapshot, SourceId } from './snapshot-store.js';

/**
 * Turn a snapshot into the formula's inputs for one venue, run the formula,
 * and assemble the payload + provenance manifest (not yet signed).
 */

/** Extract exactly the raw values the formula uses, each tagged with its source. */
export function buildInputs(venue: VenueEntry, snap: Snapshot): InputValue[] {
  const s = snap.sources;
  const inputs: InputValue[] = [];
  const add = (metric: string, value: number | string | null | undefined, sourceId: SourceId) =>
    inputs.push({ metric, value: value ?? null, sourceId });

  const rw = s['retraction-watch']?.venues[venue.key];
  if (venue.type === 'conference') {
    add('icore.rank', s.icore?.venues[venue.key]?.rank, 'icore');
    const s2 = s.s2?.venues[venue.key];
    for (const y of s.s2?.years ?? []) add(`s2.papers.${y}`, s2?.papersByYear[y], 's2');
    add('s2.cohortYear', s2?.cohortYear, 's2');
    add('s2.cohortPapers', s2?.cohortPapers, 's2');
    add('s2.cohortCitations', s2?.cohortCitations, 's2');
  } else {
    add('scimago.quartile', s.scimago?.venues[venue.key]?.quartile, 'scimago');
    const oa = s.openalex?.venues[venue.key];
    add('openalex.twoYrMeanCitedness', oa?.twoYrMeanCitedness, 'openalex');
    add('openalex.worksCount', oa?.worksCount, 'openalex');
    for (const y of s.openalex?.years ?? []) add(`openalex.works.${y}`, oa?.worksByYear[y], 'openalex');
  }
  add('rw.retractions', rw?.retractions, 'retraction-watch');
  return inputs;
}

/** Only the snapshot files this venue's inputs came from. */
export function sourcesFor(inputs: InputValue[], snap: Snapshot): SourceSnapshot[] {
  const used = new Set(inputs.map((i) => i.sourceId));
  return snap.index.files
    .filter((f) => used.has(f.id))
    .map((f) => {
      const info = snap.sources[f.id]!.source;
      return {
        id: f.id, name: info.name, access: info.access, edition: info.edition,
        url: info.url, retrievedAt: info.retrievedAt, file: f.file,
      };
    });
}

export function buildScore(args: {
  venue: VenueEntry; venueDID: string; platformDID: string; snapshot: Snapshot; computedAt: string;
}): ReputationScore {
  const { venue, venueDID, platformDID, snapshot, computedAt } = args;
  const inputs = buildInputs(venue, snapshot);
  const result = computeScore(venue.type, inputs);
  return {
    payload: {
      type: 'VenueScore',
      platform: platformDID,
      venue: venueDID,
      venueType: venue.type,
      verificationMethod: `${platformDID}#signing-1`,
      score: result.score,
      confidence: result.confidence,
      breakdown: result.breakdown,
      flags: result.flags,
      formulaVersion: FORMULA_VERSION,
      computedAt,
    },
    manifest: {
      venueDID,
      venueKey: venue.key,
      venueType: venue.type,
      platformDID,
      formula: FORMULA_DESCRIPTION,
      formulaVersion: FORMULA_VERSION,
      sources: sourcesFor(inputs, snapshot),
      inputs,
      computedAt,
    },
  };
}
