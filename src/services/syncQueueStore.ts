import type { DurableSyncMutation } from './syncCoordinator';

export interface SyncQueueStore {
  insert(mutation: DurableSyncMutation): Promise<boolean>;
  put(mutation: DurableSyncMutation): Promise<void>;
  get(id: string): Promise<DurableSyncMutation | undefined>;
  delete(id: string): Promise<void>;
  listForUser(userId: string): Promise<DurableSyncMutation[]>;
  clearForUser(userId: string): Promise<number>;
  claimNext(userId: string, now: number, ownerId: string, leaseMs: number): Promise<DurableSyncMutation | undefined>;
  updateClaimed(mutation: DurableSyncMutation, ownerId: string): Promise<boolean>;
  deleteClaimed(id: string, ownerId: string): Promise<boolean>;
}

const DB_NAME = 'remix_inventory_sync_v1';
const DB_VERSION = 1;
const MUTATIONS_STORE = 'mutations';

const requestAsPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_REQUEST_FAILED'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_TRANSACTION_ABORTED'));
    transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_TRANSACTION_FAILED'));
  });

export class IndexedDbSyncQueueStore implements SyncQueueStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly indexedDb: IDBFactory | undefined = globalThis.indexedDB) {}

  private open(): Promise<IDBDatabase> {
    if (!this.indexedDb) return Promise.reject(new Error('INDEXEDDB_UNAVAILABLE'));
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = this.indexedDb!.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MUTATIONS_STORE)) {
          const store = db.createObjectStore(MUTATIONS_STORE, { keyPath: 'id' });
          store.createIndex('by_user', 'userId', { unique: false });
          store.createIndex('by_user_status_due', ['userId', 'status', 'nextAttemptAt'], { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error ?? new Error('INDEXEDDB_OPEN_FAILED'));
      };
      request.onblocked = () => {
        this.dbPromise = null;
        reject(new Error('INDEXEDDB_UPGRADE_BLOCKED'));
      };
    });
    return this.dbPromise;
  }

  async insert(mutation: DurableSyncMutation): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(MUTATIONS_STORE, 'readwrite');
      const store = transaction.objectStore(MUTATIONS_STORE);
      const request = store.get(mutation.id);
      let inserted = false;
      request.onsuccess = () => {
        if (request.result !== undefined) return;
        store.add(mutation);
        inserted = true;
      };
      request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_INSERT_READ_FAILED'));
      transaction.oncomplete = () => resolve(inserted);
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_INSERT_ABORTED'));
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_INSERT_FAILED'));
    });
  }

  async put(mutation: DurableSyncMutation): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(MUTATIONS_STORE, 'readwrite');
    transaction.objectStore(MUTATIONS_STORE).put(mutation);
    await transactionDone(transaction);
  }

  async get(id: string): Promise<DurableSyncMutation | undefined> {
    const db = await this.open();
    const transaction = db.transaction(MUTATIONS_STORE, 'readonly');
    const result = await requestAsPromise(transaction.objectStore(MUTATIONS_STORE).get(id));
    await transactionDone(transaction);
    return result as DurableSyncMutation | undefined;
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(MUTATIONS_STORE, 'readwrite');
    transaction.objectStore(MUTATIONS_STORE).delete(id);
    await transactionDone(transaction);
  }

  async listForUser(userId: string): Promise<DurableSyncMutation[]> {
    const db = await this.open();
    const transaction = db.transaction(MUTATIONS_STORE, 'readonly');
    const index = transaction.objectStore(MUTATIONS_STORE).index('by_user');
    const result = await requestAsPromise(index.getAll(IDBKeyRange.only(userId)));
    await transactionDone(transaction);
    return (result as DurableSyncMutation[]).sort(compareMutations);
  }

  async clearForUser(userId: string): Promise<number> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(MUTATIONS_STORE, 'readwrite');
      const store = transaction.objectStore(MUTATIONS_STORE);
      const request = store.index('by_user').getAllKeys(IDBKeyRange.only(userId));
      let deleted = 0;
      request.onsuccess = () => {
        for (const key of request.result) {
          store.delete(key);
          deleted += 1;
        }
      };
      request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_CLEAR_USER_READ_FAILED'));
      transaction.oncomplete = () => resolve(deleted);
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_CLEAR_USER_ABORTED'));
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_CLEAR_USER_FAILED'));
    });
  }

  async claimNext(userId: string, now: number, ownerId: string, leaseMs: number): Promise<DurableSyncMutation | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(MUTATIONS_STORE, 'readwrite');
      const store = transaction.objectStore(MUTATIONS_STORE);
      const request = store.index('by_user').getAll(IDBKeyRange.only(userId));
      let claimed: DurableSyncMutation | undefined;
      request.onsuccess = () => {
        const candidates = (request.result as DurableSyncMutation[])
          .filter(mutation => mutation.status === 'pending' || mutation.status === 'retrying' || mutation.status === 'processing')
          .sort(compareMutations);
        const next = candidates[0];
        if (!next) return;
        if (next.status === 'processing' && (next.leaseExpiresAt ?? 0) > now) return;
        if (next.status !== 'processing' && next.nextAttemptAt > now) return;
        claimed = {
          ...next,
          status: 'processing',
          leaseOwner: ownerId,
          leaseExpiresAt: now + leaseMs,
          updatedAt: now,
        };
        store.put(claimed);
      };
      request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_CLAIM_READ_FAILED'));
      transaction.oncomplete = () => resolve(claimed);
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_CLAIM_ABORTED'));
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_CLAIM_FAILED'));
    });
  }

  async updateClaimed(mutation: DurableSyncMutation, ownerId: string): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(MUTATIONS_STORE, 'readwrite');
      const store = transaction.objectStore(MUTATIONS_STORE);
      const request = store.get(mutation.id);
      let updated = false;
      request.onsuccess = () => {
        const current = request.result as DurableSyncMutation | undefined;
        if (!current || current.leaseOwner !== ownerId) return;
        store.put(mutation);
        updated = true;
      };
      request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_CLAIM_UPDATE_READ_FAILED'));
      transaction.oncomplete = () => resolve(updated);
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_CLAIM_UPDATE_ABORTED'));
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_CLAIM_UPDATE_FAILED'));
    });
  }

  async deleteClaimed(id: string, ownerId: string): Promise<boolean> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(MUTATIONS_STORE, 'readwrite');
      const store = transaction.objectStore(MUTATIONS_STORE);
      const request = store.get(id);
      let deleted = false;
      request.onsuccess = () => {
        const current = request.result as DurableSyncMutation | undefined;
        if (!current || current.leaseOwner !== ownerId) return;
        store.delete(id);
        deleted = true;
      };
      request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_CLAIM_DELETE_READ_FAILED'));
      transaction.oncomplete = () => resolve(deleted);
      transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_CLAIM_DELETE_ABORTED'));
      transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_CLAIM_DELETE_FAILED'));
    });
  }
}

export const compareMutations = (left: DurableSyncMutation, right: DurableSyncMutation): number =>
  left.createdAt - right.createdAt || left.id.localeCompare(right.id);
