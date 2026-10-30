import { IndexedDbOfflineDomainStore } from './offlineDomainStore';

export interface AuthTerminationRecord {
  version: 2;
  userId: string;
  sessionFingerprint: string;
  attemptGeneration: number;
  terminatedAt: number;
  /** generation + timestamp + a cryptographically random nonce, bound as one opaque token. */
  attemptToken: string;
}

interface LegacyAuthTerminationRecord {
  version: 1;
  userId: string;
  sessionFingerprint: string;
  terminatedAt: number;
}

export interface AuthTerminationMetaStore {
  getMeta<T>(key: string): Promise<T | undefined>;
  putMeta<T>(key: string, value: T): Promise<void>;
  compareAndDeleteMeta<T>(key: string, expectedValue: T): Promise<boolean>;
}

const keyFor = (userId: string, fingerprint: string): string =>
  `auth_termination:${encodeURIComponent(userId)}:${encodeURIComponent(fingerprint)}`;
const MAX_MEMORY_RECORDS = 128;
const memoryRecords = new Map<string, AuthTerminationRecord | LegacyAuthTerminationRecord>();
const sharedMetaStore = new IndexedDbOfflineDomainStore();

const isBaseRecordValid = (
  record: Partial<AuthTerminationRecord | LegacyAuthTerminationRecord>,
  expectedUserId: string,
  expectedFingerprint: string,
): boolean => record.userId === expectedUserId
  && record.sessionFingerprint === expectedFingerprint
  && Number.isSafeInteger(record.terminatedAt)
  && Number(record.terminatedAt) >= 0;

const validateStored = (
  value: unknown,
  expectedUserId: string,
  expectedFingerprint: string,
): AuthTerminationRecord | LegacyAuthTerminationRecord | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Partial<AuthTerminationRecord | LegacyAuthTerminationRecord>;
  if (!isBaseRecordValid(record, expectedUserId, expectedFingerprint)) return undefined;
  if (record.version === 1) return record as LegacyAuthTerminationRecord;
  if (record.version !== 2 || !Number.isSafeInteger(record.attemptGeneration)
    || Number(record.attemptGeneration) < 0 || typeof record.attemptToken !== 'string') return undefined;
  const prefix = `${record.attemptGeneration}:${record.terminatedAt}:`;
  if (!record.attemptToken.startsWith(prefix)
    || !/^[0-9a-f]{32}$/i.test(record.attemptToken.slice(prefix.length))) return undefined;
  return record as AuthTerminationRecord;
};

const pruneMemoryRecords = (): void => {
  while (memoryRecords.size > MAX_MEMORY_RECORDS) {
    const oldestKey = memoryRecords.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    // This map is only a fast fail-closed cache. Eviction never touches IndexedDB, so every
    // durable termination remains authoritative and is reloaded on the next lookup.
    memoryRecords.delete(oldestKey);
  }
};

const cacheRecord = (record: AuthTerminationRecord | LegacyAuthTerminationRecord): void => {
  const key = keyFor(record.userId, record.sessionFingerprint);
  memoryRecords.delete(key);
  memoryRecords.set(key, { ...record });
  pruneMemoryRecords();
};

const secureNonce = (): string => {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) throw new Error('AUTH_TERMINATION_SECURE_RANDOM_UNAVAILABLE');
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

export const createAuthTerminationRecord = (
  userId: string,
  sessionFingerprint: string,
  attemptGeneration: number,
  terminatedAt = Date.now(),
): AuthTerminationRecord => {
  if (!userId || !sessionFingerprint || !Number.isSafeInteger(attemptGeneration)
    || attemptGeneration < 0 || !Number.isSafeInteger(terminatedAt) || terminatedAt < 0) {
    throw new Error('AUTH_TERMINATION_RECORD_INVALID');
  }
  return {
    version: 2,
    userId,
    sessionFingerprint,
    attemptGeneration,
    terminatedAt,
    attemptToken: `${attemptGeneration}:${terminatedAt}:${secureNonce()}`,
  };
};

export const rememberAuthTerminationInMemory = (record: AuthTerminationRecord): void => {
  if (!validateStored(record, record.userId, record.sessionFingerprint)) {
    throw new Error('AUTH_TERMINATION_RECORD_INVALID');
  }
  cacheRecord(record);
};

export const isAuthTerminationRemembered = (userId: string, sessionFingerprint: string): boolean =>
  memoryRecords.has(keyFor(userId, sessionFingerprint));

export const persistAuthTermination = async (
  record: AuthTerminationRecord,
  store: AuthTerminationMetaStore = sharedMetaStore,
): Promise<void> => {
  rememberAuthTerminationInMemory(record);
  await store.putMeta(keyFor(record.userId, record.sessionFingerprint), record);
};

export const readAuthTermination = async (
  userId: string,
  sessionFingerprint: string,
  store: AuthTerminationMetaStore = sharedMetaStore,
): Promise<boolean> => {
  const key = keyFor(userId, sessionFingerprint);
  if (memoryRecords.has(key)) return true;
  const durable = validateStored(
    await store.getMeta<AuthTerminationRecord | LegacyAuthTerminationRecord>(key),
    userId,
    sessionFingerprint,
  );
  if (!durable) return false;
  cacheRecord(durable);
  return true;
};

/** Atomically clears only the captured attempt; a newer same-identity marker always survives. */
export const clearAuthTermination = async (
  expectedRecord: AuthTerminationRecord,
  store: AuthTerminationMetaStore = sharedMetaStore,
): Promise<boolean> => {
  const validated = validateStored(
    expectedRecord,
    expectedRecord.userId,
    expectedRecord.sessionFingerprint,
  );
  if (!validated || validated.version !== 2) throw new Error('AUTH_TERMINATION_RECORD_INVALID');
  const key = keyFor(expectedRecord.userId, expectedRecord.sessionFingerprint);
  const deleted = await store.compareAndDeleteMeta(key, expectedRecord);
  // On success this exact marker is gone. On mismatch its cache is stale and the next lookup must
  // reload the newer cross-tab marker. Neither branch ever removes a different cached token.
  const cached = memoryRecords.get(key);
  if (cached?.version === 2 && cached.attemptToken === expectedRecord.attemptToken) {
    memoryRecords.delete(key);
  }
  return deleted;
};

export const getAuthTerminationDiagnosticsForTests = (): {
  memoryRecordCount: number;
  memoryRecordLimit: number;
  sharedConnectionOpenCount: number;
} => ({
  memoryRecordCount: memoryRecords.size,
  memoryRecordLimit: MAX_MEMORY_RECORDS,
  sharedConnectionOpenCount: sharedMetaStore.getOpenCountForTests(),
});

/** Test-only process-memory reset used to model a full page reload. */
export const resetAuthTerminationMemoryForTests = (): void => memoryRecords.clear();
