import { createIdentity } from '../identity/create-identity.js';
import type { AuditEntry, DidResolver } from '../identity/resolve-did.js';
import { computeScore, FORMULA_DESCRIPTION, FORMULA_VERSION } from '../scoring/compute-score.js';
import type { Identity, InputValue, ReputationScore } from '../shared/types.js';
import { findVenue, handleOf, type VenueEntry } from '../venues/registry.js';

/**
 * Shared setup for the tamper tests and the benchmark: throwaway identities (dry run,
 * never published), an in-memory DidResolver, and hand-written score inputs.
 * Nothing here touches output/ or the network.
 */

export const T_GENESIS = '2026-01-01T00:00:00.000Z';
export const T_SIGNED = '2026-03-01T00:00:00.000Z';
export const T_ROTATED = '2026-06-01T00:00:00.000Z';
export const T_AFTER_ROTATION = '2026-09-01T00:00:00.000Z';

export const num = (metric: string, value: number, sourceId: InputValue['sourceId']): InputValue => ({ metric, value, sourceId });
export const str = (metric: string, value: string, sourceId: InputValue['sourceId']): InputValue => ({ metric, value, sourceId });
export const YEARS = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];

export const CONF = findVenue('PST')!;
export const JOURNAL = findVenue('SCN')!;

// PST (conference): ICORE B, a steady 10-year paper series, a few retractions
export const confInputs: InputValue[] = [
  str('icore.rank', 'B', 'icore'),
  ...YEARS.map((y, i) => num(`s2.papers.${y}`, 40 + i * 2, 's2')),
  num('s2.cohortPapers', 60, 's2'), num('s2.cohortCitations', 420, 's2'),
  num('rw.retractions', 3, 'retraction-watch'),
];
// SCN (journal): Q3, a spike year, a retraction wave
export const journalInputs: InputValue[] = [
  str('scimago.quartile', 'Q3', 'scimago'),
  num('openalex.twoYrMeanCitedness', 1.4, 'openalex'), num('openalex.worksCount', 20000, 'openalex'),
  ...YEARS.map((y, i) => num(`openalex.works.${y}`, i === 8 ? 5000 : 800 + i * 10, 'openalex')),
  num('rw.retractions', 948, 'retraction-watch'),
];

export function makeScore(venue: VenueEntry, venueDID: string, platformDID: string, inputs: InputValue[], computedAt = T_SIGNED): ReputationScore {
  const r = computeScore(venue.type, inputs);
  return {
    payload: {
      type: 'VenueScore', platform: platformDID, venue: venueDID, venueType: venue.type,
      verificationMethod: `${platformDID}#signing-1`,
      score: r.score, confidence: r.confidence, breakdown: r.breakdown, flags: r.flags,
      formulaVersion: FORMULA_VERSION, computedAt,
    },
    manifest: {
      venueDID, venueKey: venue.key, venueType: venue.type, platformDID,
      formula: FORMULA_DESCRIPTION, formulaVersion: FORMULA_VERSION,
      sources: [], inputs, computedAt,
    },
  };
}

export const entry = (did: string, operation: AuditEntry['operation'], createdAt: string, nullified = false): AuditEntry =>
  ({ did, operation, cid: 'test', nullified, createdAt });

export const genesisOf = (i: Identity) => entry(i.did, i.plcOperation as AuditEntry['operation'], T_GENESIS);

export function memoryResolver(logs: Record<string, AuditEntry[]>): DidResolver {
  return {
    via: 'in-memory test resolver',
    async auditLog(did) {
      if (!logs[did]) throw new Error(`unknown DID ${did}`);
      return logs[did];
    },
  };
}

export const createTestPlatform = () => createIdentity('platform', 'test-platform', { dryRun: true });
export const createTestVenue = (venue: VenueEntry) => createIdentity('venue', venue.key, { dryRun: true, handle: handleOf(venue) });

/** One platform, a conference venue and a journal venue, and a resolver that knows all three. */
export async function makeFixtures() {
  const platform = await createTestPlatform();
  const confVenue = await createTestVenue(CONF);
  const journalVenue = await createTestVenue(JOURNAL);
  const resolver = memoryResolver(Object.fromEntries([platform, confVenue, journalVenue].map((i) => [i.did, [genesisOf(i)]])));
  return {
    platform, confVenue, journalVenue, resolver,
    confScore: makeScore(CONF, confVenue.did, platform.did, confInputs),
    journalScore: makeScore(JOURNAL, journalVenue.did, platform.did, journalInputs),
  };
}
