// @vitest-environment jsdom
// R8-AUTH-01 (option A): an unreachable server during the live profile gate is an online-required/retry state,
// not a denial. The session, owned local data and the outbox are kept; nothing is sent or shown until a live
// revalidation passes; a revoked/disabled/changed profile still fails closed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const fake = vi.hoisted(() => ({
  listener: null as null | ((user: any) => void),
  gate: vi.fn(), signOut: vi.fn(async () => {}), ensure: vi.fn(), bootstrap: vi.fn(), device: vi.fn(),
  setCurrentUser: vi.fn(), initCloudSync: vi.fn(async () => {}), stopCloudSync: vi.fn(), persisted: false,
  refresh: vi.fn(async () => false),
}));
vi.mock('../src/services/supabase', () => ({
  isSupabaseConfigured: () => true,
  subscribeAuthState: (listener: any) => { fake.listener = listener; return () => { fake.listener = null; }; },
  supabaseAuthSignOut: fake.signOut,
  hasPersistedAuthSession: () => fake.persisted,
  refreshAuthSession: fake.refresh,
}));
vi.mock('../src/services/supabaseOutbox', () => ({ setInventoryOutboxSendGate: fake.gate }));
vi.mock('../src/services/legacyUserMigration', () => ({ ensureCanonicalCurrentUserProfile: fake.ensure }));
vi.mock('../src/services/dataService', () => ({
  dataService: {
    getUsers: () => [], beginFirebaseAuthSession: vi.fn(), bootstrapCurrentFirebaseUser: fake.bootstrap,
    bootstrapFreshDeviceData: fake.device, setCurrentUser: fake.setCurrentUser, logAudit: vi.fn(async () => {}),
  },
  initCloudSync: fake.initCloudSync, stopCloudSync: fake.stopCloudSync,
  watchCurrentFirebaseUserProfile: () => () => {},
}));
vi.mock('../src/app/Router', () => ({ default: () => <div>APP-ROUTES</div> }));
vi.mock('../src/components/Login', () => ({ default: () => <div>LOGIN-FORM</div> }));
vi.mock('../src/context/StorehouseContext', () => ({ StorehouseProvider: ({ children }: any) => <>{children}</> }));
vi.mock('../src/services/operationalDiagnostics', () => ({ bindDiagnosticsSession: () => {}, clearDiagnostics: () => {} }));
vi.mock('../src/services/unattributedRuntimeAlert', () => ({ clearUnattributedRuntimeAlert: () => {} }));
import App from '../src/App';
import { isAuthNetworkUnavailable } from '../src/services/authAvailability';

const user = { uid: 'u-1', email: 'keeper@example.invalid', metadata: {} };
const profile = { id: 'u-1', authUid: 'u-1', username: 'keeper@example.invalid', fullName: 'Keeper', role: 'أمين مستودع', permissions: ['materials_view'], active: true };
const offline = (value: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !value });
const signIn = async (u: any = user) => { await act(async () => { fake.listener?.(u); await Promise.resolve(); }); };

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); offline(false); fake.persisted = false;
  localStorage.setItem('remix_current_user_v1', 'u-1');
  localStorage.setItem('remix_materials_v1', '[{"id":"owned"}]');
  fake.bootstrap.mockResolvedValue({ success: true, user: profile, message: 'ok' });
  fake.device.mockResolvedValue({ success: true });
});
afterEach(() => { cleanup(); offline(false); });

