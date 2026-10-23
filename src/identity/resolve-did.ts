export interface ResolvedDIDDocument {
  id: string;
  alsoKnownAs: string[];
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase: string;
  }>;
  service: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
}

/**
 * Resolve a DID:PLC from plc.directory and return the DID document.
 */
export async function resolveDID(did: string): Promise<ResolvedDIDDocument> {
  const url = `https://plc.directory/${did}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/did+ld+json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`DID resolution failed (${response.status}): ${body}`);
  }

  return (await response.json()) as ResolvedDIDDocument;
}

/**
 * Fetch the full PLC operation log (audit trail) for a DID.
 */
export async function getAuditLog(did: string): Promise<AuditEntry[]> {
  const url = `https://plc.directory/${did}/log/audit`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Audit log fetch failed (${response.status}): ${body}`);
  }

  return (await response.json()) as AuditEntry[];
}

/** One entry of a plc.directory audit log (/log/audit). `local` marks entries built from a saved genesis op, never fetched. */
export interface AuditEntry {
  did: string;
  operation: {
    type?: string;
    verificationMethods?: Record<string, string>;
    alsoKnownAs?: string[];
    [k: string]: unknown;
  };
  cid: string;
  nullified: boolean;
  createdAt: string;
  local?: boolean;
}

/** Where a verifier gets a DID's operation history from. `via` is shown in check details. */
export interface DidResolver {
  via: string;
  auditLog(did: string): Promise<AuditEntry[]>;
}

export const onlineResolver: DidResolver = { via: 'plc.directory', auditLog: getAuditLog };
