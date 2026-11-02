// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createPasswordRecovery, passwordRecoveryMessage, RECOVERY_AUTH_KEY } from '../src/services/passwordRecovery';
import PasswordRecovery from '../src/components/PasswordRecovery';
import Login from '../src/components/Login';
import { passwordRecoveryUrl } from '../src/services/supabaseConfig';
import { safeUserMessage } from '../src/services/safeUserMessage';

const fake = vi.hoisted(() => ({ createClient: vi.fn(), getSession: vi.fn(), getUser: vi.fn(), updateUser: vi.fn(), signOut: vi.fn(), unsubscribe: vi.fn(), sendReset: vi.fn(), callback: null as any }));
vi.mock('@supabase/supabase-js', () => ({ createClient: (...args: any[]) => fake.createClient(...args) }));
vi.mock('../src/services/supabase', () => ({ supabaseSendPasswordReset: (...args: any[]) => fake.sendReset(...args) }));
vi.mock('../src/services/dataService', () => ({ dataService: { getSettings: () => ({ organizationName: 'Test', departmentName: 'Test' }) } }));
const session = { user: { id: 'synthetic-user' } };
const url = 'https://example.com/environmental-health-inventory/reset-password.html';
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear();
  fake.getSession.mockResolvedValue({ data: { session }, error: null });
  fake.getUser.mockResolvedValue({ data: { user: session.user }, error: null });
  fake.updateUser.mockResolvedValue({ data: { user: session.user }, error: null });
  fake.signOut.mockResolvedValue({ error: null });
  fake.sendReset.mockResolvedValue(undefined);
  fake.createClient.mockImplementation(() => ({ auth: {
    getSession: fake.getSession, getUser: fake.getUser, updateUser: fake.updateUser, signOut: fake.signOut,
    onAuthStateChange: (callback: any) => { fake.callback = callback; return { data: { subscription: { unsubscribe: fake.unsubscribe } } }; },
  } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Recovery session isolation and verification', () => {
  it('waits for a delayed recovery event after the session is loaded', async () => {
    const recovery = createPasswordRecovery(sessionStorage, url + '#type=recovery&access_token=synthetic&refresh_token=synthetic');
    fake.callback('INITIAL_SESSION', session);
    let initialized = false;
    const pending = recovery.initialize().then(() => { initialized = true; });
    await Promise.resolve();
    expect(initialized).toBe(false);
    expect(fake.getUser).not.toHaveBeenCalled();
    fake.callback('PASSWORD_RECOVERY', session);
    await pending;
    expect(initialized).toBe(true);
    recovery.dispose();
  });
  it('fails closed if a recovery event never arrives', async () => {
    vi.useFakeTimers();
    const recovery = createPasswordRecovery(sessionStorage, url + '#type=recovery&access_token=synthetic&refresh_token=synthetic');
    const pending = expect(recovery.initialize()).rejects.toThrow('RECOVERY_LINK_INVALID');
    fake.callback('INITIAL_SESSION', session);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(fake.getUser).not.toHaveBeenCalled();
    expect(fake.updateUser).not.toHaveBeenCalled();
    recovery.dispose();
  });
  it('rejects a recovery event whose user differs from the loaded session', async () => {
    const recovery = createPasswordRecovery(sessionStorage, url + '#type=recovery&access_token=synthetic&refresh_token=synthetic');
    fake.callback('PASSWORD_RECOVERY', { user: { id: 'other-synthetic-user' } });
    await expect(recovery.initialize()).rejects.toThrow('RECOVERY_LINK_INVALID');
    expect(fake.updateUser).not.toHaveBeenCalled();
    recovery.dispose();
  });
  it('uses a separate tab-scoped client, preserves exact password, signs out, and refuses reuse', async () => {
    localStorage.setItem('admin-session', 'unchanged');
    const recovery = createPasswordRecovery(sessionStorage, url);
    expect(fake.createClient).toHaveBeenCalledOnce();
    expect(fake.createClient.mock.calls[0][2].auth).toEqual(expect.objectContaining({ storage: sessionStorage, storageKey: RECOVERY_AUTH_KEY, autoRefreshToken: false }));
    fake.callback('PASSWORD_RECOVERY', session);
    await recovery.initialize();
    expect(await recovery.update(' synthetic password ')).toEqual({ signedOut: true });
    expect(fake.updateUser).toHaveBeenCalledWith({ password: ' synthetic password ' });
    expect(fake.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(localStorage.getItem('admin-session')).toBe('unchanged');
    await expect(recovery.update('another synthetic password')).rejects.toThrow('RECOVERY_LINK_INVALID');
    expect(fake.updateUser).toHaveBeenCalledOnce();
    recovery.dispose(); expect(fake.unsubscribe).toHaveBeenCalledOnce();
  });
  it('rejects an ordinary login session without a recovery event', async () => {
    const recovery = createPasswordRecovery(sessionStorage, url);
    fake.callback('SIGNED_IN', session);
    await expect(recovery.initialize()).rejects.toThrow('RECOVERY_LINK_INVALID');
    await expect(recovery.update('synthetic password')).rejects.toThrow('RECOVERY_LINK_INVALID');
    expect(fake.updateUser).not.toHaveBeenCalled();
  });
  it('does not reuse an old owner when a new expired callback arrives', async () => {
    sessionStorage.setItem('inventory-recovery-owner-v1', session.user.id);
    sessionStorage.setItem(RECOVERY_AUTH_KEY, 'stale-synthetic-session');
    const recovery = createPasswordRecovery(sessionStorage, url + '#error_code=otp_expired');
    fake.callback('PASSWORD_RECOVERY', session);
    await expect(recovery.initialize()).rejects.toThrow('RECOVERY_LINK_INVALID');
    expect(sessionStorage.getItem(RECOVERY_AUTH_KEY)).toBeNull();
    expect(sessionStorage.getItem('inventory-recovery-owner-v1')).toBeNull();
    expect(fake.updateUser).not.toHaveBeenCalled();
    recovery.dispose();
  });
  it('rechecks ownership across server verification and blocks concurrent updates', async () => {
    const recovery = createPasswordRecovery(sessionStorage, url);
    fake.callback('PASSWORD_RECOVERY', session);
    await recovery.initialize();
    let resolve: (value: any) => void = () => {};
    fake.getUser.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const pending = recovery.update('synthetic password');
    await expect(recovery.update('synthetic password')).rejects.toThrow('RECOVERY_UPDATE_PENDING');
    fake.callback('SIGNED_OUT', null);
    resolve({ data: { user: session.user }, error: null });
    await expect(pending).rejects.toThrow('RECOVERY_LINK_INVALID');
    expect(fake.updateUser).not.toHaveBeenCalled();
  });
  it('reports cleanup failure without retrying a successful password change', async () => {
    const recovery = createPasswordRecovery(sessionStorage, url);
    fake.callback('PASSWORD_RECOVERY', session);
    fake.signOut.mockRejectedValueOnce(new Error('synthetic transport error'));
    expect(await recovery.update('synthetic password')).toEqual({ signedOut: false });
    await expect(recovery.update('synthetic password')).rejects.toThrow('RECOVERY_LINK_INVALID');
    expect(fake.updateUser).toHaveBeenCalledOnce();
  });
  it('never displays provider bodies or sensitive callback URLs', () => {
    const secret = 'https://example.com/#access_token=synthetic-secret';
    expect(passwordRecoveryMessage(new Error(secret))).not.toContain(secret);
    expect(passwordRecoveryMessage({ code: 'email_address_not_authorized' })).toContain('خدمة البريد غير مهيأة');
    expect(safeUserMessage({ code: 'invalid_credentials', message: secret }, 'user-management')).toBe('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
    expect(safeUserMessage(new Error(secret), 'user-management')).not.toContain('بيانات الدخول غير صحيحة');
    expect(passwordRecoveryUrl('https://mhzcis.github.io/environmental-health-inventory/#/settings')).toBe('https://mhzcis.github.io/environmental-health-inventory/reset-password.html');
  });
});

describe('Recovery forms', () => {
  it('checks confirmation and visibility, then clears credentials after success', async () => {
    const recovery = { initialize: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue({ signedOut: true }), dispose: vi.fn() };
    render(<PasswordRecovery recovery={recovery} />);
    const password = await screen.findByLabelText(/^كلمة المرور الجديدة/, { selector: 'input' }) as HTMLInputElement;
    const confirmation = screen.getByLabelText(/^تأكيد كلمة المرور/, { selector: 'input' }) as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'synthetic password' } });
    fireEvent.change(confirmation, { target: { value: 'different password' } });
    fireEvent.submit(password.closest('form')!);
    expect(recovery.update).not.toHaveBeenCalled();
    expect(screen.getByText('كلمتا المرور غير متطابقتين.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'إظهار كلمة المرور الجديدة' }));
    expect(password.type).toBe('text'); expect(confirmation.type).toBe('password');
    fireEvent.change(confirmation, { target: { value: 'synthetic password' } });
    fireEvent.submit(password.closest('form')!);
    await screen.findByText(/تم تغيير كلمة المرور وإنهاء جلسة الاستعادة/);
    expect(recovery.update).toHaveBeenCalledWith('synthetic password');
    expect(screen.queryByLabelText(/^كلمة المرور الجديدة/, { selector: 'input' })).toBeNull();
  });
  it('never presents a password form for an invalid link', async () => {
    render(<PasswordRecovery recovery={{ initialize: vi.fn().mockRejectedValue(new Error('RECOVERY_LINK_INVALID')), update: vi.fn(), dispose: vi.fn() }} />);
    await screen.findByText(/رابط الاستعادة غير صالح/);
    expect(screen.queryByLabelText(/^كلمة المرور الجديدة/, { selector: 'input' })).toBeNull();
  });
  it('normalizes the recovery address and reports acceptance without promising delivery', async () => {
    render(<Login onLoginSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /نسيت كلمة المرور/ }));
    const email = await screen.findByLabelText(/البريد الإلكتروني للحساب/, { selector: 'input' });
    fireEvent.change(email, { target: { value: 'Test@Example.com' } });
    fireEvent.submit(email.closest('form')!);
    await waitFor(() => expect(fake.sendReset).toHaveBeenCalledWith('test@example.com'));
    await screen.findByText(/تم قبول طلب الاستعادة/);
  });
  it('shows a mail configuration error instead of success when sending is rejected', async () => {
    fake.sendReset.mockRejectedValueOnce({ code: 'email_address_not_authorized' });
    render(<Login onLoginSuccess={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /نسيت كلمة المرور/ }));
    const email = await screen.findByLabelText(/البريد الإلكتروني للحساب/, { selector: 'input' });
    fireEvent.change(email, { target: { value: 'test@example.com' } });
    fireEvent.submit(email.closest('form')!);
    await screen.findByText(/خدمة البريد غير مهيأة/);
    expect(screen.queryByText(/تم قبول طلب الاستعادة/)).toBeNull();
  });
});