describe('R8-AUTH-01 online-required instead of fail-closed on network unavailability', () => {
  it('R8-AUTH-T1 unavailable profile gate keeps session/data/outbox, blocks sending, then revalidates on reconnect', async () => {
    fake.ensure.mockResolvedValueOnce({ success: false, migrated: false, reason: 'unavailable', message: 'offline' });
    render(<App />); await signIn();
    expect(await screen.findByTestId('online-required')).toBeTruthy();
    expect(screen.queryByText('APP-ROUTES')).toBeNull(); expect(screen.queryByText('LOGIN-FORM')).toBeNull();
    expect(fake.signOut).not.toHaveBeenCalled();
    expect(localStorage.getItem('remix_current_user_v1')).toBe('u-1');
    expect(localStorage.getItem('remix_materials_v1')).toBe('[{"id":"owned"}]');
    expect(fake.gate).toHaveBeenLastCalledWith(false);
    expect(fake.gate).not.toHaveBeenCalledWith(true);
    expect(fake.setCurrentUser).not.toHaveBeenCalled();
    fake.ensure.mockResolvedValueOnce({ success: true, migrated: false, message: 'ok' });
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(await screen.findByText('APP-ROUTES')).toBeTruthy();
    expect(fake.setCurrentUser).toHaveBeenCalledWith('u-1');
    expect(fake.gate).toHaveBeenLastCalledWith(true);
    expect(fake.signOut).not.toHaveBeenCalled();
  });
  it('R8-AUTH-T2 network failure inside profile bootstrap is also online-required; manual retry works', async () => {
    fake.ensure.mockResolvedValue({ success: true, migrated: false, message: 'ok' });
    fake.bootstrap.mockResolvedValueOnce({ success: false, message: 'NETWORK_UNAVAILABLE:x' });
    render(<App />); await signIn();
    expect(await screen.findByTestId('online-required')).toBeTruthy();
    expect(fake.signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('APP-ROUTES')).toBeTruthy();
  });
  it('R8-AUTH-T3 thrown fetch TypeError during device bootstrap is online-required, not a sign-out', async () => {
    fake.ensure.mockResolvedValue({ success: true, migrated: false, message: 'ok' });
    fake.device.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<App />); await signIn();
    expect(await screen.findByTestId('online-required')).toBeTruthy();
    expect(fake.signOut).not.toHaveBeenCalled();
  });
  it('R8-AUTH-T4 a revoked/disabled profile still fails closed (sign-out, marker cleared, gate stays closed)', async () => {
    fake.ensure.mockResolvedValueOnce({ success: false, migrated: false, reason: 'denied', message: 'عذراً، هذا الحساب معطل' });
    render(<App />); await signIn();
    await waitFor(() => expect(fake.signOut).toHaveBeenCalled());
    expect(localStorage.getItem('remix_current_user_v1')).toBeNull();
    expect(await screen.findByText('LOGIN-FORM')).toBeTruthy();
    expect(screen.queryByTestId('online-required')).toBeNull();
    expect(fake.gate).not.toHaveBeenCalledWith(true);
  });
  it('R8-AUTH-T5 a changed profile identity (authUid mismatch) fails closed even though the server was reachable', async () => {
    fake.ensure.mockResolvedValue({ success: true, migrated: false, message: 'ok' });
    fake.bootstrap.mockResolvedValueOnce({ success: true, user: { ...profile, authUid: 'someone-else' }, message: 'ok' });
    render(<App />); await signIn();
    await waitFor(() => expect(fake.signOut).toHaveBeenCalled());
    expect(fake.setCurrentUser).not.toHaveBeenCalled();
  });
  it('R8-AUTH-T6 offline cold start whose token could not refresh keeps the persisted session (online-required, no login form)', async () => {
    offline(true); fake.persisted = true;
    render(<App />); await signIn(null);
    expect(await screen.findByTestId('online-required')).toBeTruthy();
    expect(localStorage.getItem('remix_current_user_v1')).toBe('u-1');
    expect(fake.signOut).not.toHaveBeenCalled();
  });
  it('R1-R2-09 token-less offline state: "retry now" asks the SDK to refresh the session; the delivered user is then live-revalidated (gate opens only after)', async () => {
    offline(true); fake.persisted = true;
    render(<App />); await signIn(null);
    expect(await screen.findByTestId('online-required')).toBeTruthy();
    offline(false);
    fake.refresh.mockImplementationOnce(async () => { await act(async () => { fake.listener?.(user); await Promise.resolve(); }); return true; });
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('APP-ROUTES')).toBeTruthy();
    expect(fake.ensure).toHaveBeenCalled();
    expect(fake.gate).toHaveBeenLastCalledWith(true);
  });
  it('R8-AUTH-T7 a real sign-out (online, no persisted session) still shows login and clears the marker', async () => {
    render(<App />); await signIn(null);
    expect(await screen.findByText('LOGIN-FORM')).toBeTruthy();
    expect(localStorage.getItem('remix_current_user_v1')).toBeNull();
  });
});

describe('R8-AUTH-01 classification', () => {
  it('R8-AUTH-U1 transport failures are unavailable; server answers are not', () => {
    expect(isAuthNetworkUnavailable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isAuthNetworkUnavailable({ message: 'TypeError: NetworkError when attempting to fetch resource.' })).toBe(true);
    expect(isAuthNetworkUnavailable(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }))).toBe(true);
    expect(isAuthNetworkUnavailable({ code: '42501', message: 'permission denied (fetch)' })).toBe(false);
    expect(isAuthNetworkUnavailable({ status: 401, message: 'JWT expired' })).toBe(false);
    expect(isAuthNetworkUnavailable({ code: 'PGRST301', message: 'JWT invalid' })).toBe(false);
    expect(isAuthNetworkUnavailable(new Error('INVENTORY_PROFILE_DISABLED'))).toBe(false);
    offline(true); expect(isAuthNetworkUnavailable(new Error('anything'))).toBe(true); offline(false);
  });
});
