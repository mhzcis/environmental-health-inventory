export type LogoutPhase =
  | 'audit'
  | 'stop-sync'
  | 'clear-session'
  | 'clear-private-projection'
  | 'publish-termination'
  | 'firebase-sign-out';

export interface LogoutFailure {
  phase: LogoutPhase;
  message: string;
}

export interface LogoutResult {
  audit: 'recorded-or-enqueued' | 'failed';
  signOutSucceeded: boolean;
  failures: LogoutFailure[];
  /** Present only when a newer authenticated lifecycle took ownership during this teardown. */
  superseded?: true;
}

export interface LogoutDependencies {
  /**
   * A cheap, side-effect-free generation/identity fence. It is evaluated before the audit and
   * before every teardown phase, including after each preceding await.
   */
  isOwnerCurrent?: () => boolean;
  recordAudit: () => void | Promise<void>;
  stopSync: () => void | Promise<void>;
  clearSession: () => void | Promise<void>;
  clearPrivateProjection: () => void | Promise<void>;
  publishTermination: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  auditDeadlineMs?: number;
}

export class LogoutSingleFlight {
  private current: Promise<LogoutResult> | null = null;

  run(factory: () => Promise<LogoutResult>): Promise<LogoutResult> {
    if (!this.current) this.current = Promise.resolve().then(factory);
    return this.current;
  }

  reset(): void {
    this.current = null;
  }
}

export function assertLogoutAuditOwnership(
  expectedFirebaseUid: string | null,
  expectedDomainUid: string | null,
  currentFirebaseUid: string | null,
  currentDomainUid: string | null,
): void {
  if (!expectedFirebaseUid || expectedDomainUid !== expectedFirebaseUid
    || currentFirebaseUid !== expectedFirebaseUid || currentDomainUid !== expectedDomainUid) {
    throw new Error('LOGOUT_AUDIT_SESSION_IDENTITY_MISMATCH');
  }
}

const failureMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Records the logout intent before tearing down its owner-scoped coordinator when possible, then
 * independently attempts every security teardown step. A failed audit, coordinator, storage call,
 * or Firebase sign-out can therefore never short-circuit the remaining local privacy actions.
 */
export async function executeFailSafeLogout(dependencies: LogoutDependencies): Promise<LogoutResult> {
  const failures: LogoutFailure[] = [];
  let audit: LogoutResult['audit'] = 'recorded-or-enqueued';
  let signOutSucceeded = true;
  let superseded = false;

  const ownerIsCurrent = (): boolean => dependencies.isOwnerCurrent?.() ?? true;
  const stopIfSuperseded = (): boolean => {
    if (ownerIsCurrent()) return false;
    superseded = true;
    return true;
  };

  try {
    if (stopIfSuperseded()) return { audit, signOutSucceeded, failures, superseded: true };
    const auditDeadlineMs = dependencies.auditDeadlineMs ?? 2_500;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(dependencies.recordAudit),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('LOGOUT_AUDIT_DEADLINE_EXCEEDED')),
            auditDeadlineMs,
          );
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  } catch (error) {
    audit = 'failed';
    failures.push({ phase: 'audit', message: failureMessage(error) });
  } finally {
    const attempt = async (phase: LogoutPhase, action: () => void | Promise<void>): Promise<boolean> => {
      // A newer login owns every global/current singleton from this point onward. Do not merely
      // skip one action: terminate the stale pipeline so no later action can touch that owner.
      if (stopIfSuperseded()) return false;
      try {
        await action();
      } catch (error) {
        if (phase === 'firebase-sign-out') signOutSucceeded = false;
        failures.push({ phase, message: failureMessage(error) });
      }
      return true;
    };

    // Keep this ordering explicit: stop owner-scoped cloud callbacks, erase session markers and
    // the mounted private projection, publish local termination, then ask Firebase to sign out.
    // Each operation remains independent so a broken coordinator/storage implementation cannot
    // leave later teardown steps unattempted.
    if (await attempt('stop-sync', dependencies.stopSync)
      && await attempt('clear-session', dependencies.clearSession)
      && await attempt('clear-private-projection', dependencies.clearPrivateProjection)
      && await attempt('publish-termination', dependencies.publishTermination)) {
      await attempt('firebase-sign-out', dependencies.signOut);
    }
  }

  return superseded
    ? { audit, signOutSucceeded, failures, superseded: true }
    : { audit, signOutSucceeded, failures };
}
