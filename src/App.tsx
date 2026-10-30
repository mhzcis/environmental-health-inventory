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
import { Box, CircularProgress } from '@mui/material';
import {
  isSupabaseConfigured,
   subscribeAuthState,
  supabaseAuthSignOut,
} from './services/supabase';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authTerminating, setAuthTerminating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setLoggedIn(false);
      setAuthReady(true);
      return;
    }

    let isMounted = true;
    let authAttempt = 0;
    let unsubscribeProfileWatcher: (() => void) | null = null;

    const failClosed = async (message: string) => {
      if (!isMounted) return;
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

    const unsubscribeAuth = subscribeAuthState((user) => {
      if (!isMounted) return;
      const attempt = ++authAttempt;
      const isCurrentAttempt = () => isMounted && authAttempt === attempt;

      if (!user || !user.email) {
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
          if (!canonicalGate.success) {
            await failClosed(presentResultMessage(canonicalGate.message, 'user-management'));
            return;
          }

          const bootstrapRes = await dataService.bootstrapCurrentFirebaseUser();
          if (!isCurrentAttempt()) return;
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
          console.error('Supabase bootstrap failed', error);
          if (isCurrentAttempt()) {
            await failClosed('تعذر إكمال تهيئة الجلسة بأمان.');
          }
        }
      })();
    });

    return () => {
      isMounted = false;
      authAttempt += 1;
      if (unsubscribeProfileWatcher) unsubscribeProfileWatcher();
      stopCloudSync();
      unsubscribeAuth();
    };
  }, []);

  if (!authReady || authTerminating) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', bgcolor: '#f8fafc' }}>
        <CircularProgress size={60} thickness={4} sx={{ color: '#007ab7' }} />
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
