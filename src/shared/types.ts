export interface RatingPayload {
  type: 'VenueRating';
  reviewer: string;
  venue: string;
  verificationMethod: string;
  ratings: {
    legitimacy: number;
    reviewQuality: number;
    overall: number;
  };
  timestamp: string;
}

export interface SignedRating {
  payload: RatingPayload;
  signature: string;
  payloadHash: string;
}

export interface VenueRatingVC {
  jwt: string;
  decoded: {
    issuer: string;
    subject: string;
    issuanceDate: string;
    credentialSubject: RatingPayload;
  };
}

export interface PublicDataPoint {
  metric: string;
  value: number | string;
  source: string;
  fetchedAt: string;
}

export interface ProvenanceManifest {
  venueDID: string;
  formula: string;
  signedRatings: Array<{
    reviewerDID: string;
    signatureHash: string;
    verified: boolean;
  }>;
  publicData: PublicDataPoint[];
  computedAt: string;
}

export interface ReputationScore {
  venueDID: string;
  score: number;
  confidence: number;
  breakdown: {
    legitimacy: number;
    reviewQuality: number;
    overall: number;
  };
  ratingCount: number;
  manifest: ProvenanceManifest;
}

export interface Identity {
  did: string;
  role: 'researcher' | 'venue';
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

export interface VerificationResult {
  valid: boolean;
  reviewerDID: string;
  venueDID: string;
  verificationMethod: string;
  error?: string;
}

export interface ScoreVerificationResult {
  match: boolean;
  claimedScore: number;
  recomputedScore: number;
  ratingsVerified: number;
  ratingsFailed: number;
  errors: string[];
}

export interface ThreatResult {
  scenario: string;
  description: string;
  detected: boolean;
  details: string;
}