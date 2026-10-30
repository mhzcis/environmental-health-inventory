import {
  SyncPermanentError,
  type DurableSyncMutation,
  type SyncTransport,
  type SyncTransportCommitOutcome,
} from './syncCoordinator';
import { getCurrentAuthUser, supabaseDb, type SupabaseTableName } from './supabase';

export class FirestoreSyncTransport implements SyncTransport {
  constructor(
    private readonly _db?: unknown,
    private readonly _auth?: unknown,
  ) {}

  async commit(
    mutation: DurableSyncMutation,
    activeUserId: string,
  ): Promise<SyncTransportCommitOutcome> {
    const currentUser = getCurrentAuthUser();
    if (!currentUser) throw new SyncPermanentError('SYNC_AUTH_REQUIRED');
    if (currentUser.uid !== activeUserId || mutation.userId !== activeUserId) {
      throw new SyncPermanentError('SYNC_SESSION_IDENTITY_MISMATCH');
    }

    const upserts = new Map<SupabaseTableName, Array<{ id: string; payload: Record<string, unknown> }>>();
    const deletes = new Map<SupabaseTableName, string[]>();

    for (const op of mutation.operations) {
      const table = op.collection as SupabaseTableName;
      if (op.kind === 'delete') {
        const list = deletes.get(table) || [];
        list.push(op.docId);
        deletes.set(table, list);
      } else if (op.value) {
        const list = upserts.get(table) || [];
        list.push({ id: op.docId, payload: { ...op.value, id: op.docId } });
        upserts.set(table, list);
      }
    }

    for (const [table, entries] of upserts.entries()) {
      await supabaseDb.upsertDocs(table, entries);
    }
    for (const [table, ids] of deletes.entries()) {
      await supabaseDb.deleteDocs(table, ids);
    }

    return { effectiveMutation: mutation };
  }
}
