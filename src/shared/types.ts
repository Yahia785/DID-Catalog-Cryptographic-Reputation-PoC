// ─── Public Data ─────────────────────────────────────────────

export interface PublicDataPoint {
  metric: string;
  value: number | string;
  source: string;
  sourceUrl: string;
  fetchedAt: string;
}

// ─── Score Computation ───────────────────────────────────────

/**
 * The payload the platform signs when it computes a venue score.
 * Replaces the old RatingPayload (user-submitted scores).
 */
export interface ScorePayload {
  type: 'VenueScore';
  platform: string;          // platform DID (the issuer)
  venue: string;             // venue DID (the subject)
  verificationMethod: string; // platform's signing key reference
  score: number;
  confidence: number;
  breakdown: ScoreBreakdown;
  ratingCount: number;       // number of public data points used
  computedAt: string;
}

export interface ScoreBreakdown {
  reviewProcessRigor: number;
  editorialLegitimacy: number;
  publicationIntegrity: number;
}

// ─── Provenance ──────────────────────────────────────────────

/**
 * Everything a verifier needs to recompute the score independently.
 * Bundled inside the score VC so anyone can audit.
 */
export interface ProvenanceManifest {
  venueDID: string;
  platformDID: string;
  formula: string;           // human-readable description of the scoring formula
  formulaVersion: string;    // versioned so verifiers know which computation to replicate
  publicData: PublicDataPoint[];
  computedAt: string;
}

// ─── Reputation Score ────────────────────────────────────────

/**
 * The complete score object: the computed result + the provenance
 * manifest that lets anyone reproduce it.
 */
export interface ReputationScore {
  venueDID: string;
  platformDID: string;
  score: number;
  confidence: number;
  breakdown: ScoreBreakdown;
  dataPointCount: number;
  manifest: ProvenanceManifest;
}

// ─── Verifiable Credential ───────────────────────────────────

/**
 * A platform-issued score packaged as a W3C Verifiable Credential (JWT).
 * Replaces the old VenueRatingVC (user rating VC).
 */
export interface ScoreVC {
  jwt: string;
  decoded: {
    issuer: string;        // platform DID
    subject: string;       // venue DID
    issuanceDate: string;
    credentialSubject: ScorePayload;
    provenanceManifest: ProvenanceManifest;
  };
}

// ─── Signed Score ────────────────────────────────────────────

/**
 * The raw signed score object (independent of the VC layer).
 * Allows verification without JWT libraries.
 * Replaces the old SignedRating.
 */
export interface SignedScore {
  payload: ScorePayload;
  manifest: ProvenanceManifest;
  signature: string;       // base64url ECDSA signature
  payloadHash: string;     // SHA-256 of canonical payload
}

// ─── Identity ────────────────────────────────────────────────

export interface Identity {
  did: string;
  role: 'researcher' | 'venue' | 'platform';
  rotationKeyPair: {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    did: string;
  };
  signingKeyPair: {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    did: string;
  };
  plcOperation?: object;
}

// ─── Verification ────────────────────────────────────────────

/**
 * Result of verifying a platform's signature on a score.
 * Replaces the old VerificationResult (user rating verification).
 */
export interface VerificationResult {
  valid: boolean;
  platformDID: string;
  venueDID: string;
  verificationMethod: string;
  error?: string;
}

/**
 * Result of recomputing a score from its provenance manifest
 * and comparing to the claimed score.
 */
export interface ScoreVerificationResult {
  match: boolean;
  claimedScore: number;
  recomputedScore: number;
  dataPointsVerified: number;
  staleDataPoints: number;
  errors: string[];
}

// ─── Threat Scenarios ────────────────────────────────────────

export interface ThreatResult {
  scenario: string;
  description: string;
  detected: boolean;
  details: string;
}