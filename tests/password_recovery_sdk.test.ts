// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createPasswordRecovery, RECOVERY_AUTH_KEY } from '../src/services/passwordRecovery';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', '/');
});

it('accepts an implicit recovery callback using the installed SDK event timing', async () => {
  const user = { id: 'synthetic-recovery-user', aud: 'authenticated', email: 'synthetic@example.invalid' };
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(user), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetch);
  localStorage.setItem('synthetic-admin-session', 'preserved');
  const fragment = new URLSearchParams({
    access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token',
    expires_in: '3600', token_type: 'bearer', type: 'recovery',
  });
  history.replaceState(null, '', `/reset-password.html#${fragment}`);
  const recovery = createPasswordRecovery();
  try {
    // Real SDK saves the session, resolves getSession, THEN emits PASSWORD_RECOVERY.
    await expect(recovery.initialize()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2); // URL identity and owner verified at server boundary.
    expect(sessionStorage.getItem(RECOVERY_AUTH_KEY)).toBeTruthy();
    expect(localStorage.getItem('synthetic-admin-session')).toBe('preserved');
    expect(location.hash).toBe('');
  } finally { recovery.dispose(); }
});
