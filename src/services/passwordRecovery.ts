import { createClient } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabasePublicKey, supabaseUrl } from './supabaseConfig';

const OWNER_KEY = 'inventory-recovery-owner-v1';
export const RECOVERY_AUTH_KEY = 'inventory-recovery-auth-v1';

/** Separate tab-scoped client: recovery must never replace the inventory/admin session. */
export function createPasswordRecovery(storage: Storage = window.sessionStorage, href: string = window.location.href) {
  if (!isSupabaseConfigured()) throw new Error('RECOVERY_NOT_CONFIGURED');
  const callbackUrl = new URL(href);
  const fragment = new URLSearchParams(callbackUrl.hash.slice(1));
  const hasCallback = ['access_token', 'refresh_token', 'error', 'error_code', 'type'].some(key => fragment.has(key))
    || ['code', 'error', 'error_code'].some(key => callbackUrl.searchParams.has(key));
  const callbackError = ['error', 'error_code'].some(key => fragment.has(key) || callbackUrl.searchParams.has(key));
  const expectsRecovery = !callbackError && fragment.get('type') === 'recovery'
    && Boolean(fragment.get('access_token') && fragment.get('refresh_token'));
  // A new (including expired/invalid) link must not reuse an older recovery owner.
  if (hasCallback) {
    storage.removeItem(OWNER_KEY);
    storage.removeItem(RECOVERY_AUTH_KEY);
  }
  const client = createClient(supabaseUrl, supabasePublicKey, { auth: {
    storageKey: RECOVERY_AUTH_KEY, storage, persistSession: true,
    autoRefreshToken: false, detectSessionInUrl: true, flowType: 'implicit',
  } });
  let owner = storage.getItem(OWNER_KEY);
  let initialization: Promise<void> | null = null;
  let passwordChanged = false;
  let updating = false;
  let disposed = false;
  let notifyRecovery: () => void = () => {};
  const recoveryEvent = new Promise<void>(resolve => { notifyRecovery = resolve; });
  const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
    if (disposed) return;
    if (event === 'PASSWORD_RECOVERY' && session && (!hasCallback || expectsRecovery)) {
      owner = session.user.id;
      storage.setItem(OWNER_KEY, owner);
      notifyRecovery();
    } else if (!session || (owner && session.user.id !== owner)) {
      owner = null;
      storage.removeItem(OWNER_KEY);
    }
  });

  const verifyOwner = async (): Promise<string> => {
    const expected = owner;
    if (!expected || passwordChanged || disposed) throw new Error('RECOVERY_LINK_INVALID');
    const { data, error } = await client.auth.getUser();
    if (error || !data.user || data.user.id !== expected || owner !== expected || disposed) {
      throw new Error('RECOVERY_LINK_INVALID');
    }
    return expected;
  };

  return {
    initialize(): Promise<void> {
      initialization ??= (async () => {
        if (hasCallback && !expectsRecovery) throw new Error('RECOVERY_LINK_INVALID');
        const { data, error } = await client.auth.getSession();
        if (error || !data.session) throw new Error('RECOVERY_LINK_INVALID');
        // auth-js resolves getSession before its setTimeout-delivered PASSWORD_RECOVERY.
        // Wait for that event; INITIAL_SESSION alone must never authorize a reset.
        if (expectsRecovery && !owner) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([recoveryEvent, new Promise<void>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('RECOVERY_LINK_INVALID')), 10_000);
            })]);
          } finally { if (timeout !== undefined) clearTimeout(timeout); }
        }
        if (data.session.user.id !== owner) throw new Error('RECOVERY_LINK_INVALID');
        await verifyOwner();
      })();
      return initialization;
    },
    async update(password: string): Promise<{ signedOut: boolean }> {
      if (updating) throw new Error('RECOVERY_UPDATE_PENDING');
      if (password.length < 8 || password.length > 128) throw new Error('RECOVERY_PASSWORD_LENGTH');
      updating = true;
      try {
        const expected = await verifyOwner();
        if (owner !== expected) throw new Error('RECOVERY_LINK_INVALID');
        const { data, error } = await client.auth.updateUser({ password });
        if (error) throw error;
        // Never retry an already successful credential change if session cleanup fails.
        passwordChanged = true;
        owner = null;
        storage.removeItem(OWNER_KEY);
        try {
          const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
          return { signedOut: !signOutError && data.user?.id === expected };
        } catch { return { signedOut: false }; }
      } finally { updating = false; }
    },
    dispose() { disposed = true; notifyRecovery(); subscription.unsubscribe(); },
  };
}

/** Fixed text only: never expose tokens, URLs, addresses or provider response bodies. */
export function passwordRecoveryMessage(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  const message = error instanceof Error ? error.message : '';
  if (message === 'RECOVERY_LINK_INVALID' || code === 'otp_expired' || code === 'session_not_found') return 'رابط الاستعادة غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا.';
  if (message === 'RECOVERY_NOT_CONFIGURED') return 'خدمة استعادة كلمة المرور غير مهيأة. تواصل مع مدير النظام.';
  if (message === 'RECOVERY_PASSWORD_LENGTH' || code === 'weak_password') return 'يجب أن تتكون كلمة المرور من 8 إلى 128 حرفًا وأن تستوفي متطلبات الأمان.';
  if (code === 'same_password') return 'اختر كلمة مرور مختلفة عن كلمة المرور الحالية.';
  if (code === 'email_address_not_authorized') return 'خدمة البريد غير مهيأة للإرسال إلى هذا العنوان. تواصل مع مدير النظام.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') return 'تم تجاوز حد الطلبات مؤقتًا. انتظر قبل إعادة المحاولة.';
  return 'تعذر إكمال الطلب. تحقق من الاتصال وأعد المحاولة.';
}
