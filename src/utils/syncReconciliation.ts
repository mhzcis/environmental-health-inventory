import { fingerprintDocument, readSyncMetadata, readSyncRevision } from './syncProtocol';

export interface ConfirmedSyncDocumentState {
  fingerprint: string;
  revision: number;
  mutationId?: string;
}

export type RemoteDocumentDecision =
  | { action: 'apply-remote'; reason: 'remote-only' | 'matched' | 'remote-changed' }
  | { action: 'delete-local'; reason: 'remote-deleted' }
  | { action: 'keep-local'; reason: 'unresolved-local-mutation' }
  | { action: 'noop'; reason: 'both-missing' }
  | { action: 'conflict'; reason: 'initial-local-only' | 'initial-divergence' | 'untracked-local-change' };

const isMissing = (value: unknown): boolean => value === null || value === undefined;

export const confirmedStateForAppliedValue = (
  remoteValue: unknown,
  appliedLocalValue: unknown,
): ConfirmedSyncDocumentState => {
  const metadata = readSyncMetadata(remoteValue);
  return {
    fingerprint: fingerprintDocument(appliedLocalValue),
    revision: readSyncRevision(remoteValue),
    ...(metadata?.mutationId ? { mutationId: metadata.mutationId } : {}),
  };
};

export const confirmedStateForRemote = (remoteValue: unknown): ConfirmedSyncDocumentState =>
  confirmedStateForAppliedValue(remoteValue, remoteValue);

export const decideRemoteDocument = (
  localValue: unknown,
  remoteValue: unknown,
  confirmedState: ConfirmedSyncDocumentState | undefined,
  hasUnresolvedLocalMutation: boolean,
): RemoteDocumentDecision => {
  if (hasUnresolvedLocalMutation) {
    return { action: 'keep-local', reason: 'unresolved-local-mutation' };
  }

  const localMissing = isMissing(localValue);
  const remoteMissing = isMissing(remoteValue);
  if (!confirmedState) {
    if (localMissing && remoteMissing) return { action: 'noop', reason: 'both-missing' };
    if (localMissing) return { action: 'apply-remote', reason: 'remote-only' };
    if (remoteMissing) return { action: 'conflict', reason: 'initial-local-only' };
    if (fingerprintDocument(localValue) === fingerprintDocument(remoteValue)) {
      return { action: 'apply-remote', reason: 'matched' };
    }
    return { action: 'conflict', reason: 'initial-divergence' };
  }

  const localAtBase = !localMissing && fingerprintDocument(localValue) === confirmedState.fingerprint;
  if (!localAtBase) return { action: 'conflict', reason: 'untracked-local-change' };
  if (remoteMissing) return { action: 'delete-local', reason: 'remote-deleted' };

  const remoteAtBase = fingerprintDocument(remoteValue) === confirmedState.fingerprint
    && readSyncRevision(remoteValue) === confirmedState.revision;
  return remoteAtBase
    ? { action: 'apply-remote', reason: 'matched' }
    : { action: 'apply-remote', reason: 'remote-changed' };
};
