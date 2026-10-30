export const OFFLINE_DOMAIN_DB_NAME = 'remix_inventory_domain_v1';
export const OFFLINE_DOMAIN_SCHEMA_VERSION = 1;
export const OFFLINE_DOMAIN_DB_VERSION = 4;
export const OFFLINE_PROJECTION_OWNER_KEY = 'remix_offline_projection_owner_v1';
export const OFFLINE_LEGACY_MIGRATION_KEY = 'remix_offline_legacy_migrated_v1';

export const OFFLINE_DOMAIN_STORAGE_KEYS = [
  'remix_materials_v1',
  'remix_pesticides_v1',
  'remix_transactions_v1',
  'remix_audit_logs_v1',
  'remix_settings_v1',
  'remix_users_v1',
  'remix_generator_logs_v1',
  'inventory_app_storehouse_scope_v2',
  'inventory_app_storehouse_filter',
  'remix_offline_auth_validation_v1',
] as const;

const JSON_STORAGE_KEYS = new Set<string>(OFFLINE_DOMAIN_STORAGE_KEYS.slice(0, 7));
const SNAPSHOTS_STORE = 'snapshots';
const JOURNALS_STORE = 'mutation_journals';
const META_STORE = 'meta';
const JOURNAL_COLLECTIONS = new Set(['settings', 'materials', 'transactions', 'audit_logs', 'generator_logs']);
const JOURNAL_SCHEMA_META_KEY = 'journal_schema';
const JOURNAL_SCHEMA_VERSION = 4;
const JOURNAL_MIGRATION_LEASE_MS = 30_000;

interface JournalMigrationMeta {
  key: typeof JOURNAL_SCHEMA_META_KEY;
  version: number;
  state: 'pending' | 'migrating' | 'complete' | 'failed';
  owner?: string;
  leaseUntil?: number;
  error?: string;
}

export interface OfflineMutationJournal {
  id: string;
  userId: string;
  createdAt: number;
  sequence: number;
  snapshotRevision: number;
  snapshotChecksum: string;
  operationDigest: string;
  syncProtocolVersion?: 4;
  input: { operations: unknown[]; label?: string };
}

export interface OfflineDomainSnapshot {
  version: typeof OFFLINE_DOMAIN_SCHEMA_VERSION;
  userId: string;
  revision: number;
  updatedAt: number;
  values: Record<string, string | null>;
  checksum: string;
}

export interface OfflineDomainSnapshotStore {
  get(userId: string): Promise<OfflineDomainSnapshot | undefined>;
  put(snapshot: OfflineDomainSnapshot): Promise<void>;
  compareAndSwap(userId: string, expectedRevision: number | null, snapshot: OfflineDomainSnapshot, assertBeforeWrite?: () => void): Promise<boolean>;
  nextJournalSequence(userId: string): Promise<number>;
  commitWithJournal(expectedRevision: number, snapshot: OfflineDomainSnapshot, journal: OfflineMutationJournal, assertBeforeWrite?: () => void): Promise<boolean>;
  rollbackJournal(journal: OfflineMutationJournal, snapshot: OfflineDomainSnapshot): Promise<boolean>;
  listJournals(userId: string): Promise<OfflineMutationJournal[]>;
  deleteJournal(userId: string, id: string): Promise<void>;
  claimLegacyMigration(userId: string): Promise<string>;
  delete(userId: string, assertBeforeWrite?: () => void): Promise<void>;
}

export interface OfflineDomainActivation {
  userId: string;
  source: 'restored' | 'migrated' | 'empty';
  revision: number;
}

export class OfflineDomainSessionChangedError extends Error {
  readonly userId: string;
  readonly committedJournal?: OfflineMutationJournal;

  constructor(userId: string, committedJournal?: OfflineMutationJournal) {
    super(committedJournal
      ? 'OFFLINE_DOMAIN_SESSION_CHANGED_AFTER_COMMIT'
      : 'OFFLINE_DOMAIN_SESSION_CHANGED');
    this.name = 'OfflineDomainSessionChangedError';
    this.userId = userId;
    this.committedJournal = committedJournal;
  }
}

export class OfflineDomainJournalRecoveryRequiredError extends Error {
  readonly committedJournal: OfflineMutationJournal;

