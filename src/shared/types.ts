// ─── Venues ──────────────────────────────────────────────────

export type VenueType = 'conference' | 'journal';

// ─── Provenance ──────────────────────────────────────────────

/**
 * One source file in a data snapshot. The verifier re-hashes the file
 * and compares it to sha256 to prove the inputs were not changed.
 */
export interface SourceSnapshot {
  id: string;               // short id used by inputs, e.g. 'openalex'
  name: string;             // human-readable, e.g. 'OpenAlex API'
  access: 'api' | 'csv';
  edition?: string;         // for exported files, e.g. 'ICORE2026'
  url: string;              // where the data came from
  retrievedAt: string;      // ISO timestamp
  file: string;             // snapshot file path, relative to the project
  sha256: string;           // hash of that file
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
  computedAt: string;
}

// ─── Score ───────────────────────────────────────────────────

/** Sub-scores on a 0–1 scale. null = input missing, left out of the average. */
export interface ScoreBreakdown {
  standing: number | null;
  impact: number | null;
  stability: number | null;
  integrity: number | null;
}

/** The claim the platform signs about a venue. */
export interface ScorePayload {
  type: 'VenueScore';
  platform: string;          // platform DID (issuer)
  venue: string;             // venue DID (subject)
  venueType: VenueType;
  verificationMethod: string; // platform signing key reference, e.g. did:plc:...#signing-1
  score: number | null;      // 0–100; null if no sub-score could be computed
  confidence: { present: number; total: number }; // how many sub-scores had data
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
  role: 'researcher' | 'venue' | 'platform';
  rotationKeyPair: KeyPair;  // controls the DID (may be shared by a group)
  signingKeyPair: KeyPair;   // unique to this identity
  plcOperation?: object;
}

// ─── Verification ────────────────────────────────────────────

export interface ScoreVerificationResult {
  signatureValid: boolean;
  hashesValid: boolean;
  recomputeMatch: boolean;
  claimedScore: number | null;
  recomputedScore: number | null;
  staleSources: string[];
  errors: string[];
}

export interface ThreatResult {
  scenario: string;
  description: string;
  detected: boolean;
  details: string;
}
