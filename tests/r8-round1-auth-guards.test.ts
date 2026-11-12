// @vitest-environment jsdom
// R8 FIX ROUND 1 — R2-R8-06: every auth call site is guarded; a client without auth (or without getSession/getUser/
// onAuthStateChange) fails closed with no module-load TypeError and no unhandled rejection. R2-R8-09: refreshAuthSession.
import { afterEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ client: {} as any }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fake.client }));
vi.mock('../src/services/supabaseConfig', () => ({
  isSupabaseConfigured: () => true, supabaseUrl: 'https://synthetic.invalid', supabasePublicKey: 'synthetic-anon',
  passwordRecoveryUrl: (href: string) => href, applicationUrl: (href: string) => href,
}));
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);
afterEach(() => { vi.resetModules(); sessionStorage.clear(); });

describe('R1-R2-06 guarded auth call sites', () => {
  it.each([
    ['no auth object at all', {}],
    ['auth without getSession/getUser/onAuthStateChange', { auth: {} }],
    ['auth with a listener but without getSession/getUser', { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } }],
  ])('supabase module loads and password recovery fails closed: %s', async (_name, client) => {
    fake.client = client;
    const mod = await import('../src/services/supabase');
    expect(mod.getCurrentAuthUser()).toBeNull();
    await expect(mod.refreshAuthSession()).resolves.toBe(false);
    const { createPasswordRecovery } = await import('../src/services/passwordRecovery');
    const recovery = createPasswordRecovery(sessionStorage, 'https://synthetic.invalid/reset-password.html');
    await expect(recovery.initialize()).rejects.toThrow('RECOVERY_LINK_INVALID');
    recovery.dispose();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
  });
  it('refreshAuthSession delivers a refreshed session to auth subscribers (retry from the token-less offline state)', async () => {
    const session = { user: { id: 'u-refresh', email: 'r@example.invalid', created_at: '2026-11-01T00:00:00Z' } };
    const refreshSession = vi.fn(async () => ({ data: { session } }));
    fake.client = { auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), refreshSession } };
    const mod = await import('../src/services/supabase');
    const seen: any[] = []; mod.subscribeAuthState(user => seen.push(user));
    await expect(mod.refreshAuthSession()).resolves.toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.uid).toBe('u-refresh');
  });
  it('refreshAuthSession never throws when the SDK rejects', async () => {
    fake.client = { auth: { refreshSession: async () => { throw new Error('offline'); } } };
    const mod = await import('../src/services/supabase');
    await expect(mod.refreshAuthSession()).resolves.toBe(false);
  });
});