  constructor(journal: OfflineMutationJournal, cause: unknown) {
    super(`OFFLINE_DOMAIN_JOURNAL_RECOVERY_REQUIRED:${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'OfflineDomainJournalRecoveryRequiredError';
    this.committedJournal = journal;
  }
}

export class OfflineDomainProjectionRecoveryRequiredError extends Error {
  readonly userId: string;
  readonly cause: unknown;

  constructor(userId: string, cause: unknown) {
    super('OFFLINE_DOMAIN_PROJECTION_RECOVERY_REQUIRED');
    this.name = 'OfflineDomainProjectionRecoveryRequiredError';
    this.userId = userId;
    this.cause = cause;
  }
}

const normalizeUserId = (userId: string): string => {
  const normalized = userId.trim();
  if (!normalized || normalized.includes('/')) throw new Error('OFFLINE_DOMAIN_USER_INVALID');
  return normalized;
};

const checksumFor = (userId: string, revision: number, values: Record<string, string | null>): string => {
  const input = JSON.stringify({ version: OFFLINE_DOMAIN_SCHEMA_VERSION, userId, revision, values });
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const assertValidValues: (values: unknown) => asserts values is Record<string, string | null> = (values) => {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('OFFLINE_DOMAIN_VALUES_INVALID');
  for (const key of OFFLINE_DOMAIN_STORAGE_KEYS) {
    const value = (values as Record<string, unknown>)[key];
    if (value !== null && typeof value !== 'string') throw new Error(`OFFLINE_DOMAIN_VALUE_INVALID:${key}`);
    if (typeof value === 'string' && JSON_STORAGE_KEYS.has(key)) {
      try {
        const parsed = JSON.parse(value);
        if (key === 'remix_settings_v1') {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-settings');
        } else if (!Array.isArray(parsed)) {
          throw new Error('invalid-list');
        }
      } catch (_) {
        throw new Error(`OFFLINE_DOMAIN_CORRUPT:${key}`);
      }
    }
    if (key === 'remix_offline_auth_validation_v1' && typeof value === 'string') {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (typeof parsed.userId !== 'string' || !Number.isSafeInteger(parsed.validatedAt)) throw new Error('invalid-auth-validation');
      } catch (_) {
        throw new Error(`OFFLINE_DOMAIN_CORRUPT:${key}`);
      }
    }
  }
};

export const validateOfflineDomainSnapshot = (snapshot: OfflineDomainSnapshot, expectedUserId: string): void => {
  if (!snapshot || snapshot.version !== OFFLINE_DOMAIN_SCHEMA_VERSION) throw new Error('OFFLINE_DOMAIN_VERSION_UNSUPPORTED');
  if (snapshot.userId !== expectedUserId) throw new Error('OFFLINE_DOMAIN_USER_MISMATCH');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw new Error('OFFLINE_DOMAIN_REVISION_INVALID');
  if (!Number.isSafeInteger(snapshot.updatedAt) || snapshot.updatedAt < 0) throw new Error('OFFLINE_DOMAIN_TIMESTAMP_INVALID');
  assertValidValues(snapshot.values);
  if (snapshot.checksum !== checksumFor(snapshot.userId, snapshot.revision, snapshot.values)) {
    throw new Error('OFFLINE_DOMAIN_CHECKSUM_MISMATCH');
  }
};

const canonicalJournalValue = (value: unknown, seen = new WeakSet<object>()): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('OFFLINE_DOMAIN_JOURNAL_NON_FINITE_NUMBER');
    // JSON has no negative-zero representation. Canonicalize both zero spellings to the same byte.
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('OFFLINE_DOMAIN_JOURNAL_VALUE_UNSUPPORTED');
  }
  if (!value || typeof value !== 'object') throw new Error('OFFLINE_DOMAIN_JOURNAL_VALUE_UNSUPPORTED');
  if (seen.has(value)) throw new Error('OFFLINE_DOMAIN_JOURNAL_VALUE_CYCLIC');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error('OFFLINE_DOMAIN_JOURNAL_ARRAY_PROTOTYPE_INVALID');
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error('OFFLINE_DOMAIN_JOURNAL_VALUE_SYMBOL_KEY_INVALID');
      }
      const allowedNames = new Set(['length', ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (Object.getOwnPropertyNames(value).some(key => !allowedNames.has(key))) {
        throw new Error('OFFLINE_DOMAIN_JOURNAL_ARRAY_PROPERTY_INVALID');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error('OFFLINE_DOMAIN_JOURNAL_ARRAY_HOLE');
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error('OFFLINE_DOMAIN_JOURNAL_VALUE_DESCRIPTOR_INVALID');
        if (descriptor.value === undefined) throw new Error('OFFLINE_DOMAIN_JOURNAL_ARRAY_UNDEFINED');
      }
      return `[${value.map(item => canonicalJournalValue(item, seen)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_OBJECT_PROTOTYPE_INVALID');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_VALUE_SYMBOL_KEY_INVALID');
    }
    const entries: string[] = [];
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('OFFLINE_DOMAIN_JOURNAL_VALUE_DESCRIPTOR_INVALID');
      }
      const nested = descriptor.value;
      // Match JSON object semantics for optional fields such as expected.revision: undefined.
      // Arrays remain positional and reject undefined above instead of silently converting it.
      if (nested === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalJournalValue(nested, seen)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
};

const journalDigestPayload = (journal: Omit<OfflineMutationJournal, 'operationDigest'>): Record<string, unknown> => ({
  algorithm: 'SHA-256',
  id: journal.id,
  userId: journal.userId,
  createdAt: journal.createdAt,
  sequence: journal.sequence,
  snapshotBinding: {
    revision: journal.snapshotRevision,
    checksum: journal.snapshotChecksum,
  },
  ...(journal.syncProtocolVersion === 4 ? { syncProtocolVersion: 4 } : {}),
  input: journal.input,
});

export const computeOfflineMutationJournalDigest = async (
  journal: Omit<OfflineMutationJournal, 'operationDigest'>,
): Promise<string> => {
  // This unkeyed SHA-256 digest detects accidental/corrupt durable intent changes. It is not a
  // secret, signature, authentication mechanism, or replacement for Firebase authorization.
  if (!globalThis.crypto?.subtle) throw new Error('OFFLINE_DOMAIN_SHA256_UNAVAILABLE');
  const bytes = new TextEncoder().encode(canonicalJournalValue(journalDigestPayload(journal)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
};

export const validateOfflineMutationJournal = (value: unknown): OfflineMutationJournal => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OFFLINE_DOMAIN_JOURNAL_INVALID');
  const journal = value as Partial<OfflineMutationJournal>;
  if (typeof journal.id !== 'string' || !journal.id || journal.id.includes('/')) throw new Error('OFFLINE_DOMAIN_JOURNAL_ID_INVALID');
  if (typeof journal.userId !== 'string' || !journal.userId || journal.userId.includes('/')) throw new Error('OFFLINE_DOMAIN_JOURNAL_USER_INVALID');
  if (!Number.isSafeInteger(journal.createdAt) || Number(journal.createdAt) < 0) throw new Error('OFFLINE_DOMAIN_JOURNAL_TIMESTAMP_INVALID');
  if (!Number.isSafeInteger(journal.snapshotRevision) || Number(journal.snapshotRevision) < 2) {
    throw new Error('OFFLINE_DOMAIN_JOURNAL_REVISION_INVALID');
  }
  // DB v2 journals did not persist an explicit FIFO sequence. Their snapshot revision is already
  // a per-user monotonic sequence, so normalize it during the v3 read without weakening ordering.
  const sequence = journal.sequence ?? journal.snapshotRevision;
  if (!Number.isSafeInteger(sequence) || Number(sequence) < 1) throw new Error('OFFLINE_DOMAIN_JOURNAL_SEQUENCE_INVALID');
  if (typeof journal.snapshotChecksum !== 'string' || !/^[0-9a-f]{8}$/.test(journal.snapshotChecksum)) {
    throw new Error('OFFLINE_DOMAIN_JOURNAL_CHECKSUM_INVALID');
  }
  if (typeof journal.operationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(journal.operationDigest)) {
    throw new Error('OFFLINE_DOMAIN_JOURNAL_DIGEST_INVALID');
  }
  if (journal.syncProtocolVersion !== undefined && journal.syncProtocolVersion !== 4) {
    throw new Error('OFFLINE_DOMAIN_JOURNAL_SYNC_PROTOCOL_INVALID');
  }
  if (!journal.input || typeof journal.input !== 'object' || Array.isArray(journal.input)
    || !Object.hasOwn(journal.input, 'operations') || !Array.isArray(journal.input.operations)
    || journal.input.operations.length === 0 || journal.input.operations.length > 450) {
    throw new Error('OFFLINE_DOMAIN_JOURNAL_OPERATIONS_INVALID');
  }
  // Validate exactly the same JSON-only graph that the digest canonicalizes. This must run before
  // callers trust or persist a digest so non-JSON values cannot collapse onto a valid JSON payload.
  canonicalJournalValue(journal.input);
  if (journal.input.label !== undefined && typeof journal.input.label !== 'string') {
    throw new Error('OFFLINE_DOMAIN_JOURNAL_LABEL_INVALID');
  }
  const documentKeys = new Set<string>();
  for (const operation of journal.input.operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_OPERATION_INVALID');
    }
    const candidate = operation as Record<string, unknown>;
    if (!Object.hasOwn(candidate, 'kind') || !Object.hasOwn(candidate, 'collection')
      || !Object.hasOwn(candidate, 'docId') || !Object.hasOwn(candidate, 'expected')
      || (candidate.kind !== 'set' && candidate.kind !== 'delete')
      || typeof candidate.collection !== 'string' || !JOURNAL_COLLECTIONS.has(candidate.collection)
      || typeof candidate.docId !== 'string' || !candidate.docId || candidate.docId.includes('/')) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_OPERATION_INVALID');
    }
    const documentKey = `${candidate.collection}/${candidate.docId}`;
    if (documentKeys.has(documentKey)) throw new Error('OFFLINE_DOMAIN_JOURNAL_DUPLICATE_DOCUMENT');
    documentKeys.add(documentKey);
    const expected = candidate.expected as Record<string, unknown> | undefined;
    if (!expected || !Object.hasOwn(expected, 'kind') || (expected.kind !== 'missing' && expected.kind !== 'present')) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_EXPECTATION_INVALID');
    }
    if (expected.kind === 'present' && (!Object.hasOwn(expected, 'fingerprint') || typeof expected.fingerprint !== 'string')) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_EXPECTATION_INVALID');
    }
    const stateToken = expected.stateToken;
    const exactLegacyPayload = expected.exactLegacyPayload;
    if (stateToken !== undefined && (
      !stateToken || typeof stateToken !== 'object' || Array.isArray(stateToken)
      || !Number.isSafeInteger((stateToken as Record<string, unknown>).revision)
      || Number((stateToken as Record<string, unknown>).revision) < 1
      || typeof (stateToken as Record<string, unknown>).mutationId !== 'string'
      || !(stateToken as Record<string, unknown>).mutationId
      || String((stateToken as Record<string, unknown>).mutationId).includes('/')
    )) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_STATE_TOKEN_INVALID');
    }
    if (exactLegacyPayload !== undefined && (
      !exactLegacyPayload || typeof exactLegacyPayload !== 'object' || Array.isArray(exactLegacyPayload)
      || Object.prototype.hasOwnProperty.call(exactLegacyPayload, '__sync')
    )) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_LEGACY_BASELINE_INVALID');
    }
    if (stateToken !== undefined && exactLegacyPayload !== undefined) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_BASELINE_AMBIGUOUS');
    }
    if (journal.syncProtocolVersion === 4 && expected.kind === 'present'
      && stateToken === undefined && exactLegacyPayload === undefined) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_BASELINE_PROOF_REQUIRED');
    }
    if (Object.hasOwn(expected, 'revision') && expected.revision !== undefined
      && (!Number.isSafeInteger(expected.revision) || Number(expected.revision) < 0)) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_EXPECTATION_INVALID');
    }
    if (candidate.kind === 'delete' && expected.kind !== 'present') {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_DELETE_BASELINE_INVALID');
    }
    if (candidate.kind === 'set' && (!Object.hasOwn(candidate, 'value') || !candidate.value
      || typeof candidate.value !== 'object' || Array.isArray(candidate.value))) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_VALUE_INVALID');
    }
  }
  return { ...(journal as OfflineMutationJournal), sequence: Number(sequence) };
};

export const validateOfflineMutationJournalChain = async (
  snapshot: OfflineDomainSnapshot,
  journals: OfflineMutationJournal[],
): Promise<OfflineMutationJournal[]> => {
  validateOfflineDomainSnapshot(snapshot, snapshot.userId);
  const validated = journals.map(validateOfflineMutationJournal);
  if (validated.some(journal => journal.userId !== snapshot.userId)) throw new Error('OFFLINE_DOMAIN_JOURNAL_USER_MISMATCH');
  await Promise.all(validated.map(async journal => {
    const { operationDigest, ...payload } = journal;
    if (await computeOfflineMutationJournalDigest(payload) !== operationDigest) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_DIGEST_MISMATCH');
    }
  }));
  const ordered = validated
    .sort((left, right) => left.sequence - right.sequence || left.snapshotRevision - right.snapshotRevision || left.id.localeCompare(right.id));
  for (let index = 0; index < ordered.length; index += 1) {
    const journal = ordered[index];
    if (journal.snapshotRevision > snapshot.revision) throw new Error('OFFLINE_DOMAIN_JOURNAL_FUTURE_SNAPSHOT');
    if (index > 0 && (journal.sequence <= ordered[index - 1].sequence
      || journal.snapshotRevision <= ordered[index - 1].snapshotRevision)) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_ORDER_INVALID');
    }
  }
  return ordered;
};

const requestAsPromise = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('OFFLINE_DOMAIN_REQUEST_FAILED'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('OFFLINE_DOMAIN_TRANSACTION_ABORTED'));
  transaction.onerror = () => reject(transaction.error ?? new Error('OFFLINE_DOMAIN_TRANSACTION_FAILED'));
});

const normalizePersistenceError = (error: unknown): Error => {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
  if (name === 'QuotaExceededError') return new Error('OFFLINE_DOMAIN_QUOTA_EXCEEDED');
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`OFFLINE_DOMAIN_PERSIST_FAILED:${message}`);
};

const metaValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => metaValuesEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && metaValuesEqual(leftRecord[key], rightRecord[key]));
};

