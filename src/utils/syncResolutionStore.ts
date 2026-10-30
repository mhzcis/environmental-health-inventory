const REMOTE_RESOLUTION_PREFIX = 'remix_sync_remote_resolution_v1:';
const ALLOWED_COLLECTIONS = new Set([
  'settings', 'materials', 'transactions', 'audit_logs', 'generator_logs',
]);

const storageKey = (userId: string): string =>
  `${REMOTE_RESOLUTION_PREFIX}${encodeURIComponent(userId)}`;

const validateDocumentKey = (documentKey: string): void => {
  const separator = documentKey.indexOf('/');
  const collection = documentKey.slice(0, separator);
  const docId = documentKey.slice(separator + 1);
  if (separator <= 0 || !ALLOWED_COLLECTIONS.has(collection) || !docId || docId.includes('/')) {
    throw new Error('SYNC_REMOTE_RESOLUTION_KEY_INVALID');
  }
};

export const readRemoteResolutionKeys = (storage: Storage, userId: string): Set<string> => {
  const raw = storage.getItem(storageKey(userId));
  if (!raw) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('SYNC_REMOTE_RESOLUTION_CORRUPTED');
  }
  if (!Array.isArray(parsed) || parsed.some(key => typeof key !== 'string')) {
    throw new Error('SYNC_REMOTE_RESOLUTION_INVALID');
  }
  const keys = new Set(parsed as string[]);
  keys.forEach(validateDocumentKey);
  return keys;
};

export const addRemoteResolutionKeys = (
  storage: Storage,
  userId: string,
  documentKeys: string[],
): void => {
  const keys = readRemoteResolutionKeys(storage, userId);
  documentKeys.forEach(key => {
    validateDocumentKey(key);
    keys.add(key);
  });
  storage.setItem(storageKey(userId), JSON.stringify([...keys].sort()));
};

export const removeRemoteResolutionKey = (
  storage: Storage,
  userId: string,
  documentKey: string,
): void => {
  const keys = readRemoteResolutionKeys(storage, userId);
  if (!keys.delete(documentKey)) return;
  if (keys.size === 0) storage.removeItem(storageKey(userId));
  else storage.setItem(storageKey(userId), JSON.stringify([...keys].sort()));
};
