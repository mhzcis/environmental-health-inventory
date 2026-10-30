/**
 * PREPROD-C — application-scoped service-worker (offline shell) health.
 *
 * Purpose: make a service-worker REGISTRATION / INSTALL / ACTIVATION failure observable instead of silently swallowed.
 * SCOPE LIMIT (PREPROD rework #2, ICC-02): ACTIVE means only "a worker is activated". It does NOT prove that the offline
 * shell is cached: public/sw.js (unchanged) lets install succeed with zero cached entries when the shell response is
 * not ok/basic or is Cache-Control no-store|private. "Offline shell unavailable" is therefore NOT observable here;
 * that is covered by the production smoke (reload offline with the worker active). The service worker only caches the
 * public same-origin app shell; domain data and authorization never depend on it. This module is therefore:
 *   - NOT an authentication/authorization authority (it imports nothing from auth/data/firebase modules and its state
 *     never changes login, session, role or sync behavior);
 *   - in-memory only (never written to localStorage/sessionStorage/IndexedDB/Cache/Firestore/audit/exports);
 *   - free of raw error text: a registration failure maps to an allowlisted code, never to `error.message`.
 *
 * States: UNSUPPORTED (no API) · REGISTERING · ACTIVE · FAILED · UPDATE_PENDING (a new worker waits behind an active one).
 */
export type ServiceWorkerHealthState = 'UNSUPPORTED' | 'REGISTERING' | 'ACTIVE' | 'FAILED' | 'UPDATE_PENDING';
export type ServiceWorkerFailureCode = 'REGISTER_REJECTED' | 'NO_WORKER' | 'INSTALL_REDUNDANT';
export type WorkerLifecycle = 'parsed' | 'installing' | 'installed' | 'activating' | 'activated' | 'redundant';

export interface ServiceWorkerHealthSnapshot {
  readonly state: ServiceWorkerHealthState;
  readonly failureCode: ServiceWorkerFailureCode | null;
}

export interface ServiceWorkerObservation {
  supported: boolean;
  /** Result of `navigator.serviceWorker.register(...)`. */
  settled: 'pending' | 'rejected' | 'fulfilled';
  installing: WorkerLifecycle | null;
  waiting: WorkerLifecycle | null;
  active: WorkerLifecycle | null;
  hasController: boolean;
}

/** Pure classifier (no I/O). */
export function classifyServiceWorkerHealth(observation: ServiceWorkerObservation): ServiceWorkerHealthSnapshot {
  if (!observation.supported) return { state: 'UNSUPPORTED', failureCode: null };
  if (observation.settled === 'rejected') return { state: 'FAILED', failureCode: 'REGISTER_REJECTED' };
  if (observation.settled === 'pending') return { state: 'REGISTERING', failureCode: null };
  const { installing, waiting, active } = observation;
  const activeReady = active === 'activated';
  // A newer worker is waiting behind one that already controls the app: a refresh will activate it.
  if (waiting && waiting !== 'redundant' && (activeReady || observation.hasController)) {
    return { state: 'UPDATE_PENDING', failureCode: null };
  }
  if (activeReady) return { state: 'ACTIVE', failureCode: null };
  if (installing === 'redundant' || waiting === 'redundant' || active === 'redundant') {
    return { state: 'FAILED', failureCode: 'INSTALL_REDUNDANT' };
  }
  if (installing || waiting || active) return { state: 'REGISTERING', failureCode: null };
  return { state: 'FAILED', failureCode: 'NO_WORKER' };
}

type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot: ServiceWorkerHealthSnapshot = { state: 'REGISTERING', failureCode: null };
let detachers: Array<() => void> = [];

const publish = (next: ServiceWorkerHealthSnapshot): void => {
  if (next.state === snapshot.state && next.failureCode === snapshot.failureCode) return;
  snapshot = next;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* a throwing subscriber must not affect others */ }
  }
};

export const getServiceWorkerHealth = (): ServiceWorkerHealthSnapshot => snapshot;
export const subscribeServiceWorkerHealth = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

