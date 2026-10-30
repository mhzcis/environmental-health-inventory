import React, { useSyncExternalStore } from 'react';
import {
  acknowledgeOperationalAlert,
  getActiveOperationalAlert,
  getDiagnosticsSnapshot,
  subscribeDiagnostics,
  type DiagnosticCategory,
} from '../services/operationalDiagnostics';
import {
  clearUnattributedRuntimeAlert,
  getUnattributedRuntimeAlert,
  subscribeUnattributedRuntimeAlert,
} from '../services/unattributedRuntimeAlert';

/** Fixed Arabic titles per category; never derived from error text (rendered as plain React text). */
const TITLES: Readonly<Record<DiagnosticCategory, string>> = {
  NETWORK: 'الاتصال بالخدمة غير متاح مؤقتاً',
  QUOTA: 'تم بلوغ حد الاستخدام',
  AUTHENTICATION: 'تعذر التحقق من الجلسة',
  AUTHORIZATION: 'تم رفض الصلاحية',
  FIRESTORE_LISTENER: 'فشل تهيئة المزامنة السحابية',
  RENDER: 'تعذر عرض جزء من التطبيق',
  INTERNAL: 'حدث خطأ تشغيلي',
};

/** RW2-02: application-scoped notice; explicitly NOT attributed to the current session. */
export function UnattributedRuntimeAlertBanner(): React.ReactElement | null {
  const alert = useSyncExternalStore(subscribeUnattributedRuntimeAlert, getUnattributedRuntimeAlert, getUnattributedRuntimeAlert);
  if (!alert) return null;
  return (
    <div
      role="status"
      data-testid="p12-unattributed-alert"
      dir="rtl"
      style={{ marginBottom: 16, padding: 12, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.5)', background: 'rgba(148, 163, 184, 0.1)', fontFamily: '"Cairo", sans-serif' }}
    >
      <div>{alert.message}</div>
      <button type="button" onClick={() => clearUnattributedRuntimeAlert()} style={{ marginTop: 8 }}>
        إخفاء التنبيه
      </button>
    </div>
  );
}

/** P12 narrow health alert: shows the latest unacknowledged sanitized operational failure. */
export function OperationalAlertBanner(): React.ReactElement | null {
  useSyncExternalStore(subscribeDiagnostics, getDiagnosticsSnapshot, getDiagnosticsSnapshot);
  const alert = getActiveOperationalAlert();
  if (!alert) return <UnattributedRuntimeAlertBanner />;
  return (
    <>
    <UnattributedRuntimeAlertBanner />
    <div
      role="alert"
      data-testid="p12-operational-alert"
      dir="rtl"
      style={{ marginBottom: 16, padding: 12, borderRadius: 12, border: '1px solid rgba(239, 68, 68, 0.3)', background: 'rgba(239, 68, 68, 0.08)', fontFamily: '"Cairo", sans-serif' }}
    >
      <strong>{TITLES[alert.category] ?? TITLES.INTERNAL}</strong>
      <div>{alert.hint}</div>
      <button type="button" onClick={() => acknowledgeOperationalAlert(alert.seq)} style={{ marginTop: 8 }}>
        إخفاء التنبيه
      </button>
    </div>
    </>
  );
}

export default OperationalAlertBanner;
