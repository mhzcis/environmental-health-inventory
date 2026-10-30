export const SYNC_META_FIELD = '__sync' as const;

export interface SyncMetadata {
  revision: number;
  mutationId?: string;
  updatedBy?: string;
  updatedAt?: unknown;
}

export interface SyncStateToken {
  revision: number;
  mutationId: string;
}

export interface SnapshotMetadataLike {
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export type SyncExpectation =
  | { kind: 'missing' }
  | {
      kind: 'present';
      /** Local change-detection convenience only; never sufficient receipt/rules proof. */
      fingerprint: string;
      /** Authoritative baseline for documents already governed by Receipt v4. */
      stateToken?: SyncStateToken;
      /** Exact bootstrap baseline for an unversioned legacy document. */
      exactLegacyPayload?: Record<string, unknown>;
      /** P2/P3 read compatibility. New code uses stateToken.revision. */
      revision?: number;
      /** Capacity-only estimate of the current document plus automatic index entries. */
      baselineRequestBytes?: number;
    };

export type SyncConflictReason =
  | 'baseline-required'
  | 'remote-created'
  | 'remote-deleted'
  | 'remote-changed';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasSyncEnvelope = (value: unknown): boolean =>
  isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, SYNC_META_FIELD);

/**
 * Removes only the top-level Firestore synchronization envelope. Application data nested below
 * the document root is preserved even when it contains a property named "__sync".
 */
export const stripSyncMetadata = <T>(value: T): T => {
  if (!isPlainObject(value) || !(SYNC_META_FIELD in value)) return value;
  const clean = { ...value };
  delete clean[SYNC_META_FIELD];
  return clean as T;
};

export const readSyncMetadata = (value: unknown): SyncMetadata | undefined => {
  if (!isPlainObject(value)) return undefined;
  const raw = value[SYNC_META_FIELD];
  if (!isPlainObject(raw)) return undefined;
  const revision = Number(raw.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return undefined;
  return {
    revision,
    mutationId: typeof raw.mutationId === 'string' ? raw.mutationId : undefined,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : undefined,
    updatedAt: raw.updatedAt,
  };
};

export const readSyncRevision = (value: unknown): number => readSyncMetadata(value)?.revision ?? 0;

const normalizeForCanonicalJson = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Infinity) return { $number: 'Infinity' };
    if (value === -Infinity) return { $number: '-Infinity' };
    if (Object.is(value, -0)) return { $number: '-0' };
    return value;
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value !== 'object') return { $unsupported: typeof value };

  if (seen.has(value)) throw new Error('SYNC_VALUE_CYCLIC');
  seen.add(value);
  try {
    const timestampLike = value as { toDate?: () => Date };
    if (typeof timestampLike.toDate === 'function') {
      const date = timestampLike.toDate();
      if (date instanceof Date && !Number.isNaN(date.getTime())) return { $date: date.toISOString() };
    }
    if (Array.isArray(value)) return value.map(item => normalizeForCanonicalJson(item, seen));

    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = normalizeForCanonicalJson((value as Record<string, unknown>)[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
};

export const canonicalProofValue = (value: unknown): string =>
  JSON.stringify(normalizeForCanonicalJson(value, new WeakSet()));

export const canonicalSyncValue = (value: unknown): string =>
  canonicalProofValue(stripSyncMetadata(value));

/**
 * A deterministic 64-bit FNV-1a content fingerprint plus canonical byte length. It is a compact
 * change detector, not an authorization or cryptographic primitive; Firestore Rules remain the
 * security boundary and the revision is checked alongside it when available.
 */
export const fingerprintDocument = (value: unknown): string => {
  const canonical = canonicalSyncValue(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < canonical.length; index += 1) {
    const codePoint = canonical.charCodeAt(index);
    hash ^= BigInt(codePoint & 0xff);
    hash = (hash * prime) & mask;
    hash ^= BigInt(codePoint >>> 8);
    hash = (hash * prime) & mask;
  }
  return `${canonical.length.toString(16)}:${hash.toString(16).padStart(16, '0')}`;
};

/** One canonical fingerprint contract shared by every receipt producer. */
export const fingerprintSyncOperation = (operation: {
  kind: 'set' | 'delete';
  collection: string;
  docId: string;
  expected: SyncExpectation;
  value?: Record<string, unknown>;
}): string => {
  const path = `${operation.collection}/${operation.docId}`;
  return fingerprintDocument({
    op: operation.kind,
    path,
    expected: operation.expected,
    ...(operation.kind === 'set' ? { value: operation.value } : {}),
  });
};

export const shouldAcceptAuthoritativeSnapshot = (metadata: SnapshotMetadataLike): boolean =>
  metadata.fromCache === false && metadata.hasPendingWrites === false;

export const expectationForDocument = (
  value: unknown,
  authoritativeState?: SyncStateToken,
): SyncExpectation => {
  if (value === null || value === undefined) return { kind: 'missing' };
  const metadata = readSyncMetadata(value);
  const stateToken = authoritativeState
    ?? (metadata?.mutationId ? { revision: metadata.revision, mutationId: metadata.mutationId } : undefined);
  const clean = stripSyncMetadata(value);
  return {
    kind: 'present',
    fingerprint: fingerprintDocument(clean),
    ...(stateToken ? { stateToken, revision: stateToken.revision } : {
      // A document carrying malformed/incomplete sync metadata is not legacy. Omitting exact proof
      // makes durability validation fail closed instead of silently stripping an invalid token.
      exactLegacyPayload: !hasSyncEnvelope(value) && isPlainObject(clean) ? clean : undefined,
      revision: metadata?.revision,
    }),
  };
};

export const evaluateSyncExpectation = (
  expectation: SyncExpectation | undefined,
  remoteValue: unknown,
): { matches: true } | { matches: false; reason: SyncConflictReason } => {
  if (!expectation) return { matches: false, reason: 'baseline-required' };
  const remoteMissing = remoteValue === null || remoteValue === undefined;
  if (expectation.kind === 'missing') {
    return remoteMissing ? { matches: true } : { matches: false, reason: 'remote-created' };
  }
  if (remoteMissing) return { matches: false, reason: 'remote-deleted' };
  if (expectation.stateToken) {
    const remoteState = readSyncMetadata(remoteValue);
    if (!remoteState
      || remoteState.revision !== expectation.stateToken.revision
      || remoteState.mutationId !== expectation.stateToken.mutationId) {
      return { matches: false, reason: 'remote-changed' };
    }
  } else if (expectation.exactLegacyPayload !== undefined) {
    if (hasSyncEnvelope(remoteValue)
      || canonicalProofValue(remoteValue) !== canonicalProofValue(expectation.exactLegacyPayload)) {
      return { matches: false, reason: 'remote-changed' };
    }
  } else if (fingerprintDocument(remoteValue) !== expectation.fingerprint) {
    return { matches: false, reason: 'remote-changed' };
  }
  if (!expectation.stateToken
    && expectation.exactLegacyPayload === undefined
    && expectation.revision !== undefined
    && readSyncRevision(remoteValue) !== expectation.revision) {
    return { matches: false, reason: 'remote-changed' };
  }
  return { matches: true };
};
