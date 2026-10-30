import type { SupabaseAuthUser as User } from './supabase';
import { auth } from './firebase';
import { firebaseAuthUserFingerprint } from './authLifecycleGuard';
import { assertProtectedCloudMutationAllowed } from '../security/pol4CloudMutationGate';
import { protectedEnqueueRefusedError } from '../security/p10AuthorityContract';

/** A transient initiating credential, never reconstructed from a durable UID or current session. */
export interface ManagedSessionOwner {
  readonly user: User;
  readonly uid: string;
  readonly fingerprint: string;
}

export class ManagedSessionChangedError extends Error {
  readonly code = 'managed/session-changed';
  constructor() {
    super('MANAGED_USER_SESSION_CHANGED');
    this.name = 'ManagedSessionChangedError';
  }
}

export const isManagedSessionChangedError = (error: unknown): error is ManagedSessionChangedError =>
  error instanceof ManagedSessionChangedError;

/** Recovery bookkeeping uses ownership alone; exact Auth compensation remains owner-independent. */
export const assertManagedSessionOwnerCurrent = (
  owner: ManagedSessionOwner,
  record?: { actorUid: string },
): void => {
  const current = auth?.currentUser;
  if (current !== owner.user || current?.uid !== owner.uid
    || firebaseAuthUserFingerprint(current) !== owner.fingerprint
    || (record && record.actorUid !== owner.uid)) throw new ManagedSessionChangedError();
};

/** Every new forward continuation requires both initiating ownership and current POL-4. */
export const assertManagedSessionAllowed = (owner: ManagedSessionOwner, record?: { actorUid: string }): void => {
  assertManagedSessionOwnerCurrent(owner, record);
  assertProtectedCloudMutationAllowed();
};

export const captureManagedSessionOwner = (): ManagedSessionOwner => {
  const user = auth?.currentUser;
  if (!user) throw protectedEnqueueRefusedError('NO_AUTH');
  const owner = Object.freeze({ user, uid: user.uid, fingerprint: firebaseAuthUserFingerprint(user) });
  assertManagedSessionAllowed(owner);
  return owner;
};
