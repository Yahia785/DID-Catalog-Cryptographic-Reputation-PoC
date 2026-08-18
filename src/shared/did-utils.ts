import * as atprotoCrypto from '@atproto/crypto';

export interface DIDDocument {
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  createdAt: string;
  publishedToAtproto?: boolean;
  publishedAt?: string;
}

export interface VerificationMethod {
  id: string;
  type: string;
  publicKeyMultibase: string;
  controller: string;
}

export function createDIDDocument(
  did: string,
  rotationKeyMultibase: string,
  signingKeyMultibase: string
): DIDDocument {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#rotation-1`,
        type: 'Multikey',
        publicKeyMultibase: rotationKeyMultibase,
        controller: did,
      },
      {
        id: `${did}#signing-1`,
        type: 'Multikey',
        publicKeyMultibase: signingKeyMultibase,
        controller: did,
      },
    ],
    authentication: [`${did}#signing-1`],
    createdAt: new Date().toISOString(),
  };
}

export function encodePublicKeyToMultibase(did: string): string {
  return atprotoCrypto.extractMultikey(did);
}

export function decodeMultibasePublicKey(multikey: string): Uint8Array {
  const parsed = atprotoCrypto.parseMultikey(multikey);
  return parsed.keyBytes;
}