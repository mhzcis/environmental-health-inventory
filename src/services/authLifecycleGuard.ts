export interface FirebaseAuthUserLike {
  uid: string;
  metadata?: {
    creationTime?: string;
    lastSignInTime?: string;
  };
}

export const firebaseAuthUserFingerprint = (user: FirebaseAuthUserLike): string => JSON.stringify({
  uid: user.uid,
  created: user.metadata?.creationTime || '',
  signedIn: user.metadata?.lastSignInTime || '',
});

/**
 * Firebase can deliver an already-queued callback after currentUser has moved on. UID equality is
 * deliberately insufficient: a same-account re-login is a different credential lifecycle.
 */
export function isDeliveredAuthStateCurrent<T extends FirebaseAuthUserLike>(
  deliveredUser: T | null,
  currentUser: T | null,
): boolean {
  if (deliveredUser === null) return currentUser === null;
  return currentUser === deliveredUser
    && firebaseAuthUserFingerprint(currentUser) === firebaseAuthUserFingerprint(deliveredUser);
}

export type AuthTeardownPhase =
  | 'stop-profile-watcher'
  | 'stop-cloud-sync'
  | 'deactivate-private-projection'
  | 'clear-session-marker'
  | 'clear-local-marker'
  | 'remember-local-termination'
  | 'write-local-tombstone'
  | 'write-durable-tombstone'
  | 'firebase-sign-out';

export interface AuthTeardownFailure {
  phase: AuthTeardownPhase;
  message: string;
}

export interface AuthTeardownAction {
  phase: AuthTeardownPhase;
  run: () => void | Promise<void>;
}

export interface AuthTeardownResult {
  failures: AuthTeardownFailure[];
  superseded: boolean;
}

const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Attempts every security action independently while the captured auth object/fingerprint/attempt
 * still owns the lifecycle. Failures are collected and returned only after the remaining privacy
 * actions have had their chance to run. Once ownership changes, later actions are not touched.
 */
export async function executeOwnerScopedAuthTeardown(
  isOwnerCurrent: () => boolean,
  actions: readonly AuthTeardownAction[],
): Promise<AuthTeardownResult> {
  const failures: AuthTeardownFailure[] = [];

  for (const action of actions) {
    if (!isOwnerCurrent()) return { failures, superseded: true };
    try {
      await action.run();
    } catch (error) {
      failures.push({ phase: action.phase, message: failureMessage(error) });
    }
    // This post-await fence is intentional. Even a rejected action can yield long enough for a
    // different (including same-UID) Firebase User object to take ownership.
    if (!isOwnerCurrent()) return { failures, superseded: true };
  }

  return { failures, superseded: false };
}
