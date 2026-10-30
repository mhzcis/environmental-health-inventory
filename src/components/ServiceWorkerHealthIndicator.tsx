import React, { useSyncExternalStore } from 'react';
import {
  getServiceWorkerHealth,
  subscribeServiceWorkerHealth,
  type ServiceWorkerHealthState,
} from '../services/serviceWorkerHealth';

/** Fixed Arabic text (never derived from an error). Only non-healthy, actionable states are shown. */
const TEXT: Readonly<Partial<Record<ServiceWorkerHealthState, string>>> = {
  UNSUPPORTED: 'وضع التشغيل دون اتصال غير متاح في هذا المتصفح. يعمل التطبيق عبر الإنترنت، ولا يؤثر ذلك على تسجيل الدخول أو بياناتك المحفوظة.',
  FAILED: 'تعذر تفعيل وضع التشغيل دون اتصال. يعمل التطبيق عبر الإنترنت، ولا يؤثر ذلك على تسجيل الدخول أو بياناتك المحفوظة.',
  UPDATE_PENDING: 'يتوفر إصدار جديد من التطبيق وسيُفعَّل عند إعادة تحميل الصفحة. أنهِ عملك الحالي ثم أعد التحميل.',
};

/**
 * PREPROD-C narrow indicator. Informational only: it is not an authentication authority and never blocks or changes
 * any workflow. Renders nothing while REGISTERING or ACTIVE.
 */
export function ServiceWorkerHealthIndicator(): React.ReactElement | null {
  const { state } = useSyncExternalStore(subscribeServiceWorkerHealth, getServiceWorkerHealth, getServiceWorkerHealth);
  const text = TEXT[state];
  if (!text) return null;
  return (
    <div
      role="status"
      data-testid="preprod-sw-health"
      data-sw-state={state}
      dir="rtl"
      style={{ marginBottom: 16, padding: 12, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.5)', background: 'rgba(148, 163, 184, 0.1)', fontFamily: '"Cairo", sans-serif' }}
    >
      {text}
    </div>
  );
}
