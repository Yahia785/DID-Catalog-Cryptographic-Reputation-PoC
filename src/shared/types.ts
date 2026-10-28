// ─── Venues ──────────────────────────────────────────────────

export type VenueType = 'conference' | 'journal';

// ─── Provenance ──────────────────────────────────────────────

/**
 * One source file in a data snapshot, named by the inputs that came from it.
 */
export interface SourceSnapshot {
  id: string;               // short id used by inputs, e.g. 'openalex'
  name: string;             // human-readable, e.g. 'OpenAlex API'
  access: 'api' | 'csv';
  edition?: string;         // for exported files, e.g. 'ICORE2026'
  url: string;              // where the data came from
  retrievedAt: string;      // ISO timestamp
  file: string;             // snapshot file path, relative to the project
  sha256?: string;          // for exported files (formula 1.0 snapshots): hash of the file that was read
  bytes?: number;           // for exported files: its size
}

/** One raw value fed into the formula, with the source it came from. */
export interface InputValue {
  metric: string;           // e.g. 'retractions', 'papersByYear.2022'
  value: number | string | null;  // null = missing (never treated as zero)
  sourceId: string;         // matches SourceSnapshot.id
}

/**
 * Everything a verifier needs to recompute the score independently.
 * Embedded inside the score VC.
 */
export interface ProvenanceManifest {
  venueDID: string;
  venueKey: string;         // registry key, e.g. 'SCN'
  venueType: VenueType;
  platformDID: string;
  formula: string;          // human-readable description
  formulaVersion: string;   // e.g. '0.1-demo'
  sources: SourceSnapshot[];
  inputs: InputValue[];
  /** Formula 1.0 and later: the sample the venue is ranked within (see ScoreCohort). */
  cohort?: ScoreCohort;
  computedAt: string;
}

/**
 * The venues a score is ranked against: for each ranked indicator, the sorted values of all
 * sample venues that have it, e.g. "conf.openalex.hIndex". Signed inside the manifest, so a
 * verifier recomputes the rank from the credential alone.
 */
export interface ScoreCohort {
  id: string;                         // e.g. 'sample-2026-10'
  populationSize?: number;            // conferences: the size of the whole ICORE population (800)
  values: Record<string, number[]>;   // indicator → sorted values of the sample venues that have it
}

// ─── Score ───────────────────────────────────────────────────

/**
 * Named values behind a score; each formula version defines its own fields.
 * 0.1-demo: sub-scores on a 0–1 scale (null = input missing, left out of the average).
 * 1.0: per-source classes or percentiles, bands, corrections.
 */
export type ScoreBreakdown = Record<string, number | string | null>;

/** The claim the platform signs about a venue. */
export interface ScorePayload {
  type: 'VenueScore';
  platform: string;          // platform DID (issuer)
  venue: string;             // venue DID (subject)
  venueType: VenueType;
  verificationMethod: string; // platform signing key reference, e.g. did:plc:...#signing-1
  score: number | null;      // 0.1-demo: 0–100. 1.0: points (conference class points, or journal percentile); null if not rated
  class?: string;            // 1.0: the class ('A++' … 'Work in progress'; journals '200' … '20', 'Not rated')
  confidence: { present: number; total: number }; // how many sub-scores (0.1-demo) or sources (1.0) had data
  breakdown: ScoreBreakdown;
  flags: string[];           // e.g. 'retraction wave', 'not indexed'
  formulaVersion: string;
  computedAt: string;
}

/** Output of the compute step, before signing. */
export interface ReputationScore {
  payload: ScorePayload;
  manifest: ProvenanceManifest;
}

/** A signed score, packaged as a W3C Verifiable Credential (JWT). */
export interface ScoreVC {
  jwt: string;
  issuer: string;            // platform DID
  subject: string;           // venue DID
  issuanceDate: string;
  payload: ScorePayload;
  manifest: ProvenanceManifest;
}

// ─── Identity ────────────────────────────────────────────────

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  did: string;               // did:key form of the public key
}

export interface Identity {
  did: string;
  role: 'venue' | 'platform';
  rotationKeyPair: KeyPair;  // controls the DID (may be shared by a group)
  signingKeyPair: KeyPair;   // unique to this identity
  plcOperation?: object;
}
