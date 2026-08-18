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
export async function getAuditLog(did: string): Promise<Array<Record<string, unknown>>> {
  const url = `https://plc.directory/${did}/log/audit`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Audit log fetch failed (${response.status}): ${body}`);
  }

  return (await response.json()) as Array<Record<string, unknown>>;
}