interface WorkerLike { state: string; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void }
interface RegistrationLike extends Partial<EventTarget> {
  installing: WorkerLike | null;
  waiting: WorkerLike | null;
  active: WorkerLike | null;
}
export interface ServiceWorkerContainerLike {
  controller?: unknown;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

const KNOWN_LIFECYCLE: ReadonlySet<string> = new Set(['parsed', 'installing', 'installed', 'activating', 'activated', 'redundant']);
const lifecycleOf = (worker: WorkerLike | null | undefined): WorkerLifecycle | null =>
  worker && KNOWN_LIFECYCLE.has(worker.state) ? (worker.state as WorkerLifecycle) : worker ? 'parsed' : null;

const clearListeners = (): void => {
  for (const detach of detachers) {
    try { detach(); } catch { /* ignore */ }
  }
  detachers = [];
};

/** Initial state from API support only (call synchronously at startup). */
export function beginServiceWorkerHealth(container: ServiceWorkerContainerLike | undefined | null): ServiceWorkerHealthSnapshot {
  clearListeners();
  publish(container ? { state: 'REGISTERING', failureCode: null } : { state: 'UNSUPPORTED', failureCode: null });
  return snapshot;
}

/**
 * Observes the caller's own `register()` call (the call itself stays in main.tsx so the existing registration
 * scope/URL is unchanged). Never throws and never rethrows the registration error.
 */
export function trackServiceWorkerRegistration(
  register: () => Promise<unknown>,
  container: ServiceWorkerContainerLike,
): Promise<ServiceWorkerHealthSnapshot> {
  // A synchronous throw from register() is treated exactly like a rejection.
  return new Promise<unknown>((resolve, reject) => {
    try { resolve(register()); } catch (error) { reject(error); }
  }).then(
    (value) => {
      // PREPROD rework #1 (R2-PP-07/OBS-07): a fulfilled value that is not a registration (or any throw while observing it) is a
      // visible FAILED/NO_WORKER state, never an unhandled rejection of the tracker promise.
      if (value === null || typeof value !== 'object') {
        publish({ state: 'FAILED', failureCode: 'NO_WORKER' });
        return snapshot;
      }
      const reg = value as RegistrationLike;
      const evaluate = (): void => {
        try {
          publish(classifyServiceWorkerHealth({
            supported: true,
            settled: 'fulfilled',
            installing: lifecycleOf(reg.installing),
            waiting: lifecycleOf(reg.waiting),
            active: lifecycleOf(reg.active),
            hasController: Boolean(container.controller),
          }));
        } catch {
          publish({ state: 'FAILED', failureCode: 'NO_WORKER' });
        }
      };
      const watch = (target: { addEventListener?: (t: string, l: () => void) => void; removeEventListener?: (t: string, l: () => void) => void } | null | undefined, type: string): void => {
        if (!target?.addEventListener) return;
        target.addEventListener(type, evaluate);
        detachers.push(() => target.removeEventListener?.(type, evaluate));
      };
      clearListeners();
      watch(container, 'controllerchange');
      for (const worker of [reg.installing, reg.waiting, reg.active]) watch(worker, 'statechange');
      // Workers created later (an update) are watched when `updatefound` fires.
      if (reg.addEventListener) {
        const watchNewInstalling = (): void => { watch(reg.installing, 'statechange'); evaluate(); };
        reg.addEventListener('updatefound', watchNewInstalling);
        detachers.push(() => reg.removeEventListener?.('updatefound', watchNewInstalling));
      }
      evaluate();
      return snapshot;
    },
    () => {
      publish({ state: 'FAILED', failureCode: 'REGISTER_REJECTED' });
      return snapshot;
    },
  ).catch(() => {
    // Anything thrown while observing a fulfilled registration (hostile getters, listener wiring): visible, not unhandled.
    publish({ state: 'FAILED', failureCode: 'NO_WORKER' });
    return snapshot;
  });
}

/** Test-only reset. */
export function __resetServiceWorkerHealthForTests(): void {
  clearListeners();
  listeners.clear();
  snapshot = { state: 'REGISTERING', failureCode: null };
}