export class IndexedDbOfflineDomainStore implements OfflineDomainSnapshotStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private openCount = 0;
  private readonly migrationOwner = `journal-migration-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;

  constructor(private readonly indexedDb: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.indexedDb) return Promise.reject(new Error('INDEXEDDB_UNAVAILABLE'));
    if (this.dbPromise) return this.dbPromise;
    let resolveOpening!: (db: IDBDatabase) => void;
    let rejectOpening!: (error: unknown) => void;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      resolveOpening = resolve;
      rejectOpening = reject;
    });
    // Publish the attempt before calling IDBFactory.open: a synchronous implementation error must
    // not leave a permanently rejected promise cached, and every callback below is fenced to this
    // exact attempt rather than whichever retry happens to be current.
    this.dbPromise = opening;
    this.openCount += 1;
    let request: IDBOpenDBRequest;
    let state: 'opening' | 'migrating' | 'resolved' | 'abandoned' = 'opening';
    let openedDb: IDBDatabase | null = null;
    let connectionClosed = false;
    const clearAttempt = () => {
      if (this.dbPromise === opening) this.dbPromise = null;
    };
    const closeConnection = () => {
      if (!openedDb || connectionClosed) return;
      connectionClosed = true;
      openedDb.close();
    };
    const abandon = (error: unknown) => {
      if (state === 'abandoned') return;
      const wasPending = state === 'opening' || state === 'migrating';
      state = 'abandoned';
      clearAttempt();
      closeConnection();
      if (wasPending) rejectOpening(error);
    };
    try {
      request = this.indexedDb.open(OFFLINE_DOMAIN_DB_NAME, OFFLINE_DOMAIN_DB_VERSION);
      request.onupgradeneeded = (event) => {
        // Capture the connection as soon as IndexedDB exposes it so a later upgrade abort/error
        // can deterministically dispose it even though request.result is no longer readable then.
        openedDb = request.result;
        if (state !== 'opening') {
          // A blocker may disappear after we have already rejected this attempt. Abort its late
          // upgrade transaction; onerror/onsuccess will then dispose the captured connection.
          try {
            request.transaction?.abort();
          } catch {
            // The transaction may already have ended. The terminal callback still owns cleanup.
          }
          return;
        }
        if (!request.result.objectStoreNames.contains(SNAPSHOTS_STORE)) {
          request.result.createObjectStore(SNAPSHOTS_STORE, { keyPath: 'userId' });
        }
        if (!request.result.objectStoreNames.contains(JOURNALS_STORE)) {
          const journals = request.result.createObjectStore(JOURNALS_STORE, { keyPath: 'id' });
          journals.createIndex('by_user', 'userId', { unique: false });
        }
        if (!request.result.objectStoreNames.contains(META_STORE)) request.result.createObjectStore(META_STORE, { keyPath: 'key' });
        if (event.oldVersion < JOURNAL_SCHEMA_VERSION) {
          request.transaction!.objectStore(META_STORE).put({
            key: JOURNAL_SCHEMA_META_KEY,
            version: JOURNAL_SCHEMA_VERSION,
            state: 'pending',
          } satisfies JournalMigrationMeta);
        }
      };
      request.onsuccess = () => {
        openedDb = request.result;
        const db = openedDb;
        if (state !== 'opening') {
          // IndexedDB can continue a previously blocked request after the caller has retried.
          // Such a connection is never migrated or exposed and is closed exactly once.
          closeConnection();
          return;
        }
        state = 'migrating';
        const invalidate = () => {
          // A long-lived shared store must not retain a fulfilled promise for a closed connection.
          // Clearing only our own opening promise also avoids an old connection invalidating a
          // replacement that has already opened.
          abandon(new Error('OFFLINE_DOMAIN_CONNECTION_INVALIDATED'));
        };
        db.onversionchange = invalidate;
        db.onclose = () => {
          if (state === 'abandoned') return;
          const wasPending = state === 'migrating';
          state = 'abandoned';
          clearAttempt();
          connectionClosed = true;
          if (wasPending) rejectOpening(new Error('OFFLINE_DOMAIN_CONNECTION_CLOSED'));
        };
        void this.ensureJournalSchemaMigration(db).then(() => {
          if (state !== 'migrating') {
            closeConnection();
            return;
          }
          state = 'resolved';
          resolveOpening(db);
        }).catch((error) => {
          abandon(error);
        });
      };
      request.onerror = () => {
        if (state === 'abandoned') {
          closeConnection();
          return;
        }
        if (state === 'opening') {
          abandon(request.error ?? new Error('OFFLINE_DOMAIN_OPEN_FAILED'));
        }
      };
      request.onblocked = () => {
        // Fail fast rather than retaining an unbounded pending promise. If the browser later
        // resumes this request, its callbacks see `abandoned` and can only abort/close it.
        if (state === 'opening') abandon(new Error('OFFLINE_DOMAIN_UPGRADE_BLOCKED'));
      };
    } catch (error) {
      abandon(error);
    }
    return opening;
  }

  private claimJournalMigration(db: IDBDatabase): Promise<'acquired' | 'complete' | 'wait'> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(META_STORE, 'readwrite');
      const store = transaction.objectStore(META_STORE);
      const request = store.get(JOURNAL_SCHEMA_META_KEY);
      let outcome: 'acquired' | 'complete' | 'wait' = 'wait';
      let failure: Error | null = null;
      request.onsuccess = () => {
        const now = Date.now();
        const current = request.result as JournalMigrationMeta | undefined;
        if (current?.state === 'complete' && current.version === JOURNAL_SCHEMA_VERSION) {
          outcome = 'complete';
          return;
        }
        if (current?.state === 'failed') {
          failure = new Error(`OFFLINE_DOMAIN_JOURNAL_MIGRATION_FAILED:${current.error || 'unknown'}`);
          return;
        }
        if (current?.state === 'migrating' && current.owner !== this.migrationOwner
          && Number(current.leaseUntil || 0) > now) {
          outcome = 'wait';
          return;
        }
        outcome = 'acquired';
        store.put({
          key: JOURNAL_SCHEMA_META_KEY,
          version: JOURNAL_SCHEMA_VERSION,
          state: 'migrating',
          owner: this.migrationOwner,
          leaseUntil: now + JOURNAL_MIGRATION_LEASE_MS,
        } satisfies JournalMigrationMeta);
      };
      request.onerror = () => reject(request.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_META_READ_FAILED'));
      transaction.oncomplete = () => failure ? reject(failure) : resolve(outcome);
      transaction.onerror = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_CLAIM_FAILED')));
      transaction.onabort = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_CLAIM_ABORTED')));
    });
  }

  private readJournalMigrationData(db: IDBDatabase): Promise<{
    journals: Array<Record<string, unknown>>;
    snapshots: OfflineDomainSnapshot[];
    meta: Array<{ key?: unknown; value?: unknown }>;
  }> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([JOURNALS_STORE, SNAPSHOTS_STORE, META_STORE], 'readonly');
      const journalsRequest = transaction.objectStore(JOURNALS_STORE).getAll();
      const snapshotsRequest = transaction.objectStore(SNAPSHOTS_STORE).getAll();
      const metaRequest = transaction.objectStore(META_STORE).getAll();
      transaction.oncomplete = () => resolve({
        journals: journalsRequest.result as Array<Record<string, unknown>>,
        snapshots: snapshotsRequest.result as OfflineDomainSnapshot[],
        meta: metaRequest.result as Array<{ key?: unknown; value?: unknown }>,
      });
      transaction.onerror = () => reject(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_READ_FAILED'));
      transaction.onabort = () => reject(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_READ_ABORTED'));
    });
  }

  private async prepareJournalMigration(db: IDBDatabase): Promise<{
    journals: OfflineMutationJournal[];
    sequenceByUser: Map<string, number>;
    sourceToken: string;
  }> {
    const source = await this.readJournalMigrationData(db);
    const snapshots = new Map(source.snapshots.map(snapshot => {
      validateOfflineDomainSnapshot(snapshot, snapshot.userId);
      return [snapshot.userId, snapshot] as const;
    }));
    const currentSequences = new Map<string, number>();
    for (const record of source.meta) {
      if (typeof record.key !== 'string' || !record.key.startsWith('journal_sequence:')) continue;
      const userId = record.key.slice('journal_sequence:'.length);
      if (normalizeUserId(userId) !== userId || typeof record.value !== 'number'
        || !Number.isSafeInteger(record.value) || record.value < 0) {
        throw new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_SEQUENCE_CORRUPT');
      }
      currentSequences.set(userId, record.value);
    }

    const byUser = new Map<string, Array<Record<string, unknown>>>();
    for (const raw of source.journals) {
      const userId = typeof raw.userId === 'string' ? normalizeUserId(raw.userId) : '';
      const snapshotRevision = Number(raw.snapshotRevision);
      const sequence = raw.sequence === undefined ? snapshotRevision : Number(raw.sequence);
      if (raw.sequence !== undefined && (!Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1)) {
        throw new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_SEQUENCE_CORRUPT');
      }
      if (raw.operationDigest !== undefined
        && (typeof raw.operationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.operationDigest))) {
        throw new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_DIGEST_CORRUPT');
      }
      const provisional: OfflineMutationJournal = {
        ...(raw as unknown as OfflineMutationJournal),
        sequence,
        operationDigest: raw.operationDigest === undefined ? '0'.repeat(64) : raw.operationDigest as string,
      };
      validateOfflineMutationJournal(provisional);
      const snapshot = snapshots.get(userId);
      if (!snapshot || provisional.snapshotRevision > snapshot.revision) {
        throw new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_SNAPSHOT_MISMATCH');
      }
      const entries = byUser.get(userId) ?? [];
      entries.push(raw);
      byUser.set(userId, entries);
    }

    const migrated: OfflineMutationJournal[] = [];
    const sequenceByUser = new Map(currentSequences);
    for (const [userId, entries] of byUser) {
      entries.sort((left, right) => {
        const leftOrder = left.sequence === undefined ? Number(left.snapshotRevision) : Number(left.sequence);
        const rightOrder = right.sequence === undefined ? Number(right.snapshotRevision) : Number(right.sequence);
        return leftOrder - rightOrder
          || Number(left.snapshotRevision) - Number(right.snapshotRevision)
          || Number(left.createdAt) - Number(right.createdAt)
          || String(left.id).localeCompare(String(right.id));
      });
      let previousSequence = 0;
      let previousRevision = 0;
      for (const raw of entries) {
        const snapshotRevision = Number(raw.snapshotRevision);
        if (snapshotRevision <= previousRevision) throw new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_ORDER_CORRUPT');
        const preferred = raw.sequence === undefined ? snapshotRevision : Number(raw.sequence);
        const sequence = Math.max(previousSequence + 1, preferred);
        const unsigned: Omit<OfflineMutationJournal, 'operationDigest'> = {
          id: String(raw.id),
          userId,
          createdAt: Number(raw.createdAt),
          sequence,
          snapshotRevision,
          snapshotChecksum: String(raw.snapshotChecksum),
          ...(raw.syncProtocolVersion === 4 ? { syncProtocolVersion: 4 } : {}),
          input: raw.input as OfflineMutationJournal['input'],
        };
        const operationDigest = await computeOfflineMutationJournalDigest(unsigned);
        if (raw.operationDigest !== undefined && raw.operationDigest !== operationDigest) {
          throw new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_DIGEST_MISMATCH');
        }
        const journal: OfflineMutationJournal = { ...unsigned, operationDigest };
        validateOfflineMutationJournal(journal);
        migrated.push(journal);
        previousSequence = sequence;
        previousRevision = snapshotRevision;
      }
      sequenceByUser.set(userId, Math.max(sequenceByUser.get(userId) ?? 0, previousSequence));
    }
    return {
      journals: migrated,
      sequenceByUser,
      sourceToken: this.journalMigrationSourceToken(source),
    };
  }

  private journalMigrationSourceToken(source: {
    journals: Array<Record<string, unknown>>;
    snapshots: OfflineDomainSnapshot[];
    meta: Array<{ key?: unknown; value?: unknown }>;
  }): string {
    const journals = [...source.journals].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const snapshots = [...source.snapshots].sort((left, right) => String(left.userId).localeCompare(String(right.userId)));
    const sequences = source.meta
      .filter(record => typeof record.key === 'string' && record.key.startsWith('journal_sequence:'))
      .sort((left, right) => String(left.key).localeCompare(String(right.key)));
    return canonicalJournalValue({ journals, snapshots, sequences });
  }

  private commitJournalMigration(
    db: IDBDatabase,
    migration: { journals: OfflineMutationJournal[]; sequenceByUser: Map<string, number>; sourceToken: string },
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([JOURNALS_STORE, SNAPSHOTS_STORE, META_STORE], 'readwrite');
      const meta = transaction.objectStore(META_STORE);
      const markerRequest = meta.get(JOURNAL_SCHEMA_META_KEY);
      const journalsRequest = transaction.objectStore(JOURNALS_STORE).getAll();
      const snapshotsRequest = transaction.objectStore(SNAPSHOTS_STORE).getAll();
      const metaRequest = meta.getAll();
      let committed = false;
      let completedRequests = 0;
      let failure: Error | null = null;
      const finishPreparation = () => {
        completedRequests += 1;
        if (completedRequests !== 4) return;
        const marker = markerRequest.result as JournalMigrationMeta | undefined;
        if (marker?.state !== 'migrating' || marker.owner !== this.migrationOwner) return;
        try {
          const currentToken = this.journalMigrationSourceToken({
            journals: journalsRequest.result as Array<Record<string, unknown>>,
            snapshots: snapshotsRequest.result as OfflineDomainSnapshot[],
            meta: metaRequest.result as Array<{ key?: unknown; value?: unknown }>,
          });
          // A v4-capable writer may still exist in another tab. Never mark the migration complete
          // over a journal/snapshot/counter set that changed after the digest preparation pass.
          if (currentToken !== migration.sourceToken) return;
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
          transaction.abort();
          return;
        }
        const journals = transaction.objectStore(JOURNALS_STORE);
        for (const journal of migration.journals) journals.put(journal);
        for (const [userId, sequence] of migration.sequenceByUser) {
          meta.put({ key: `journal_sequence:${userId}`, value: sequence });
        }
        meta.put({
          key: JOURNAL_SCHEMA_META_KEY,
          version: JOURNAL_SCHEMA_VERSION,
          state: 'complete',
        } satisfies JournalMigrationMeta);
        committed = true;
      };
      markerRequest.onsuccess = finishPreparation;
      journalsRequest.onsuccess = finishPreparation;
      snapshotsRequest.onsuccess = finishPreparation;
      metaRequest.onsuccess = finishPreparation;
      transaction.oncomplete = () => resolve(committed);
      transaction.onerror = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_COMMIT_FAILED')));
      transaction.onabort = () => reject(failure ?? normalizePersistenceError(
        transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_COMMIT_ABORTED'),
      ));
    });
  }

  private markJournalMigrationFailed(db: IDBDatabase, error: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      const transaction = db.transaction(META_STORE, 'readwrite');
      const store = transaction.objectStore(META_STORE);
      const request = store.get(JOURNAL_SCHEMA_META_KEY);
      let marked = false;
      request.onsuccess = () => {
        const marker = request.result as JournalMigrationMeta | undefined;
        if (marker?.state !== 'migrating' || marker.owner !== this.migrationOwner) return;
        store.put({
          key: JOURNAL_SCHEMA_META_KEY,
          version: JOURNAL_SCHEMA_VERSION,
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        } satisfies JournalMigrationMeta);
        marked = true;
      };
      transaction.oncomplete = () => resolve(marked);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    });
  }

  private async ensureJournalSchemaMigration(db: IDBDatabase): Promise<void> {
    const deadline = Date.now() + (JOURNAL_MIGRATION_LEASE_MS * 2) + 1_000;
    while (Date.now() < deadline) {
      const claim = await this.claimJournalMigration(db);
      if (claim === 'complete') return;
      if (claim === 'wait') {
        await new Promise(resolve => setTimeout(resolve, 25));
        continue;
      }
      try {
        const migration = await this.prepareJournalMigration(db);
        if (await this.commitJournalMigration(db, migration)) return;
      } catch (error) {
        if (await this.markJournalMigrationFailed(db, error)) throw error;
      }
    }
    throw new Error('OFFLINE_DOMAIN_JOURNAL_MIGRATION_TIMEOUT');
  }

  async get(userId: string): Promise<OfflineDomainSnapshot | undefined> {
    const db = await this.open();
    const transaction = db.transaction(SNAPSHOTS_STORE, 'readonly');
    const result = await requestAsPromise(transaction.objectStore(SNAPSHOTS_STORE).get(userId));
    await transactionDone(transaction);
    return result as OfflineDomainSnapshot | undefined;
  }

  async put(snapshot: OfflineDomainSnapshot): Promise<void> {
    validateOfflineDomainSnapshot(snapshot, snapshot.userId);
    try {
      const db = await this.open();
      const transaction = db.transaction(SNAPSHOTS_STORE, 'readwrite');
      transaction.objectStore(SNAPSHOTS_STORE).put(snapshot);
      await transactionDone(transaction);
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  async compareAndSwap(userId: string, expectedRevision: number | null, snapshot: OfflineDomainSnapshot, assertBeforeWrite?: () => void): Promise<boolean> {
    validateOfflineDomainSnapshot(snapshot, userId);
    if (snapshot.revision !== (expectedRevision ?? 0) + 1) throw new Error('OFFLINE_DOMAIN_CAS_REVISION_INVALID');
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SNAPSHOTS_STORE, 'readwrite');
      const objectStore = transaction.objectStore(SNAPSHOTS_STORE);
      const request = objectStore.get(userId);
      let swapped = false;
      let writeFailure: unknown;
      request.onsuccess = () => {
        const current = request.result as OfflineDomainSnapshot | undefined;
        const currentRevision = current?.revision ?? null;
        if (currentRevision !== expectedRevision) return;
        try {
          // open() and the revision read have finished; the writer owns this synchronous fence.
          assertBeforeWrite?.();
          objectStore.put(snapshot);
          swapped = true;
        } catch (error) {
          writeFailure = error;
          transaction.abort();
        }
      };
      request.onerror = () => reject(request.error ?? new Error('OFFLINE_DOMAIN_CAS_READ_FAILED'));
      transaction.oncomplete = () => resolve(swapped);
      transaction.onabort = () => reject(writeFailure ?? normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_CAS_ABORTED')));
      transaction.onerror = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_CAS_FAILED')));
    });
  }

  async nextJournalSequence(userId: string): Promise<number> {
    userId = normalizeUserId(userId);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(META_STORE, 'readwrite');
      const store = transaction.objectStore(META_STORE);
      const key = `journal_sequence:${userId}`;
      const request = store.get(key);
      let sequence = 0;
      let failure: Error | null = null;
      request.onsuccess = () => {
        const existing = request.result as { key: string; value?: unknown } | undefined;
        const current = existing ? existing.value : 0;
        if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
          failure = new Error('OFFLINE_DOMAIN_JOURNAL_SEQUENCE_INVALID');
          return;
        }
        if (current >= Number.MAX_SAFE_INTEGER) {
          // Terminal but non-poisoning: existing snapshots/journals remain readable and retrying
          // deterministically fails without rewriting the exhausted durable counter.
          failure = new Error('OFFLINE_DOMAIN_JOURNAL_SEQUENCE_EXHAUSTED');
          return;
        }
        sequence = current + 1;
        store.put({ key, value: sequence });
      };
      request.onerror = () => reject(request.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_SEQUENCE_READ_FAILED'));
      transaction.oncomplete = () => failure ? reject(failure) : resolve(sequence);
      transaction.onerror = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_SEQUENCE_FAILED')));
      transaction.onabort = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_SEQUENCE_ABORTED')));
    });
  }

  async commitWithJournal(expectedRevision: number, snapshot: OfflineDomainSnapshot, journal: OfflineMutationJournal, assertBeforeWrite?: () => void): Promise<boolean> {
    validateOfflineDomainSnapshot(snapshot, snapshot.userId);
    const validJournal = validateOfflineMutationJournal(journal);
    if (validJournal.userId !== snapshot.userId || validJournal.snapshotRevision !== snapshot.revision
      || validJournal.snapshotChecksum !== snapshot.checksum) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_SNAPSHOT_MISMATCH');
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([SNAPSHOTS_STORE, JOURNALS_STORE], 'readwrite');
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const request = snapshots.get(snapshot.userId);
      let committed = false;
      let writeFailure: unknown;
      request.onsuccess = () => {
        const current = request.result as OfflineDomainSnapshot | undefined;
        if (current?.revision !== expectedRevision) return;
        try {
          // The writer owns the fence: open() and the IDB read callback have already completed.
          // No await or scheduled continuation may separate this decision from either write.
          assertBeforeWrite?.();
          snapshots.put(snapshot);
          transaction.objectStore(JOURNALS_STORE).put(validJournal);
          committed = true;
        } catch (error) {
          writeFailure = error;
          transaction.abort();
        }
      };
      request.onerror = () => reject(request.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_READ_FAILED'));
      transaction.oncomplete = () => resolve(committed);
      transaction.onabort = () => reject(writeFailure ?? normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_ABORTED')));
      transaction.onerror = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_FAILED')));
    });
  }

  async rollbackJournal(journal: OfflineMutationJournal, snapshot: OfflineDomainSnapshot): Promise<boolean> {
    const expectedJournal = validateOfflineMutationJournal(journal);
    validateOfflineDomainSnapshot(snapshot, expectedJournal.userId);
    if (snapshot.revision !== expectedJournal.snapshotRevision + 1) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_ROLLBACK_REVISION_INVALID');
    }
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([SNAPSHOTS_STORE, JOURNALS_STORE], 'readwrite');
      const snapshots = transaction.objectStore(SNAPSHOTS_STORE);
      const journals = transaction.objectStore(JOURNALS_STORE);
      const snapshotRequest = snapshots.get(expectedJournal.userId);
      const journalRequest = journals.get(expectedJournal.id);
      let rolledBack = false;
      let completedReads = 0;
      const applyRollback = () => {
        completedReads += 1;
        if (completedReads !== 2) return;
        const current = snapshotRequest.result as OfflineDomainSnapshot | undefined;
        const stored = journalRequest.result as OfflineMutationJournal | undefined;
        if (!current || !stored
          || current.revision !== expectedJournal.snapshotRevision
          || current.checksum !== expectedJournal.snapshotChecksum
          || stored.userId !== expectedJournal.userId
          || stored.snapshotRevision !== expectedJournal.snapshotRevision
          || stored.snapshotChecksum !== expectedJournal.snapshotChecksum
          || stored.operationDigest !== expectedJournal.operationDigest) return;
        snapshots.put(snapshot);
        journals.delete(expectedJournal.id);
        rolledBack = true;
      };
      snapshotRequest.onsuccess = applyRollback;
      journalRequest.onsuccess = applyRollback;
      snapshotRequest.onerror = () => reject(snapshotRequest.error ?? new Error('OFFLINE_DOMAIN_ROLLBACK_SNAPSHOT_READ_FAILED'));
      journalRequest.onerror = () => reject(journalRequest.error ?? new Error('OFFLINE_DOMAIN_ROLLBACK_JOURNAL_READ_FAILED'));
      transaction.oncomplete = () => resolve(rolledBack);
      transaction.onabort = () => reject(normalizePersistenceError(
        transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_ROLLBACK_ABORTED'),
      ));
      transaction.onerror = () => reject(normalizePersistenceError(
        transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_ROLLBACK_FAILED'),
      ));
    });
  }

  async listJournals(userId: string): Promise<OfflineMutationJournal[]> {
    const db = await this.open();
    const transaction = db.transaction(JOURNALS_STORE, 'readonly');
    const result = await requestAsPromise(transaction.objectStore(JOURNALS_STORE).index('by_user').getAll(IDBKeyRange.only(userId)));
    await transactionDone(transaction);
    return (result as OfflineMutationJournal[]).map(validateOfflineMutationJournal)
      .sort((a, b) => a.sequence - b.sequence || a.snapshotRevision - b.snapshotRevision || a.id.localeCompare(b.id));
  }

  async deleteJournal(userId: string, id: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(JOURNALS_STORE, 'readwrite');
      const store = transaction.objectStore(JOURNALS_STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const existing = request.result as OfflineMutationJournal | undefined;
        if (existing?.userId === userId) store.delete(id);
      };
      request.onerror = () => reject(request.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_DELETE_READ_FAILED'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_DELETE_FAILED')));
      transaction.onabort = () => reject(normalizePersistenceError(transaction.error ?? new Error('OFFLINE_DOMAIN_JOURNAL_DELETE_ABORTED')));
    });
  }

  async claimLegacyMigration(userId: string): Promise<string> {
    userId = normalizeUserId(userId);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      const store = tx.objectStore(META_STORE);
      const request = store.get('legacy_owner');
      let owner = userId;
      request.onsuccess = () => {
        const existing = request.result as { key: string; userId: string } | undefined;
        owner = existing?.userId || userId;
        if (!existing) store.add({ key: 'legacy_owner', userId });
      };
      tx.oncomplete = () => resolve(owner);
      tx.onerror = () => reject(normalizePersistenceError(tx.error ?? new Error('OFFLINE_DOMAIN_MIGRATION_CLAIM_FAILED')));
      tx.onabort = () => reject(normalizePersistenceError(tx.error ?? new Error('OFFLINE_DOMAIN_MIGRATION_CLAIM_ABORTED')));
    });
  }

  async delete(userId: string, assertBeforeWrite?: () => void): Promise<void> {
    const db = await this.open();
    // R2-PP-50: ownership is re-checked at the side-effect boundary, after the open await.
    assertBeforeWrite?.();
    const transaction = db.transaction(SNAPSHOTS_STORE, 'readwrite');
    transaction.objectStore(SNAPSHOTS_STORE).delete(userId);
    await transactionDone(transaction);
  }

  /** Auth lifecycle metadata shares the already-versioned domain database but never a projection. */
  async getMeta<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    const transaction = db.transaction(META_STORE, 'readonly');
    const result = await requestAsPromise(transaction.objectStore(META_STORE).get(key));
    await transactionDone(transaction);
    return (result as { key: string; value?: T } | undefined)?.value;
  }

  async putMeta<T>(key: string, value: T): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(META_STORE, 'readwrite');
    transaction.objectStore(META_STORE).put({ key, value });
    await transactionDone(transaction);
  }

  /** R2-PP-50: putMeta whose ownership assertion runs at the IndexedDB boundary, after the open await. */
  async putMetaIfCurrent<T>(key: string, value: T, assertBeforeWrite: () => void): Promise<void> {
    const db = await this.open();
    assertBeforeWrite();
    const transaction = db.transaction(META_STORE, 'readwrite');
    transaction.objectStore(META_STORE).put({ key, value });
    await transactionDone(transaction);
  }

  async deleteMeta(key: string, assertBeforeWrite?: () => void): Promise<void> {
    const db = await this.open();
    assertBeforeWrite?.();
    const transaction = db.transaction(META_STORE, 'readwrite');
    transaction.objectStore(META_STORE).delete(key);
    await transactionDone(transaction);
  }

  /** Reads, compares, and conditionally deletes metadata inside one serialized transaction. */
  async compareAndDeleteMeta<T>(key: string, expectedValue: T): Promise<boolean> {
    const assertBeforeWrite = arguments[2] as (() => void) | undefined;
    return this.compareAndDeleteMetaIfCurrent(key, expectedValue, assertBeforeWrite);
  }

  /** R2-PP-58: compareAndDeleteMeta whose ownership assertion runs after open() and at the delete boundary. */
  async compareAndDeleteMetaIfCurrent<T>(
    key: string,
    expectedValue: T,
    assertBeforeWrite?: () => void,
  ): Promise<boolean> {
    const db = await this.open();
    assertBeforeWrite?.();
    return new Promise((resolve, reject) => {
      let matched = false;
      let operationError: unknown = null;
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(META_STORE, 'readwrite');
        const store = transaction.objectStore(META_STORE);
        const request = store.get(key);
        request.onsuccess = () => {
          const stored = request.result as { key: string; value?: unknown } | undefined;
          if (!stored || !metaValuesEqual(stored.value, expectedValue)) return;
          try {
            assertBeforeWrite?.();
            store.delete(key);
            matched = true;
          } catch (error) {
            operationError = error;
            transaction.abort();
          }
        };
        request.onerror = () => {
          operationError = request.error ?? new Error('OFFLINE_DOMAIN_META_COMPARE_READ_FAILED');
        };
      } catch (error) {
        reject(normalizePersistenceError(error));
        return;
      }
      transaction.oncomplete = () => resolve(matched);
      transaction.onerror = () => reject(normalizePersistenceError(
        operationError ?? transaction.error ?? new Error('OFFLINE_DOMAIN_META_COMPARE_DELETE_FAILED'),
      ));
      transaction.onabort = () => reject(normalizePersistenceError(
        operationError ?? transaction.error ?? new Error('OFFLINE_DOMAIN_META_COMPARE_DELETE_ABORTED'),
      ));
    });
  }

  /** Gate-only diagnostic: production callers do not need connection lifecycle internals. */
  getOpenCountForTests(): number {
    return this.openCount;
  }
}

export class MemoryOfflineDomainStore implements OfflineDomainSnapshotStore {
  readonly snapshots = new Map<string, OfflineDomainSnapshot>();
  readonly journals = new Map<string, OfflineMutationJournal>();
  failure: Error | null = null;
  legacyOwner: string | null = null;
  readonly journalSequences = new Map<string, number>();

  async get(userId: string): Promise<OfflineDomainSnapshot | undefined> {
    const value = this.snapshots.get(userId);
    return value ? structuredClone(value) : undefined;
  }

  async put(snapshot: OfflineDomainSnapshot): Promise<void> {
    if (this.failure) throw this.failure;
    validateOfflineDomainSnapshot(snapshot, snapshot.userId);
    this.snapshots.set(snapshot.userId, structuredClone(snapshot));
  }

  async compareAndSwap(userId: string, expectedRevision: number | null, snapshot: OfflineDomainSnapshot, assertBeforeWrite?: () => void): Promise<boolean> {
    if (this.failure) throw this.failure;
    validateOfflineDomainSnapshot(snapshot, userId);
    if (snapshot.revision !== (expectedRevision ?? 0) + 1) throw new Error('OFFLINE_DOMAIN_CAS_REVISION_INVALID');
    const currentRevision = this.snapshots.get(userId)?.revision ?? null;
    if (currentRevision !== expectedRevision) return false;
    const copy = structuredClone(snapshot);
    assertBeforeWrite?.();
    this.snapshots.set(userId, copy);
    return true;
  }

  async nextJournalSequence(userId: string): Promise<number> {
    userId = normalizeUserId(userId);
    if (this.failure) throw this.failure;
    const current = this.journalSequences.has(userId) ? this.journalSequences.get(userId) : 0;
    if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_SEQUENCE_INVALID');
    }
    if (current >= Number.MAX_SAFE_INTEGER) throw new Error('OFFLINE_DOMAIN_JOURNAL_SEQUENCE_EXHAUSTED');
    const sequence = current + 1;
    this.journalSequences.set(userId, sequence);
    return sequence;
  }

  async commitWithJournal(expectedRevision: number, snapshot: OfflineDomainSnapshot, journal: OfflineMutationJournal, assertBeforeWrite?: () => void): Promise<boolean> {
    if (this.failure) throw this.failure;
    validateOfflineDomainSnapshot(snapshot, snapshot.userId);
    const validJournal = validateOfflineMutationJournal(journal);
    if (validJournal.userId !== snapshot.userId || validJournal.snapshotRevision !== snapshot.revision
      || validJournal.snapshotChecksum !== snapshot.checksum) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_SNAPSHOT_MISMATCH');
    }
    if (this.snapshots.get(snapshot.userId)?.revision !== expectedRevision) return false;
    const snapshotCopy = structuredClone(snapshot);
    const journalCopy = structuredClone(validJournal);
    assertBeforeWrite?.();
    this.snapshots.set(snapshot.userId, snapshotCopy);
    this.journals.set(validJournal.id, journalCopy);
    return true;
  }

  async rollbackJournal(journal: OfflineMutationJournal, snapshot: OfflineDomainSnapshot): Promise<boolean> {
    if (this.failure) throw this.failure;
    const expectedJournal = validateOfflineMutationJournal(journal);
    validateOfflineDomainSnapshot(snapshot, expectedJournal.userId);
    if (snapshot.revision !== expectedJournal.snapshotRevision + 1) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_ROLLBACK_REVISION_INVALID');
    }
    const current = this.snapshots.get(expectedJournal.userId);
    const stored = this.journals.get(expectedJournal.id);
    if (!current || !stored
      || current.revision !== expectedJournal.snapshotRevision
      || current.checksum !== expectedJournal.snapshotChecksum
      || stored.userId !== expectedJournal.userId
      || stored.snapshotRevision !== expectedJournal.snapshotRevision
      || stored.snapshotChecksum !== expectedJournal.snapshotChecksum
      || stored.operationDigest !== expectedJournal.operationDigest) return false;
    this.snapshots.set(expectedJournal.userId, structuredClone(snapshot));
    this.journals.delete(expectedJournal.id);
    return true;
  }

  async listJournals(userId: string): Promise<OfflineMutationJournal[]> {
    return [...this.journals.values()].filter(journal => journal.userId === userId)
      .map(journal => structuredClone(journal))
      .map(validateOfflineMutationJournal)
      .sort((a, b) => a.sequence - b.sequence || a.snapshotRevision - b.snapshotRevision || a.id.localeCompare(b.id));
  }

  async deleteJournal(userId: string, id: string): Promise<void> {
    if (this.journals.get(id)?.userId === userId) this.journals.delete(id);
  }
  async claimLegacyMigration(userId: string): Promise<string> {
    userId = normalizeUserId(userId);
    if (this.failure) throw this.failure;
    this.legacyOwner ??= userId;
    return this.legacyOwner;
  }

  async delete(userId: string, assertBeforeWrite?: () => void): Promise<void> {
    assertBeforeWrite?.();
    this.snapshots.delete(userId);
  }
}

let activeUserId: string | null = null;
let activeStore: OfflineDomainSnapshotStore | null = null;
let activeRevision: number | null = null;
let activeSessionEpoch = 0;
let persistenceChain: Promise<void> = Promise.resolve();
let tabProjectionMode = false;

const TAB_SCOPED_KEYS = new Set<string>([
  ...OFFLINE_DOMAIN_STORAGE_KEYS,
  OFFLINE_PROJECTION_OWNER_KEY,
]);

class OfflineProjectionStorage implements Storage {
  get length(): number { return new Set([...this.keys(this.local), ...this.keys(this.session)]).size; }
  private get local(): Storage { return localStorage; }
  private get session(): Storage { return sessionStorage; }
  private keys(storage: Storage): string[] {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key);
  }
  clear(): void {
    this.local.clear();
    for (const key of TAB_SCOPED_KEYS) this.session.removeItem(key);
  }
  private target(key: string): Storage { return TAB_SCOPED_KEYS.has(key) && tabProjectionMode ? this.session : this.local; }
  getItem(key: string): string | null { return this.target(key).getItem(key); }
  key(index: number): string | null { return [...new Set([...this.keys(this.local), ...this.keys(this.session)])][index] ?? null; }
  removeItem(key: string): void { this.target(key).removeItem(key); }
  setItem(key: string, value: string): void { this.target(key).setItem(key, value); }
}

export const offlineProjectionStorage: Storage = typeof window === 'undefined'
  ? (undefined as unknown as Storage)
  : new OfflineProjectionStorage();

const readProjection = (storage: Storage): Record<string, string | null> => {
  const values: Record<string, string | null> = {};
  for (const key of OFFLINE_DOMAIN_STORAGE_KEYS) values[key] = storage.getItem(key);
  assertValidValues(values);
  return values;
};

const clearProjectionValues = (storage: Storage): void => {
  for (const key of OFFLINE_DOMAIN_STORAGE_KEYS) storage.removeItem(key);
  storage.removeItem(OFFLINE_PROJECTION_OWNER_KEY);
};

export const clearOfflineDomainProjection = (storage: Storage = offlineProjectionStorage): void => {
  activeSessionEpoch += 1;
  clearProjectionValues(storage);
  activeUserId = null;
  activeStore = null;
  activeRevision = null;
  tabProjectionMode = false;
};

const applyProjection = (
  storage: Storage, values: Record<string, string | null>, keys: Iterable<string> = OFFLINE_DOMAIN_STORAGE_KEYS,
): void => {
  for (const key of keys) {
    const value = values[key];
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  }
};

/** Managed continuations stage their synchronous writes away from the mounted projection. */
const stageProjectionWrite = (storage: Storage, write: (staged: Storage) => void): {
  values: Record<string, string | null>;
  originalValues: Record<string, string | null>;
  changedKeys: Set<string>;
} => {
  const originalValues = readProjection(storage);
  const values = { ...originalValues };
  const changedKeys = new Set<string>();
  const requireKey = (key: string): void => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) throw new Error('OFFLINE_DOMAIN_STAGE_KEY_INVALID');
  };
  const staged: Storage = {
    get length() { return Object.values(values).filter(value => value !== null).length; },
    key: index => Object.keys(values).filter(key => values[key] !== null)[index] ?? null,
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { requireKey(key); values[key] = String(value); changedKeys.add(key); },
    removeItem: key => { requireKey(key); values[key] = null; changedKeys.add(key); },
    clear: () => { for (const key of Object.keys(values)) { values[key] = null; changedKeys.add(key); } },
  };
  write(staged);
  assertValidValues(values);
  return { values, originalValues, changedKeys };
};

const createSnapshot = (
  userId: string,
  revision: number,
  values: Record<string, string | null>,
  now: number,
): OfflineDomainSnapshot => ({
  version: OFFLINE_DOMAIN_SCHEMA_VERSION,
  userId,
  revision,
  updatedAt: now,
  values,
  checksum: checksumFor(userId, revision, values),
});

export async function activateOfflineDomain(
  rawUserId: string,
  options: { storage?: Storage; legacyStorage?: Storage; store?: OfflineDomainSnapshotStore; now?: () => number } = {},
): Promise<OfflineDomainActivation> {
  const userId = normalizeUserId(rawUserId);
  const storage = options.storage ?? offlineProjectionStorage;
  const legacyStorage = options.legacyStorage ?? (options.storage ?? localStorage);
  const store = options.store ?? new IndexedDbOfflineDomainStore();
  const now = options.now ?? Date.now;
  const sessionEpoch = ++activeSessionEpoch;
  tabProjectionMode = true;
  const projectionOwner = storage.getItem(OFFLINE_PROJECTION_OWNER_KEY);
  const migrationOwner = storage.getItem(OFFLINE_LEGACY_MIGRATION_KEY);
  let ownsLegacyClaim = false;
  activeUserId = null;
  activeStore = null;
  activeRevision = null;

  try {
    const existing = await store.get(userId);
    if (sessionEpoch !== activeSessionEpoch) throw new Error('OFFLINE_DOMAIN_SESSION_SUPERSEDED');
    if (existing) {
      validateOfflineDomainSnapshot(existing, userId);
      // Populate the v3 global claim for databases upgraded from v2. A pre-existing durable
      // snapshot is stronger evidence than tab-local projection metadata.
      await store.claimLegacyMigration(userId);
      applyProjection(storage, existing.values);
      storage.setItem(OFFLINE_PROJECTION_OWNER_KEY, userId);
      activeUserId = userId;
      activeStore = store;
      activeRevision = existing.revision;
      return { userId, source: 'restored', revision: existing.revision };
    }

    // The read/write transaction in IndexedDB is the cross-tab serialization point. LocalStorage
    // markers are compatibility hints only and never decide a concurrent first-login race.
    const claimCandidate = migrationOwner && !migrationOwner.includes('/') ? migrationOwner : userId;
    const claimedOwner = await store.claimLegacyMigration(claimCandidate);
    ownsLegacyClaim = claimedOwner === userId && (!migrationOwner || migrationOwner === userId);
    if ((projectionOwner && projectionOwner !== userId) || !ownsLegacyClaim) clearProjectionValues(storage);
    const legacyValues = ownsLegacyClaim ? readProjection(legacyStorage) : null;
    if (legacyValues && Object.values(legacyValues).some(value => value !== null)) applyProjection(storage, legacyValues);
    const values = readProjection(storage);
    const hasLegacyData = ownsLegacyClaim && Object.values(values).some(value => value !== null);
    const snapshot = createSnapshot(userId, 1, values, now());
    if (!await store.compareAndSwap(userId, null, snapshot)) {
      const winner = await store.get(userId);
      if (!winner) throw new Error('OFFLINE_DOMAIN_ACTIVATION_CONFLICT');
      validateOfflineDomainSnapshot(winner, userId);
      applyProjection(storage, winner.values);
      storage.setItem(OFFLINE_PROJECTION_OWNER_KEY, userId);
      activeUserId = userId;
      activeStore = store;
      activeRevision = winner.revision;
      return { userId, source: 'restored', revision: winner.revision };
    }
    if (sessionEpoch !== activeSessionEpoch) throw new Error('OFFLINE_DOMAIN_SESSION_SUPERSEDED');
    storage.setItem(OFFLINE_LEGACY_MIGRATION_KEY, claimedOwner);
    if (ownsLegacyClaim && legacyStorage !== storage) {
      for (const key of OFFLINE_DOMAIN_STORAGE_KEYS) legacyStorage.removeItem(key);
    }
    storage.setItem(OFFLINE_PROJECTION_OWNER_KEY, userId);
    activeUserId = userId;
    activeStore = store;
    activeRevision = 1;
    return { userId, source: hasLegacyData ? 'migrated' : 'empty', revision: 1 };
  } catch (error) {
    if (sessionEpoch === activeSessionEpoch) {
      activeSessionEpoch += 1;
      clearProjectionValues(storage);
      if ((ownsLegacyClaim || !migrationOwner) && legacyStorage !== storage) {
        for (const key of OFFLINE_DOMAIN_STORAGE_KEYS) legacyStorage.removeItem(key);
      }
      activeUserId = null;
      activeStore = null;
      activeRevision = null;
      tabProjectionMode = false;
    }
    throw error;
  }
}

export async function persistActiveOfflineDomainState(
  options: {
    storage?: Storage; store?: OfflineDomainSnapshotStore; now?: () => number;
    assertBeforeWrite?: () => void; stageProjection?: (staged: Storage) => void;
    /**
     * Session-owned staged writers may compensate only their OWN durable commit. The rollback runs
     * inside the same persistence-chain turn, before a sibling writer can linearize, and restores
     * only keys changed by this staged operation.
     */
    rollbackStagedWriteOnPostCommitFailure?: boolean;
    assertBeforeRollback?: () => void;
  } = {},
): Promise<OfflineDomainSnapshot> {
  if (!activeUserId) throw new Error('OFFLINE_DOMAIN_SESSION_REQUIRED');
  const userId = activeUserId;
  const sessionEpoch = activeSessionEpoch;
  const storage = options.storage ?? offlineProjectionStorage;
  if (storage.getItem(OFFLINE_PROJECTION_OWNER_KEY) !== userId) {
    throw new Error('OFFLINE_DOMAIN_PROJECTION_OWNER_MISMATCH');
  }
  const store = options.store ?? activeStore ?? new IndexedDbOfflineDomainStore();
  const assertDomainCurrent = (): void => {
    if (sessionEpoch !== activeSessionEpoch || activeUserId !== userId
      || storage.getItem(OFFLINE_PROJECTION_OWNER_KEY) !== userId) throw new Error('OFFLINE_DOMAIN_SESSION_CHANGED');
  };
  const assertWriteCurrent = (): void => {
    options.assertBeforeWrite?.();
    assertDomainCurrent();
  };
  const assertRollbackCurrent = (): void => {
    options.assertBeforeRollback?.();
    assertDomainCurrent();
  };
  let result!: OfflineDomainSnapshot;
  const run = persistenceChain.then(async () => {
    const current = await store.get(userId);
    assertWriteCurrent();
    if (!current) throw new Error('OFFLINE_DOMAIN_SNAPSHOT_MISSING');
    validateOfflineDomainSnapshot(current, userId);
    if (activeRevision !== current.revision) throw new Error('OFFLINE_DOMAIN_STALE_TAB');
    const staged = options.stageProjection ? stageProjectionWrite(storage, options.stageProjection) : undefined;
    const now = options.now ?? Date.now;
    const snapshot = createSnapshot(userId, current.revision + 1, staged?.values ?? readProjection(storage), now());
    let committedByThisWrite = false;
    try {
      if (!await store.compareAndSwap(userId, current.revision, snapshot, assertWriteCurrent)) {
        throw new Error('OFFLINE_DOMAIN_REVISION_CONFLICT');
      }
      committedByThisWrite = true;
      assertWriteCurrent();
      activeStore = store;
      activeRevision = snapshot.revision;
      // No A-derived bytes are visible during the await. Publish only touched keys while A still owns it.
      if (staged) applyProjection(storage, staged.values, staged.changedKeys);
      result = snapshot;
    } catch (error) {
      if (!committedByThisWrite || !staged || !options.rollbackStagedWriteOnPostCommitFailure) {
        if (committedByThisWrite && error instanceof Error && error.message === "RESET_SESSION_CHANGED") {
          throw new Error("RESET_COMMITTED_SESSION_CHANGED");
        }
        throw error;
      }

      // The CAS above proves this operation, and only this operation, owns the committed revision.
      // Compensate before releasing the persistence-chain turn. Forward authority may have been
      // revoked, so rollback uses the separate lifecycle/ownership assertion supplied by caller.
      try {
        assertRollbackCurrent();
      } catch (ownershipError) {
        // A replacement lifecycle owns the mounted projection now. Do not touch it; the committed
        // user-domain snapshot remains recoverable by the rightful lifecycle.
        if (ownershipError instanceof Error && ownershipError.message === "RESET_SESSION_CHANGED") {
          throw new Error("RESET_COMMITTED_SESSION_CHANGED");
        }
        throw ownershipError;
      }

      const rollbackValues = { ...snapshot.values };
      for (const key of staged.changedKeys) {
        rollbackValues[key] = staged.originalValues[key] ?? null;
      }
      const rollback = createSnapshot(userId, snapshot.revision + 1, rollbackValues, now());
      try {
        if (!await store.compareAndSwap(userId, snapshot.revision, rollback, assertRollbackCurrent)) {
          throw new Error('OFFLINE_DOMAIN_PROJECTION_ROLLBACK_CONFLICT');
        }
        assertRollbackCurrent();
        activeStore = store;
        activeRevision = rollback.revision;
        applyProjection(storage, rollback.values, staged.changedKeys);
      } catch (rollbackError) {
        if (rollbackError instanceof OfflineDomainSessionChangedError
          || (rollbackError instanceof Error && rollbackError.message === 'OFFLINE_DOMAIN_SESSION_CHANGED')) {
          throw rollbackError;
        }
        throw new OfflineDomainProjectionRecoveryRequiredError(userId, rollbackError);
      }
      throw error;
    }
  });
  persistenceChain = run.catch(() => {});
  await run;
  return result;
}

/**
 * Exact-session writer for security-sensitive projection changes.
 *
 * The forward assertion owns the staged write/CAS/final publication. If that assertion fails only
 * AFTER this operation's CAS linearizes, the writer compensates that exact commit inside the same
 * persistence-chain turn using the lifecycle-only rollback assertion. A pre-CAS refusal performs
 * no rollback, so it cannot erase a sibling writer that committed independently.
 */
export async function persistSessionOwnedOfflineDomainProjection(
  stageProjection: (staged: Storage) => void,
  assertBeforeWrite: () => void,
  options: {
    storage?: Storage;
    store?: OfflineDomainSnapshotStore;
    now?: () => number;
    assertBeforeRollback?: () => void;
  } = {},
): Promise<OfflineDomainSnapshot> {
  assertBeforeWrite();
  return persistActiveOfflineDomainState({
    ...options,
    stageProjection,
    assertBeforeWrite,
    assertBeforeRollback: options.assertBeforeRollback ?? assertBeforeWrite,
    rollbackStagedWriteOnPostCommitFailure: true,
  });
}
export async function readActiveOfflineDomainSnapshot(
  options: { store?: OfflineDomainSnapshotStore } = {},
): Promise<OfflineDomainSnapshot> {
  if (!activeUserId) throw new Error('OFFLINE_DOMAIN_SESSION_REQUIRED');
  const userId = activeUserId;
  const sessionEpoch = activeSessionEpoch;
  const store = options.store ?? activeStore ?? new IndexedDbOfflineDomainStore();
  const snapshot = await store.get(userId);
  if (sessionEpoch !== activeSessionEpoch || activeUserId !== userId) throw new Error('OFFLINE_DOMAIN_SESSION_CHANGED');
  if (!snapshot) throw new Error('OFFLINE_DOMAIN_SNAPSHOT_MISSING');
  validateOfflineDomainSnapshot(snapshot, userId);
  return snapshot;
}

export async function commitActiveOfflineMutation(
  input: { operations: unknown[]; label?: string },
  options: {
    storage?: Storage;
    store?: OfflineDomainSnapshotStore;
    now?: () => number;
    id?: string;
    syncProtocolVersion?: 4;
    /** NEW forward authority hook; the store executes it synchronously at its actual write boundary. */
    assertBeforeCommit?: () => void;
  } = {},
): Promise<OfflineMutationJournal> {
  if (!activeUserId) throw new Error('OFFLINE_DOMAIN_SESSION_REQUIRED');
  const userId = activeUserId;
  const sessionEpoch = activeSessionEpoch;
  const expectedActiveRevision = activeRevision;
  if (expectedActiveRevision === null) throw new Error('OFFLINE_DOMAIN_SESSION_REQUIRED');
  const storage = options.storage ?? offlineProjectionStorage;
  const store = options.store ?? activeStore ?? new IndexedDbOfflineDomainStore();
  const now = options.now ?? Date.now;
  const id = options.id ?? `domain-${globalThis.crypto?.randomUUID?.() || `${now()}-${Math.random().toString(36).slice(2)}`}`;
  let journal!: OfflineMutationJournal;
  const assertSessionFence = () => {
    if (sessionEpoch !== activeSessionEpoch || activeUserId !== userId || activeRevision !== expectedActiveRevision
      || storage.getItem(OFFLINE_PROJECTION_OWNER_KEY) !== userId) {
      throw new OfflineDomainSessionChangedError(userId);
    }
  };
  const run = persistenceChain.then(async () => {
    assertSessionFence();
    const current = await store.get(userId);
    assertSessionFence();
    if (!current) throw new Error('OFFLINE_DOMAIN_SNAPSHOT_MISSING');
    validateOfflineDomainSnapshot(current, userId);
    if (expectedActiveRevision !== current.revision) throw new Error('OFFLINE_DOMAIN_STALE_TAB');
    // Reject non-JSON input before allocating a durable sequence number.
    canonicalJournalValue(input);
    // Sequence allocation is itself durable bookkeeping for NEW work. Fence immediately before
    // entering that side effect, then fence again below before the atomic snapshot+journal commit.
    options.assertBeforeCommit?.();
    const sequence = await store.nextJournalSequence(userId);
    assertSessionFence();
    const snapshot = createSnapshot(userId, current.revision + 1, readProjection(storage), now());
    const unsignedJournal: Omit<OfflineMutationJournal, 'operationDigest'> = {
      id,
      userId,
      createdAt: now(),
      sequence,
      snapshotRevision: snapshot.revision,
      snapshotChecksum: snapshot.checksum,
      ...(options.syncProtocolVersion === 4 ? { syncProtocolVersion: 4 } : {}),
      input,
    };
    const operationDigest = await computeOfflineMutationJournalDigest(unsignedJournal);
    assertSessionFence();
    journal = { ...unsignedJournal, operationDigest };
    validateOfflineMutationJournal(journal);
    // Preflight refusals avoid opening a transaction. The store repeats the authority decision
    // at its actual writes. Recovery callers omit the hook; NEW privileged work supplies it.
    options.assertBeforeCommit?.();
    const committed = await store.commitWithJournal(current.revision, snapshot, journal, () => {
      assertSessionFence();
      options.assertBeforeCommit?.();
    });
    if (sessionEpoch !== activeSessionEpoch || activeUserId !== userId || activeRevision !== expectedActiveRevision
      || storage.getItem(OFFLINE_PROJECTION_OWNER_KEY) !== userId) {
      // A successful transaction is durable and must remain recoverable for its original UID. Never
      // mutate the newly active session or attempt rollback/acknowledgement through it.
      throw new OfflineDomainSessionChangedError(userId, committed ? journal : undefined);
    }
    if (!committed) throw new Error('OFFLINE_DOMAIN_REVISION_CONFLICT');
    activeRevision = snapshot.revision;
  });
  persistenceChain = run.catch(() => {});
  await run;
  return journal;
}

export async function listActiveOfflineMutationJournals(): Promise<OfflineMutationJournal[]> {
  if (!activeUserId) throw new Error('OFFLINE_DOMAIN_SESSION_REQUIRED');
  const userId = activeUserId;
  const sessionEpoch = activeSessionEpoch;
  const journals = await (activeStore ?? new IndexedDbOfflineDomainStore()).listJournals(userId);
  if (activeUserId !== userId || activeSessionEpoch !== sessionEpoch) {
    throw new OfflineDomainSessionChangedError(userId);
  }
  return journals;
}

export async function listValidatedActiveOfflineMutationJournals(): Promise<OfflineMutationJournal[]> {
  if (!activeUserId) throw new Error('OFFLINE_DOMAIN_SESSION_REQUIRED');
  const userId = activeUserId;
  const sessionEpoch = activeSessionEpoch;
  const store = activeStore ?? new IndexedDbOfflineDomainStore();
  const assertSessionFence = () => {
    if (activeUserId !== userId || activeSessionEpoch !== sessionEpoch) {
      throw new OfflineDomainSessionChangedError(userId);
    }
  };
  const snapshot = await store.get(userId);
  assertSessionFence();
  if (!snapshot) throw new Error('OFFLINE_DOMAIN_SNAPSHOT_MISSING');
  const journals = await store.listJournals(userId);
  assertSessionFence();
  const validated = await validateOfflineMutationJournalChain(snapshot, journals);
  assertSessionFence();
  return validated;
}

export async function getActiveOfflineMutationJournalCount(): Promise<number> {
  return (await listValidatedActiveOfflineMutationJournals()).length;
}

export async function deleteActiveOfflineMutationJournal(id: string, expectedUserId?: string): Promise<void> {
  if (!activeUserId) throw new Error('OFFLINE_DOMAIN_SESSION_REQUIRED');
  if (expectedUserId !== undefined && activeUserId !== expectedUserId) {
    throw new OfflineDomainSessionChangedError(expectedUserId);
  }
  const userId = activeUserId;
  const store = activeStore ?? new IndexedDbOfflineDomainStore();
  await store.deleteJournal(userId, id);
}

/**
 * Atomically removes a journal that never reached the durable sync queue and advances the snapshot
 * to a monotonic rollback revision containing the exact pre-mutation projection.
 */
export async function rollbackActiveOfflineMutationJournal(
  journal: OfflineMutationJournal,
  checkpoint: OfflineDomainSnapshot,
  options: { storage?: Storage; store?: OfflineDomainSnapshotStore; now?: () => number } = {},
): Promise<void> {
  const expected = validateOfflineMutationJournal(journal);
  if (!activeUserId || expected.userId !== activeUserId || checkpoint.userId !== activeUserId) {
    throw new OfflineDomainSessionChangedError(expected.userId, expected);
  }
  validateOfflineDomainSnapshot(checkpoint, expected.userId);
  if (checkpoint.revision + 1 !== expected.snapshotRevision) {
    throw new Error('OFFLINE_DOMAIN_JOURNAL_ROLLBACK_CHECKPOINT_INVALID');
  }
  const userId = activeUserId;
  const sessionEpoch = activeSessionEpoch;
  const store = options.store ?? activeStore ?? new IndexedDbOfflineDomainStore();
  const storage = options.storage ?? offlineProjectionStorage;
  const rollback = createSnapshot(
    userId,
    expected.snapshotRevision + 1,
    checkpoint.values,
    (options.now ?? Date.now)(),
  );
  const assertSessionFence = () => {
    if (activeUserId !== userId || activeSessionEpoch !== sessionEpoch
      || activeRevision !== expected.snapshotRevision) {
      throw new OfflineDomainSessionChangedError(userId, expected);
    }
  };
  const run = persistenceChain.then(async () => {
    assertSessionFence();
    if (!await store.rollbackJournal(expected, rollback)) {
      throw new Error('OFFLINE_DOMAIN_JOURNAL_ROLLBACK_CONFLICT');
    }
    if (activeUserId !== userId || activeSessionEpoch !== sessionEpoch) {
      throw new OfflineDomainSessionChangedError(userId);
    }
    activeRevision = rollback.revision;
    applyProjection(storage, checkpoint.values);
    storage.setItem(OFFLINE_PROJECTION_OWNER_KEY, userId);
    activeStore = store;
  });
  persistenceChain = run.catch(() => {});
  await run;
}

export async function clearActiveOfflineMutationJournals(): Promise<number> {
  if (!activeUserId) throw new Error('OFFLINE_DOMAIN_SESSION_REQUIRED');
  const store = activeStore ?? new IndexedDbOfflineDomainStore();
  const journals = await store.listJournals(activeUserId);
  for (const journal of journals) await store.deleteJournal(activeUserId, journal.id);
  return journals.length;
}

export async function restoreActiveOfflineDomainSnapshot(
  snapshot: OfflineDomainSnapshot,
  options: { storage?: Storage; store?: OfflineDomainSnapshotStore; assertBeforeWrite?: () => void } = {},
): Promise<void> {
  if (!activeUserId || snapshot.userId !== activeUserId) throw new Error('OFFLINE_DOMAIN_SESSION_CHANGED');
  const userId = activeUserId;
  const sessionEpoch = activeSessionEpoch;
  const storage = options.storage ?? offlineProjectionStorage;
  const store = options.store ?? activeStore ?? new IndexedDbOfflineDomainStore();
  const assertCurrent = (): void => {
    options.assertBeforeWrite?.();
    if (sessionEpoch !== activeSessionEpoch || activeUserId !== userId
      || storage.getItem(OFFLINE_PROJECTION_OWNER_KEY) !== userId) throw new Error('OFFLINE_DOMAIN_SESSION_CHANGED');
  };
  assertCurrent();
  validateOfflineDomainSnapshot(snapshot, userId);
  const current = await store.get(userId);
  if (!current) throw new Error('OFFLINE_DOMAIN_SNAPSHOT_MISSING');
  validateOfflineDomainSnapshot(current, userId);
  if ((await store.listJournals(userId)).length > 0) throw new Error('OFFLINE_DOMAIN_ROLLBACK_PENDING_JOURNALS');
  // M-P9-RT-01: fence after awaits before reading shared lifecycle or mutating durable/shared state.
  assertCurrent();
  let nextActiveRevision: number;
  if (current.checksum !== snapshot.checksum) {
    if (activeRevision !== current.revision) throw new Error('OFFLINE_DOMAIN_ROLLBACK_CONFLICT');
    if (current.revision !== snapshot.revision + 1) throw new Error('OFFLINE_DOMAIN_ROLLBACK_CONFLICT');
    const rollback = createSnapshot(userId, current.revision + 1, snapshot.values, Date.now());
    if (!await store.compareAndSwap(userId, current.revision, rollback, assertCurrent)) throw new Error('OFFLINE_DOMAIN_ROLLBACK_CONFLICT');
    // Re-fence after CAS await — do not assign shared revision until session still owns restore.
    assertCurrent();
    nextActiveRevision = rollback.revision;
  } else {
    nextActiveRevision = current.revision;
  }
  assertCurrent();
  // Shared Offline Domain lifecycle writes only after final post-await fence.
  activeRevision = nextActiveRevision;
  applyProjection(storage, snapshot.values);
  storage.setItem(OFFLINE_PROJECTION_OWNER_KEY, userId);
  activeStore = store;
}

export const getActiveOfflineDomainUserId = (): string | null => activeUserId;

/**
 * R2-PP-50: monotonic activation/teardown epoch. Any activation or projection clear after a
 * capture proves that a newer lifecycle (same UID included) owns the offline domain.
 */
export const getOfflineDomainSessionEpoch = (): number => activeSessionEpoch;

/**
 * Narrow authorization-reader context. tabScoped=true with activeUserId=null means activation or
 * teardown is in progress; callers performing security decisions must fail closed rather than
 * falling back to legacy localStorage authority.
 */
export const getOfflineProjectionAuthorityContext = (): {
  tabScoped: boolean;
  activeUserId: string | null;
  projectionOwner: string | null;
} => {
  let projectionOwner: string | null = null;
  try {
    if (tabProjectionMode) projectionOwner = offlineProjectionStorage.getItem(OFFLINE_PROJECTION_OWNER_KEY);
  } catch {
    // An unreadable marker is not authority.
  }
  return { tabScoped: tabProjectionMode, activeUserId, projectionOwner };
};

/** Observable Offline Domain revision for session-fence proofs (M-P9-RT-01). */
export const getActiveOfflineDomainRevision = (): number | null => activeRevision;

export async function deactivateOfflineDomain(
  storage: Storage = offlineProjectionStorage,
  expectedUserId?: string,
): Promise<boolean> {
  if (expectedUserId !== undefined) {
    const normalized = normalizeUserId(expectedUserId);
    const projectionOwner = storage.getItem(OFFLINE_PROJECTION_OWNER_KEY);
    // activeUserId is the authoritative in-memory lifecycle owner. The projection marker is an
    // additional storage fence: a stale caller may never clear values already mounted for B.
    if (activeUserId !== normalized || (projectionOwner !== null && projectionOwner !== normalized)) {
      return false;
    }
  }
  clearOfflineDomainProjection(storage);
  return true;
}

export const deactivateOfflineDomainForUser = (
  expectedUserId: string,
  storage: Storage = offlineProjectionStorage,
): Promise<boolean> => deactivateOfflineDomain(storage, expectedUserId);
