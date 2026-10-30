/**
 * P10-POL-4 shared fail-closed gate for EVERY durable cloud mutation producer.
 *
 * Permanent rule: POL-4 coverage = every durable cloud mutation producer,
 * not only queueCloudMutation. Managed-user Receipt path, legacy migration,
 * and domain AppSync enqueue must all call the same assert before side effects.
 *
 * Client hasPermission / localStorage are NEVER substitutes for this gate or Rules.
 */
import { auth } from '../services/firebase';
import { firebaseAuthUserFingerprint } from '../services/authLifecycleGuard';
import { isAuthTerminationRemembered } from '../services/authTerminationStore';
import {
  getOfflineProjectionAuthorityContext,
  offlineProjectionStorage,
} from '../services/offlineDomainStore';
import {
  getProtectedCloudEnqueueBlockReason,
  protectedEnqueueRefusedError,
  type ProtectedEnqueueBlockReason,
} from './p10AuthorityContract';

const USERS_KEY = 'remix_users_v1';
const CURRENT_USER_KEY = 'remix_current_user_v1';
const LEGACY_LOCALLY_TERMINATED_FIREBASE_UID_KEY = 'remix_locally_terminated_firebase_uid_v1';
const locallyTerminatedFirebaseUidKey = (uid: string): string =>
  `${LEGACY_LOCALLY_TERMINATED_FIREBASE_UID_KEY}:${encodeURIComponent(uid)}`;

const readCurrentUserProjection = (tabScoped: boolean): {
  id: string;
  authUid?: string;
  active?: boolean;
} | null => {
  try {
    // P10 G1-fail correction: remix_users_v1 is an OfflineDomain tab-scoped key. Once an
    // OfflineDomain is active, offlineProjectionStorage is the canonical mounted projection and
    // intentionally ignores stale localStorage copies.
    const rawUsers = offlineProjectionStorage?.getItem(USERS_KEY);
    const users = rawUsers ? JSON.parse(rawUsers) : [];
    if (!Array.isArray(users)) return null;

    // CURRENT_USER is not part of OFFLINE_DOMAIN_STORAGE_KEYS. During an active domain, only the
    // current tab's session marker may select a profile. Falling back to localStorage here would
    // allow stale account A state to influence account B after a session switch.
    const rawVal = tabScoped
      ? globalThis.sessionStorage?.getItem(CURRENT_USER_KEY)
      : globalThis.sessionStorage?.getItem(CURRENT_USER_KEY)
        || globalThis.localStorage?.getItem(CURRENT_USER_KEY);
    if (!rawVal) return null;

    let targetId = rawVal;
    if (rawVal.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawVal);
        if (parsed?.id) targetId = parsed.id;
        else if (parsed?.username) targetId = parsed.username;
      } catch {
        // keep raw
      }
    }
    const found = users.find((u: any) =>
      u && (u.id === targetId || String(u.username || '').trim().toLowerCase() === String(targetId).trim().toLowerCase())
    );
    return found || null;
  } catch {
    return null;
  }
};

const isSessionLocallyTerminated = (uid: string): boolean => {
  const currentUser = auth?.currentUser;
  const currentIdentity = currentUser?.uid === uid ? firebaseAuthUserFingerprint(currentUser) : null;
  return (!!currentIdentity
      && globalThis.localStorage?.getItem(locallyTerminatedFirebaseUidKey(uid)) === currentIdentity)
    || globalThis.localStorage?.getItem(LEGACY_LOCALLY_TERMINATED_FIREBASE_UID_KEY) === uid;
};

interface ProtectedCloudMutationGateOptions {
  /**
   * LOGIN-FIX: only the first-login profile bootstrap (ensureCanonicalCurrentUserProfile) may run
   * before the tab's local current-user projection exists. It authorizes from the server users/{uid}
   * document (email/UID binding, active, P7 schema) and Rules enforce its write. Every other check
   * (block/revoke, NO_AUTH, SESSION_TERMINATED, remembered termination, projection owner/UID) still applies.
   */
  allowMissingLocalProfile?: boolean;
}

const assertProtectedCloudMutationGate = (options: ProtectedCloudMutationGateOptions): void => {
  const blocked = getProtectedCloudEnqueueBlockReason();
  if (blocked) {
    throw protectedEnqueueRefusedError(blocked);
  }
  const authenticatedUserId = auth?.currentUser?.uid || null;
  if (!authenticatedUserId) {
    throw protectedEnqueueRefusedError('NO_AUTH');
  }
  if (isSessionLocallyTerminated(authenticatedUserId)) {
    throw protectedEnqueueRefusedError('SESSION_TERMINATED');
  }
  const currentIdentity = firebaseAuthUserFingerprint(auth!.currentUser!);
  if (isAuthTerminationRemembered(authenticatedUserId, currentIdentity)) {
    throw protectedEnqueueRefusedError('SESSION_TERMINATED');
  }

  const projection = getOfflineProjectionAuthorityContext();
  if (projection.tabScoped && (!projection.activeUserId || !projection.projectionOwner)) {
    throw protectedEnqueueRefusedError('INACTIVE_OR_MISSING_PROFILE');
  }
  if (projection.activeUserId && projection.activeUserId !== authenticatedUserId) {
    throw protectedEnqueueRefusedError('AUTH_UID_MISMATCH');
  }
  if (projection.tabScoped && projection.projectionOwner !== projection.activeUserId) {
    throw protectedEnqueueRefusedError('AUTH_UID_MISMATCH');
  }

  const current = readCurrentUserProjection(projection.tabScoped);
  if (!options.allowMissingLocalProfile
    && (!current || current.id === 'guest' || current.active === false)) {
    throw protectedEnqueueRefusedError('INACTIVE_OR_MISSING_PROFILE');
  }
  if (current?.authUid && current.authUid !== authenticatedUserId) {
    throw protectedEnqueueRefusedError('AUTH_UID_MISMATCH');
  }
};

/**
 * Fail closed before ANY new durable cloud mutation side effect.
 * Does not delete/forge/reassign prior durable work.
 */
export function assertProtectedCloudMutationAllowed(): void {
  assertProtectedCloudMutationGate({});
}

/**
 * LOGIN-FIX: the profile-bootstrap variant, for ensureCanonicalCurrentUserProfile ONLY. On a fresh
 * tab/session the local current-user projection cannot exist yet (it is set after this function by
 * setCurrentUser), so only the local-profile existence/active step is skipped; a present projection
 * bound to another Firebase UID is still refused.
 */
export function assertProtectedProfileBootstrapAllowed(): void {
  assertProtectedCloudMutationGate({ allowMissingLocalProfile: true });
}

/** @deprecated name retained for queueCloudMutation call sites — same gate. */
export const assertProtectedCloudEnqueueAllowed = assertProtectedCloudMutationAllowed;

export type { ProtectedEnqueueBlockReason };
