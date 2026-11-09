import { useEffect, useState } from 'react';
import { Alert, Box, Button, Typography } from '@mui/material';
import { dataService } from '../services/dataService';
import { InventoryPendingError, inventoryRequestLabelAr, rejectedGroup, subscribeInventoryOutbox } from '../services/supabaseOutbox';
import { safeUserMessage } from '../services/safeUserMessage';

type Pending = Awaited<ReturnType<typeof dataService.listPendingInventoryMutations>>;
export default function InventorySyncPanel() {
  const [rows, setRows] = useState<Pending>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => { void dataService.listPendingInventoryMutations().then(next => { if (active) setRows(next); }).catch(() => { if (active) setError('تعذر قراءة الطلبات المحفوظة؛ لا تمسح بيانات الجهاز.'); }); };
    refresh(); const stop = subscribeInventoryOutbox(refresh);
    return () => { active = false; stop(); };
  }, []);
  const run = async (cancel: boolean) => {
    const group = rejectedGroup(rows);
    if (cancel && !window.confirm(`سيُتراجع محليًا عن الطلب المرفوض «${group[0] ? inventoryRequestLabelAr(group[0]) : ''}»${group.length > 1 ? ` و${group.length - 1} طلبًا يعتمد عليه` : ''}. الطلبات المستقلة لا تتأثر. هل توافق؟`)) return;
    setBusy(true); setError('');
    try {
      if (cancel) await dataService.cancelRejectedInventoryMutations();
      else await dataService.retryPendingInventoryMutations();
      const current = dataService.getCurrentUser();
      const boot = await dataService.bootstrapFreshDeviceData(current);
      if (!boot.success) setError(boot.message || 'تمت معالجة الطلبات لكن تعذر تحديث العرض؛ احتفظ ببيانات الجهاز.');
    } catch (e) {
      setError(e instanceof InventoryPendingError
        ? e.blocked
          ? 'رُفض الطلب أو تعارض مع بيانات الخادم. بقي محفوظًا على الجهاز للمراجعة؛ لم يُعتمد مركزيًا.'
          : 'لم يصل إقرار الخادم. بقي الطلب محفوظًا على الجهاز؛ أعد إرساله بعد استقرار الاتصال دون إعادة إدخاله.'
        : safeUserMessage(e, 'sync'));
    }
    finally { setBusy(false); }
  };
  if (!rows.length && !error) return null;
  return <Alert severity={rows.some(row => row.status !== 'pending') ? 'error' : 'warning'} sx={{ mb: 2 }}>
    <Typography variant="subtitle2">طلبات محفوظة على الجهاز: {rows.length} — تنتظر التأكيد المركزي</Typography>
    {rows.slice(0, 5).map(row => <Typography key={row.id} variant="body2" data-outbox-status={row.status} data-outbox-waiting={row.waitingOn ? 'yes' : 'no'}>{row.status === 'blocked' || row.status === 'conflict' ? 'مرفوض — يحتاج مراجعة' : row.status === 'quarantined' ? 'محفوظ للمراجعة' : row.waitingOn ? 'معلّق بسبب طلب مرفوض' : 'بانتظار الإرسال التلقائي'}: {row.transport === 'supabase-restore-v1' ? 'استعادة كاملة' : `${inventoryRequestLabelAr(row)} (${row.operations.length} سجلًا)` }. {row.lastError}</Typography>)}
    <Typography variant="caption">راجع هذه الطلبات قبل إعادة إدخالها. حالة «محفوظ على الجهاز» لا تعني اعتمادها في السحابة.</Typography>
    {error && <Typography role="status" variant="body2">{error}</Typography>}
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1 }}>
      <Button disabled={busy || !rows.length} onClick={() => void run(false)}>إعادة إرسال الطلبات المحفوظة</Button>
      {rows.some(row => row.status === 'blocked' || row.status === 'conflict') && <Button color="error" disabled={busy} onClick={() => void run(true)}>التراجع عن الطلب المرفوض وما يعتمد عليه</Button>}
    </Box>
  </Alert>;
}
