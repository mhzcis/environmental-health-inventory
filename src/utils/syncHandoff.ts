import type { EnqueueSyncMutation } from '../services/syncCoordinator';

const HANDOFF_KEY_PREFIX = 'remix_sync_handoff_v1:';

export interface DurableSyncHandoff {
  version: 1 | 2;
  id: string;
  userId: string;
  createdAt: number;
  input: EnqueueSyncMutation;
}

const userPrefix = (userId: string): string =>
  `${HANDOFF_KEY_PREFIX}${encodeURIComponent(userId)}:`;

export const syncHandoffStorageKey = (userId: string, id: string): string =>
  `${userPrefix(userId)}${id}`;

export const persistSyncHandoff = (storage: Storage, handoff: DurableSyncHandoff): void => {
  storage.setItem(syncHandoffStorageKey(handoff.userId, handoff.id), JSON.stringify(handoff));
};

export const removeSyncHandoff = (storage: Storage, userId: string, id: string): void => {
  storage.removeItem(syncHandoffStorageKey(userId, id));
};

export const readSyncHandoffsForUser = (
  storage: Storage,
  userId: string,
  validateInput: (input: EnqueueSyncMutation) => void,
): DurableSyncHandoff[] => {
  const handoffs: DurableSyncHandoff[] = [];
  const prefix = userPrefix(userId);
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    let parsed: DurableSyncHandoff;
    try {
      parsed = JSON.parse(raw) as DurableSyncHandoff;
    } catch (_) {
      throw new Error('SYNC_HANDOFF_CORRUPTED');
    }
    if (![1, 2].includes(parsed.version) || !parsed.id || parsed.id.includes('/') || !parsed.userId
      || !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0 || !parsed.input) {
      throw new Error('SYNC_HANDOFF_INVALID');
    }
    if (parsed.userId !== userId) throw new Error('SYNC_HANDOFF_USER_MISMATCH');
    validateInput(parsed.input);
    handoffs.push(parsed);
  }
  return handoffs.sort((left, right) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id));
};
