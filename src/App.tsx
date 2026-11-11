import { useState, useEffect } from 'react';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import AppRouter from './app/Router';
import Login from './components/Login';
import { dataService, initCloudSync, stopCloudSync, watchCurrentFirebaseUserProfile } from './services/dataService';
import { ensureCanonicalCurrentUserProfile } from './services/legacyUserMigration';
import { StorehouseProvider } from './context/StorehouseContext';
import { presentResultMessage } from './services/safeUserMessage';
import { bindDiagnosticsSession, clearDiagnostics } from './services/operationalDiagnostics';
import { clearUnattributedRuntimeAlert } from './services/unattributedRuntimeAlert';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import {
  hasPersistedAuthSession,
  isSupabaseConfigured,
  refreshAuthSession,
  subscribeAuthState,
  supabaseAuthSignOut,
  type SupabaseAuthUser,
} from './services/supabase';
import { isAuthNetworkUnavailable, isBrowserOffline, isNetworkUnavailableMessage } from './services/authAvailability';
import { setInventoryOutboxSendGate } from './services/supabaseOutbox';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authTerminating, setAuthTerminating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  // R8-AUTH-01: the live profile check could not reach the server. The session, owned local data and the outbox are
  // kept; nothing is shown or sent until a live revalidation succeeds.
  const [onlineRequired, setOnlineRequired] = useState(false);
  const [retryOnline, setRetryOnline] = useState<(() => void) | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setLoggedIn(false);
      setAuthReady(true);
      return;
    }

    let isMounted = true;
    let authAttempt = 0;
    let unsubscribeProfileWatcher: (() => void) | null = null;
    let lastUser: SupabaseAuthUser | null = null;
    let waitingForNetwork = false;

    const requireOnline = () => {
      if (!isMounted) return;
      waitingForNetwork = true;
      setInventoryOutboxSendGate(false);
      if (unsubscribeProfileWatcher) {
        unsubscribeProfileWatcher();
        unsubscribeProfileWatcher = null;
      }
      stopCloudSync();
      // Deliberately NOT: sign-out, clearing the current-user marker, local business data or the outbox.
      setLoggedIn(false);
      setAuthError(null);
      setOnlineRequired(true);
      setAuthTerminating(false);
      setAuthReady(true);
    };
    // R8-R1 (R2-R8-09): with no delivered user (offline cold start), retry asks the SDK to refresh the persisted session;
    // a delivered session runs the normal live revalidation via subscribeAuthState(handleAuthUser).
    const retry = () => {
      if (!isMounted || !waitingForNetwork) return;
      if (lastUser) { handleAuthUser(lastUser); return; }
      void refreshAuthSession();
    };
    const onOnline = () => retry();
    window.addEventListener('online', onOnline);
    setRetryOnline(() => retry);

    const failClosed = async (message: string) => {
      if (!isMounted) return;
      waitingForNetwork = false;
      setOnlineRequired(false);
      setInventoryOutboxSendGate(false);
      clearDiagnostics();
      clearUnattributedRuntimeAlert();
      setAuthError(message);
      setLoggedIn(false);
      setAuthTerminating(true);
      if (unsubscribeProfileWatcher) {
        unsubscribeProfileWatcher();
        unsubscribeProfileWatcher = null;
      }
      stopCloudSync();
      try {
        sessionStorage.removeItem('remix_current_user_v1');
        localStorage.removeItem('remix_current_user_v1');
      } catch {
        // Ignore storage errors
      }
      await supabaseAuthSignOut().catch(() => {});
      if (isMounted) {
        setAuthTerminating(false);
        setAuthReady(true);
      }
    };

    const handleAuthUser = (user: SupabaseAuthUser | null) => {
      if (!isMounted) return;
      const attempt = ++authAttempt;
      const isCurrentAttempt = () => isMounted && authAttempt === attempt;
      setInventoryOutboxSendGate(false);

      if ((!user || !user.email) && isBrowserOffline() && hasPersistedAuthSession()) {
        // An offline start whose access token could not be refreshed: the persisted session is kept and the SDK
        // re-emits it after reconnect. Show the online-required state instead of a login form.
        lastUser = null;
        requireOnline();
        return;
      }

      if (!user || !user.email) {
        waitingForNetwork = false;
        setOnlineRequired(false);
        lastUser = null;
        bindDiagnosticsSession(null);
        clearUnattributedRuntimeAlert();
        if (unsubscribeProfileWatcher) {
          unsubscribeProfileWatcher();
          unsubscribeProfileWatcher = null;
        }
        stopCloudSync();
        try {
          sessionStorage.removeItem('remix_current_user_v1');
          localStorage.removeItem('remix_current_user_v1');
        } catch {
          // Ignore storage errors
        }
        setLoggedIn(false);
        setAuthTerminating(false);
        setAuthReady(true);
        return;
      }

      lastUser = user;
      waitingForNetwork = false;
      setOnlineRequired(false);
      dataService.beginFirebaseAuthSession(user.uid);
      setAuthTerminating(false);
      setAuthReady(false);
      setAuthError(null);

      void (async () => {
        try {
          if (unsubscribeProfileWatcher) {
            unsubscribeProfileWatcher();
            unsubscribeProfileWatcher = null;
          }
          stopCloudSync();

          const canonicalGate = await ensureCanonicalCurrentUserProfile(dataService.getUsers());
          if (!isCurrentAttempt()) return;
          if (!canonicalGate.success && canonicalGate.reason === 'unavailable') {
            requireOnline();
            return;
          }
          if (!canonicalGate.success) {
            await failClosed(presentResultMessage(canonicalGate.message, 'user-management'));
            return;
          }

          const bootstrapRes = await dataService.bootstrapCurrentFirebaseUser();
          if (!isCurrentAttempt()) return;
          if (!bootstrapRes.success && isNetworkUnavailableMessage(bootstrapRes.message)) {
            requireOnline();
            return;
          }
          if (!bootstrapRes.success || !bootstrapRes.user) {
            await failClosed(
              bootstrapRes.message
                ? presentResultMessage(bootstrapRes.message, 'sync')
                : 'تعذر التحقق من ملف المستخدم على الخادم.',
            );
            return;
          }

          const found = bootstrapRes.user;
          if (found.active === false || (found.authUid && found.authUid !== user.uid)) {
            await failClosed(
              found.active === false
                ? 'عذراً، هذا الحساب معطل (غير نشط). يرجى مراجعة مدير النظام.'
                : 'معرف الحساب السحابي غير متطابق. يرجى مراجعة مدير النظام.',
            );
            return;
          }

          const deviceBootstrap = await dataService.bootstrapFreshDeviceData(found);
          if (!isCurrentAttempt()) return;
          if (!deviceBootstrap.success && deviceBootstrap.status !== 'already-initialized') {
            await failClosed(deviceBootstrap.message || 'فشلت التهيئة التشغيلية الأولية.');
            return;
          }

          dataService.setCurrentUser(found.id);
          // Live revalidation passed for this exact account: queued work may be sent again.
          setInventoryOutboxSendGate(true);

          await dataService.logAudit(
            'تسجيل الدخول',
            `تم تسجيل دخول المستخدم: ${found.fullName}`,
            'إعدادات',
            {
              operationType: 'login',
              affectedEntities: [`users/${found.authUid || found.id}`],
              templateId: 'login',
            },
          ).catch(() => {});

          if (!isCurrentAttempt()) return;
          await initCloudSync();
          if (!isCurrentAttempt()) return;

          unsubscribeProfileWatcher = watchCurrentFirebaseUserProfile((message) => {
            void failClosed(message);
          });

          setLoggedIn(true);
          setAuthReady(true);
        } catch (error) {
          if (isCurrentAttempt() && isAuthNetworkUnavailable(error)) {
            requireOnline();
            return;
          }
          console.error('Supabase bootstrap failed', error);
          if (isCurrentAttempt()) {
            await failClosed('تعذر إكمال تهيئة الجلسة بأمان.');
          }
        }
      })();
    };
    const unsubscribeAuth = subscribeAuthState(handleAuthUser);

    return () => {
      isMounted = false;
      authAttempt += 1;
      window.removeEventListener('online', onOnline);
      if (unsubscribeProfileWatcher) unsubscribeProfileWatcher();
      stopCloudSync();
      unsubscribeAuth();
    };
  }, []);

  if (!authReady || authTerminating) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', bgcolor: '#f8fafc' }}>
        <CircularProgress size={60} thickness={4} sx={{ color: '#006da3' }} />
      </Box>
    );
  }

  if (onlineRequired) {
    return (
      <Box role="alert" data-testid="online-required" sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, p: 3, direction: 'rtl', textAlign: 'center', bgcolor: '#f8fafc' }}>
        <Typography variant="h6" sx={{ fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>يتطلب التشغيل اتصالاً بالخادم</Typography>
        <Typography sx={{ maxWidth: 520, fontFamily: '"Cairo", sans-serif' }}>
          تعذر التحقق المباشر من صلاحية حسابك لأن الخادم غير متاح الآن. جلستك وبيانات هذا الجهاز والطلبات المحفوظة في قائمة الانتظار باقية كما هي،
          ولن يُرسل أي طلب أو يُعرض أي بيانات قبل نجاح التحقق. ستتم إعادة المحاولة تلقائياً عند عودة الاتصال.
        </Typography>
        <Button variant="contained" onClick={() => retryOnline?.()}>إعادة المحاولة الآن</Button>
      </Box>
    );
  }

  return (
    <StorehouseProvider>
      {!loggedIn ? (
        <Box sx={{ position: 'relative', height: '100vh', display: 'flex', flexDirection: 'column' }}>
          {authError && (
            <Box sx={{ p: 2, bgcolor: '#fee2e2', color: '#991b1b', textAlign: 'center', fontWeight: 'bold', borderBottom: '1px solid #f87171' }}>
              {authError}
            </Box>
          )}
          <Box sx={{ flex: 1 }}>
            <Login onLoginSuccess={() => {
              window.location.hash = '#/';
            }} />
          </Box>
        </Box>
      ) : (
        <AppRouter />
      )}
    </StorehouseProvider>
  );
}
