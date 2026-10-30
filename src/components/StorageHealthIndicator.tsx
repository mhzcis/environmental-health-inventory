import React, { useEffect, useSyncExternalStore } from 'react';
import { dataService } from '../services/dataService';
import { getStorageHealth, refreshStorageHealth, subscribeStorageHealth } from '../services/storageHealth';

const refresh = (): void => {
  void refreshStorageHealth({
    storage: typeof navigator === 'undefined' ? undefined : navigator.storage,
    getOutstandingWork: () => dataService.getOutstandingSyncWorkCount(),
  });
};

/**
 * PREPROD-D narrow indicator. Read-only: it never deletes or "cleans" anything, and offers no destructive action.
 * No timers: it reads once on mount and again (throttled) when the tab becomes visible. Informational, not an Auth authority.
 */
export function StorageHealthIndicator(): React.ReactElement | null {
  const health = useSyncExternalStore(subscribeStorageHealth, getStorageHealth, getStorageHealth);

  useEffect(() => {
    refresh();
    const onVisible = (): void => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (health.state !== 'WARNING' && health.state !== 'CRITICAL') return null;
  const percent = health.usedPercent === null ? '' : ` (${health.usedPercent}%)`;
  const critical = health.state === 'CRITICAL';
  return (
    <div
      role={critical ? 'alert' : 'status'}
      data-testid="preprod-storage-health"
      data-storage-state={health.state}
      dir="rtl"
      style={{
        marginBottom: 16,
        padding: 12,
        borderRadius: 12,
        border: critical ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(245, 158, 11, 0.4)',
        background: critical ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)',
        fontFamily: '"Cairo", sans-serif',
      }}
    >
      <strong>{critical ? 'مساحة التخزين المحلي في المتصفح شبه ممتلئة' : 'مساحة التخزين المحلي في المتصفح تقترب من الامتلاء'}{percent}</strong>
      <div>
        {critical
          ? 'قد تفشل عمليات الحفظ قريباً. حرّر مساحة من خارج بيانات هذا التطبيق، ولا تمسح بيانات الموقع من المتصفح.'
          : 'حرّر مساحة من خارج بيانات هذا التطبيق عند الإمكان، ولا تمسح بيانات الموقع من المتصفح.'}
        {health.hasOutstandingWork ? ' توجد تغييرات لم تُزامَن بعد؛ مسح بيانات الموقع سيُفقدها.' : ''}
      </div>
    </div>
  );
}
