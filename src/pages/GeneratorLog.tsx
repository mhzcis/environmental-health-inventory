import { useState, useEffect, useMemo } from 'react';
import { safeUserMessage } from '../services/safeUserMessage';
import { 
  Typography, Container, Paper, Box, Button, Table, TableBody, TableCell, TableRow, TableHead,
  TableContainer, Chip, Alert, TextField, Dialog, DialogTitle, DialogContent, DialogActions,
  IconButton, Tooltip, Snackbar, Collapse
} from '@mui/material';
import { 
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, 
  CartesianGrid, Tooltip as ChartTooltip, Legend 
} from 'recharts';

import ElectricBoltIcon from '@mui/icons-material/ElectricBolt';
import AddIcon from '@mui/icons-material/Add';
import FilterListIcon from '@mui/icons-material/FilterList';
import RotateLeftIcon from '@mui/icons-material/RotateLeft';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import PrintIcon from '@mui/icons-material/Print';
import SpeedIcon from '@mui/icons-material/Speed';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import BarChartIcon from '@mui/icons-material/BarChart';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import FunctionsIcon from '@mui/icons-material/Functions';
import HistoryToggleOffIcon from '@mui/icons-material/HistoryToggleOff';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import LockIcon from '@mui/icons-material/Lock';

import { dataService } from '../services/dataService';
import { GeneratorLogEntry, GeneratorLogSimulationResult } from '../types';
import { exportToExcel } from '../utils/exportExcel';
import { exportToPDF } from '../utils/printHtml';

const ARABIC_DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function getArabicDayName(dateStr: string): string {
  if (!dateStr) return '';
  const dt = new Date(dateStr + 'T00:00:00');
  return ARABIC_DAYS[dt.getDay()] || '';
}

export default function GeneratorLog() {
  const [logs, setLogs] = useState<GeneratorLogEntry[]>([]);
  const [settings, setSettings] = useState(dataService.getSettings());
  const [searchQuery, setSearchQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Dialog State
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'add' | 'edit' | 'view'>('add');
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form State
  const [formDate, setFormDate] = useState('');
  const [formCurrentReading, setFormCurrentReading] = useState<string>('');
  const [formPreviousReading, setFormPreviousReading] = useState<string>('0');
  const [formNotes, setFormNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Future Date Warning Dialog
  const [futureDateWarningOpen, setFutureDateWarningOpen] = useState(false);

  // Simulation & Impact Review Dialog State
  const [simulationResult, setSimulationResult] = useState<GeneratorLogSimulationResult | null>(null);
  const [impactDialogOpen, setImpactDialogOpen] = useState(false);
  const [showImpactDetails, setShowImpactDetails] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Delete Confirmation Dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Snackbar Toast Notifications
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const loadData = () => {
    setLogs(dataService.getGeneratorLogs());
    setSettings(dataService.getSettings());
  };

  useEffect(() => {
    loadData();
    return dataService.subscribe(loadData);
  }, []);

  // 8 Stats Cards (Yearly stats card removed)
  const stats = useMemo(() => {
    const sortedLogs = [...logs].sort((a, b) => a.date.localeCompare(b.date));
    const count = sortedLogs.length;

    const totalHours = sortedLogs.reduce((sum, item) => sum + item.operatingHours, 0);

    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const monthHours = sortedLogs
      .filter((item) => item.date.startsWith(currentMonthStr))
      .reduce((sum, item) => sum + item.operatingHours, 0);

    const lastLog = sortedLogs.length > 0 ? sortedLogs[sortedLogs.length - 1] : null;
    const lastRunHours = lastLog ? lastLog.operatingHours : 0;
    const lastRecordedReading = lastLog ? lastLog.currentReading : 0;

    // Last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

    const logsLast30Days = sortedLogs.filter((item) => item.date >= thirtyDaysAgoStr);
    const maxHoursLast30Days = logsLast30Days.reduce((max, item) => Math.max(max, item.operatingHours), 0);
    const maxHoursAllTime = sortedLogs.reduce((max, item) => Math.max(max, item.operatingHours), 0);
    const avgHours = count > 0 ? Number((totalHours / count).toFixed(2)) : 0;

    return {
      totalHours: Number(totalHours.toFixed(2)),
      monthHours: Number(monthHours.toFixed(2)),
      lastRunHours,
      maxHoursLast30Days,
      maxHoursAllTime,
      avgHours,
      count,
      lastRecordedReading,
    };
  }, [logs]);

  // Daily Operating Hours Chart Data (Last 30 Days)
  const lineChartData = useMemo(() => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split('T')[0];

    return logs
      .filter((item) => item.date >= thirtyDaysAgoStr)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((item) => ({
        date: item.date,
        day: item.dayName,
        label: `${item.date} (${item.dayName})`,
        hours: item.operatingHours,
      }));
  }, [logs]);

  // Monthly Operating Hours Chart Data (Bar Chart)
  const barChartData = useMemo(() => {
    const monthlyMap: Record<string, number> = {};
    logs.forEach((item) => {
      const monthKey = item.date.substring(0, 7); // YYYY-MM
      monthlyMap[monthKey] = (monthlyMap[monthKey] || 0) + item.operatingHours;
    });

    return Object.keys(monthlyMap)
      .sort()
      .map((monthKey) => ({
        month: monthKey,
        hours: Number(monthlyMap[monthKey].toFixed(2)),
      }));
  }, [logs]);

  // Filtered Logs
  const filteredLogs = useMemo(() => {
    return logs
      .filter((item) => {
        if (fromDate && item.date < fromDate) return false;
        if (toDate && item.date > toDate) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchNotes = item.notes?.toLowerCase().includes(q);
          const matchUser = item.createdBy.toLowerCase().includes(q);
          const matchDate = item.date.includes(q);
          const matchDay = item.dayName.includes(q);
          if (!matchNotes && !matchUser && !matchDate && !matchDay) return false;
        }
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date)); // Table descending by date
  }, [logs, fromDate, toDate, searchQuery]);

  // Handle open add modal
  const handleOpenAdd = () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const latest = dataService.getLatestGeneratorLog();
    const prevReading = latest ? latest.currentReading : 0;

    setFormDate(todayStr);
    setFormPreviousReading(String(prevReading));
    setFormCurrentReading('');
    setFormNotes('');
    setFormError(null);
    setEditingId(null);
    setDialogMode('add');
    setDialogOpen(true);
  };

  // Handle open edit modal
  const handleOpenEdit = (entry: GeneratorLogEntry) => {
    setFormDate(entry.date);
    setFormPreviousReading(String(entry.previousReading));
    setFormCurrentReading(String(entry.currentReading));
    setFormNotes(entry.notes || '');
    setFormError(null);
    setEditingId(entry.id);
    setDialogMode('edit');
    setDialogOpen(true);
  };

  // Handle open view modal
  const handleOpenView = (entry: GeneratorLogEntry) => {
    setFormDate(entry.date);
    setFormPreviousReading(String(entry.previousReading));
    setFormCurrentReading(String(entry.currentReading));
    setFormNotes(entry.notes || '');
    setFormError(null);
    setEditingId(entry.id);
    setDialogMode('view');
    setDialogOpen(true);
  };

  // Calculate current operating hours in form
  const computedOperatingHours = useMemo(() => {
    const cur = parseFloat(formCurrentReading);
    const prev = parseFloat(formPreviousReading);
    if (isNaN(cur) || isNaN(prev)) return 0;
    const diff = cur - prev;
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [formCurrentReading, formPreviousReading]);

  // Date change handler in form
  const handleDateChange = (newDate: string) => {
    setFormDate(newDate);
    setFormError(null);
    // Automatic previous reading determination for existing log chain
    if (dialogMode === 'add' && logs.length > 0) {
      const sortedBefore = logs
        .filter((l) => l.date < newDate)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (sortedBefore.length > 0) {
        setFormPreviousReading(String(sortedBefore[sortedBefore.length - 1].currentReading));
      } else {
        const latest = dataService.getLatestGeneratorLog();
        setFormPreviousReading(String(latest ? latest.currentReading : 0));
      }
    }
  };

  // Process Save logic with simulation
  const initiateSave = async (ignoreFutureCheck = false) => {
    setFormError(null);
    if (!formDate) {
      setFormError('يرجى اختيار التاريخ بشكل صحيح.');
      return;
    }

    const cur = parseFloat(formCurrentReading);
    const prev = parseFloat(formPreviousReading);
    if (isNaN(cur)) {
      setFormError('يرجى إدخال القراءة الحالية بشكل صحيح.');
      return;
    }
    if (isNaN(prev)) {
      setFormError('يرجى إدخال القراءة السابقة بشكل صحيح.');
      return;
    }

    // Future date check
    const todayStr = new Date().toISOString().split('T')[0];
    if (formDate > todayStr && !ignoreFutureCheck) {
      setFutureDateWarningOpen(true);
      return;
    }

    try {
      // Simulate changes
      const sim = dataService.simulateSaveGeneratorLog({
        id: editingId || undefined,
        date: formDate,
        dayName: getArabicDayName(formDate),
        previousReading: prev,
        currentReading: cur,
        notes: formNotes.trim(),
      });

      if (sim.affectedCount > 1 || sim.actionType === 'add_old' || sim.actionType === 'edit_old') {
        setSimulationResult(sim);
        setShowImpactDetails(sim.affectedCount <= 5);
        setImpactDialogOpen(true);
      } else {
        // Direct commit if single current entry
        await dataService.commitGeneratorLogs(
          sim.proposedLogs,
          `تم تسجبل/تحديث قراءة المولد بتاريخ ${formDate} (${cur})`
        );
        setDialogOpen(false);
        setSnackbar({ open: true, message: 'تم حفظ السجل بنجاح', severity: 'success' });
      }
    } catch (err: any) {
      if (err.message === 'DUPLICATE_DATE_EXISTS') {
        setFormError(`يوجد سجل آخر محفوظ مسبقاً بنفس هذا التاريخ (${formDate}). يُسمح بسجل واحد فقط لكل يوم.`);
      } else if (err.message && err.message.startsWith('INVALID_SEQUENCE')) {
        const parts = err.message.split(':');
        setFormError(`خطأ في تسلسل العداد: القراءة الحالية (${parts[2] || cur}) أقل من القراءة السابقة (${parts[3] || prev}) بتاريخ ${parts[1] || formDate}. يمنع كسر التسلسل.`);
      } else {
        setFormError('حدث خطأ أثناء فحص وتسجيل القراءة: ' + safeUserMessage(err, 'generic', { allowAppText: true }));
      }
    }
  };

  // Commit Simulated Save
  const handleConfirmSimulationCommit = async () => {
    if (simulationResult) {
      await dataService.commitGeneratorLogs(
        simulationResult.proposedLogs,
        `اعتماد التعديل والمحاكاة لـ ${simulationResult.affectedCount} سجل متأثر`
      );
      setImpactDialogOpen(false);
      setSimulationResult(null);
      setDialogOpen(false);
      setPendingDeleteId(null);
      setSnackbar({ open: true, message: 'تمت مراجعة واعتماد الحسابات والتسلسل الزمني بنجاح', severity: 'success' });
    }
  };

  // Process Delete with simulation
  const initiateDelete = async (id: string) => {
    try {
      const sim = dataService.simulateDeleteGeneratorLog(id);
      setPendingDeleteId(id);
      setDeleteDialogOpen(false);

      if (sim.affectedCount > 1) {
        setSimulationResult(sim);
        setShowImpactDetails(sim.affectedCount <= 5);
        setImpactDialogOpen(true);
      } else {
        await dataService.deleteGeneratorLog(id);
        setSnackbar({ open: true, message: 'تم حذف السجل بنجاح', severity: 'success' });
      }
    } catch (err: any) {
      setSnackbar({ open: true, message: 'تعذر محاكاة حذف السجل: ' + safeUserMessage(err, 'generic', { allowAppText: true }), severity: 'error' });
    }
  };

  // Handle Excel Export
  const handleExportExcel = () => {
    try {
      const headers = ['التاريخ', 'اليوم', 'القراءة السابقة', 'القراءة الحالية', 'ساعات التشغيل', 'الملاحظات', 'المُدخل'];
      const rows = filteredLogs.map((item) => [
        item.date,
        item.dayName,
        String(item.previousReading),
        String(item.currentReading),
        String(item.operatingHours),
        item.notes || '-',
        item.createdBy,
      ]);

      exportToExcel({
        title: 'سجل تشغيل ومتابعة عداد المولد',
        organizationName: settings.organizationName,
        departmentName: settings.departmentName,
        filename: `generator_log_${new Date().toISOString().split('T')[0]}.xlsx`,
        metaFields: [
          { label: 'عدد السجلات المشمولة:', value: `${filteredLogs.length} سجل` },
          { label: 'إجمالي ساعات التشغيل المعروضة:', value: `${filteredLogs.reduce((s, i) => s + i.operatingHours, 0).toFixed(2)} ساعة` },
        ],
        headers,
        rows,
      });

      setSnackbar({ open: true, message: 'تم إنشاء تقرير Excel بنجاح', severity: 'success' });
    } catch (err: any) {
      setSnackbar({ open: true, message: 'فشل تصدير تقرير Excel: ' + safeUserMessage(err, 'export', { allowAppText: true }), severity: 'error' });
    }
  };

  // Handle PDF Export
  const handleExportPDF = async () => {
    try {
      const stampStr = new Date().toISOString().split('T')[0];
      const headers = ['التاريخ', 'اليوم', 'القراءة السابقة', 'القراءة الحالية', 'ساعات التشغيل', 'الملاحظات', 'المُدخل'];
      const rows = filteredLogs.map((item) => [
        item.date,
        item.dayName,
        String(item.previousReading),
        String(item.currentReading),
        `${item.operatingHours} ساعة`,
        item.notes || '-',
        item.createdBy,
      ]);

      await exportToPDF({
        title: 'سجل قراءات وساعات تشغيل المولد',
        organizationName: settings.organizationName || 'المستودع البلدي العام',
        departmentName: settings.departmentName || 'قسم الصيانه والمعاملات',
        filename: `تقرير_سجل_تشغيل_المولد_${stampStr}.pdf`,
        orientation: 'portrait',
        metaFields: [
          { label: 'تاريخ التقرير:', value: new Date().toLocaleDateString('ar-EG') },
          { label: 'إجمالي ساعات التشغيل التراكمية:', value: `${stats.totalHours} ساعة` },
          { label: 'عدد السجلات المشمولة:', value: `${filteredLogs.length} سجل` },
          { label: 'آخر قراءة مسجلة:', value: `${stats.lastRecordedReading}` },
        ],
        tables: [
          {
            headers,
            rows,
            recordIds: filteredLogs.map((item) => item.id),
            columnAlignments: ['center', 'center', 'center', 'center', 'center', 'right', 'center'],
          },
        ],
        signatures: [
          { role: settings.storekeeperRole || 'أمين المخزن', name: settings.storekeeperName || '', show: settings.showStorekeeperSignature !== false },
          { role: settings.systemManagerRole || 'مدير النظام', name: settings.systemManagerName || '', show: settings.showSystemManagerSignature !== false },
          { role: settings.healthDirectorRole || 'مدير صحة البيئة', name: settings.healthDirectorName || '', show: settings.showHealthDirectorSignature !== false }
        ]
      });

      setSnackbar({ open: true, message: 'تم تصدير تقرير PDF وتنزيل الملف بنجاح 📄', severity: 'success' });
    } catch (err: any) {
      setSnackbar({ open: true, message: 'فشل تصدير تقرير PDF: ' + safeUserMessage(err, 'export', { allowAppText: true }), severity: 'error' });
    }
  };

  return (
    <Container maxWidth="xl" sx={{ mt: 3, mb: 6, direction: 'rtl' }}>
      {/* Header Banner */}
      <Paper
        elevation={0}
        sx={{
          p: { xs: 2.5, sm: 3.5 },
          mb: 4,
          borderRadius: 3,
          background: 'linear-gradient(135deg, #0284c7 0%, #1e40af 100%)',
          color: 'white',
          boxShadow: '0 12px 24px -6px rgba(2, 132, 199, 0.35)',
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box
              sx={{
                width: 52,
                height: 52,
                borderRadius: 2.5,
                bgcolor: 'rgba(255, 255, 255, 0.25)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ElectricBoltIcon sx={{ fontSize: 32, color: '#fef08a' }} />
            </Box>
            <Box>
              <Typography variant="h4" sx={{ fontWeight: 800, fontFamily: 'Cairo, sans-serif', letterSpacing: '-0.02em', color: '#ffffff' }}>
                سجل تشغيل المولد
              </Typography>
              {/* Enhanced Subtitle Contrast */}
              <Typography 
                variant="body2" 
                sx={{ 
                  fontFamily: 'Cairo, sans-serif', 
                  mt: 0.5, 
                  color: '#ffffff',
                  fontWeight: 700,
                  textShadow: '0 1px 3px rgba(0, 0, 0, 0.5)',
                  fontSize: '0.95rem'
                }}
              >
                متابعة وتوثيق ساعات تشغيل المولد، العداد التراكمي وتحليلات التشغيل اليومية والشهرية
              </Typography>
            </Box>
          </Box>

          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={handleOpenAdd}
              sx={{
                bgcolor: '#facc15',
                color: '#0f172a',
                fontWeight: 700,
                px: 2.5,
                py: 1,
                borderRadius: 2,
                '&:hover': { bgcolor: '#eab308' },
                fontFamily: 'Cairo, sans-serif',
              }}
            >
              تسجيل قراءة جديدة
            </Button>
            <Button
              variant="outlined"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportExcel}
              sx={{
                color: 'white',
                borderColor: 'rgba(255,255,255,0.4)',
                fontWeight: 700,
                px: 2,
                borderRadius: 2,
                '&:hover': { borderColor: 'white', bgcolor: 'rgba(255,255,255,0.1)' },
                fontFamily: 'Cairo, sans-serif',
              }}
            >
              تصدير Excel
            </Button>
            <Button
              variant="outlined"
              startIcon={<PrintIcon />}
              onClick={handleExportPDF}
              sx={{
                color: 'white',
                borderColor: 'rgba(255,255,255,0.4)',
                fontWeight: 700,
                px: 2,
                borderRadius: 2,
                '&:hover': { borderColor: 'white', bgcolor: 'rgba(255,255,255,0.1)' },
                fontFamily: 'Cairo, sans-serif',
              }}
            >
              طباعة PDF
            </Button>
          </Box>
        </Box>
      </Paper>

      {/* Top Section: Exactly 8 Stats Cards (4 Top, 4 Bottom) */}
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 2, fontFamily: 'Cairo, sans-serif', color: 'text.primary', display: 'flex', alignItems: 'center', gap: 1 }}>
        <SpeedIcon color="primary" /> المؤشرات والإحصائيات التراكمية (8 مؤشرات)
      </Typography>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }, gap: 2.5, mb: 4 }}>
        {/* Card 1: Total Operating Hours */}
        <Paper elevation={0} sx={{ p: 2.5, borderRadius: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              إجمالي التشغيل (التراكمي)
            </Typography>
            <FunctionsIcon sx={{ color: '#0284c7' }} />
          </Box>
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#0284c7', fontFamily: 'Cairo, sans-serif' }}>
            {stats.totalHours} <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>ساعة</Typography>
          </Typography>
        </Paper>

        {/* Card 2: Current Month Hours */}
        <Paper elevation={0} sx={{ p: 2.5, borderRadius: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              تشغيل الشهر الحالي
            </Typography>
            <CalendarMonthIcon sx={{ color: '#059669' }} />
          </Box>
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#059669', fontFamily: 'Cairo, sans-serif' }}>
            {stats.monthHours} <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>ساعة</Typography>
          </Typography>
        </Paper>

        {/* Card 3: Hours of Last Run */}
        <Paper elevation={0} sx={{ p: 2.5, borderRadius: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              ساعات آخر تشغيل
            </Typography>
            <HistoryToggleOffIcon sx={{ color: '#d97706' }} />
          </Box>
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#d97706', fontFamily: 'Cairo, sans-serif' }}>
            {stats.lastRunHours} <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>ساعة</Typography>
          </Typography>
        </Paper>

        {/* Card 4: Max Hours Last 30 Days */}
        <Paper elevation={0} sx={{ p: 2.5, borderRadius: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              أعلى تشغيل (آخر 30 يوماً)
            </Typography>
            <ShowChartIcon sx={{ color: '#ea580c' }} />
          </Box>
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#ea580c', fontFamily: 'Cairo, sans-serif' }}>
            {stats.maxHoursLast30Days} <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>ساعة</Typography>
          </Typography>
        </Paper>

        {/* Card 5: Max Hours All-Time */}
        <Paper elevation={0} sx={{ p: 2.5, borderRadius: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              أعلى تشغيل (التراكمي)
            </Typography>
            <BarChartIcon sx={{ color: '#dc2626' }} />
          </Box>
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#dc2626', fontFamily: 'Cairo, sans-serif' }}>
            {stats.maxHoursAllTime} <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>ساعة</Typography>
          </Typography>
        </Paper>

        {/* Card 6: Average Hours */}
        <Paper elevation={0} sx={{ p: 2.5, borderRadius: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              متوسط ساعات التشغيل
            </Typography>
            <AccessTimeIcon sx={{ color: '#2563eb' }} />
          </Box>
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#2563eb', fontFamily: 'Cairo, sans-serif' }}>
            {stats.avgHours} <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>ساعة/سجل</Typography>
          </Typography>
        </Paper>

        {/* Card 7: Total Records Count */}
        <Paper elevation={0} sx={{ p: 2.5, borderRadius: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              عدد السجلات المسجلة
            </Typography>
            <FormatListNumberedIcon sx={{ color: '#0891b2' }} />
          </Box>
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#0891b2', fontFamily: 'Cairo, sans-serif' }}>
            {stats.count} <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>سجل</Typography>
          </Typography>
        </Paper>

        {/* Card 8: Last Recorded Reading */}
        <Paper elevation={0} sx={{ p: 2.5, borderRadius: 2.5, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              آخر قراءة مسجلة للعداد
            </Typography>
            <SpeedIcon sx={{ color: '#16a34a' }} />
          </Box>
          <Typography variant="h5" sx={{ fontWeight: 800, color: '#16a34a', fontFamily: 'Cairo, sans-serif' }}>
            {stats.lastRecordedReading}
          </Typography>
        </Paper>
      </Box>

      {/* Middle Section: 2 Charts */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' }, gap: 3, mb: 4 }}>
        {/* Chart 1: Line Chart (Daily Hours Last 30 Days) */}
        <Paper elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 2, fontFamily: 'Cairo, sans-serif', display: 'flex', alignItems: 'center', gap: 1 }}>
            <ShowChartIcon color="primary" /> ساعات التشغيل اليومية خلال آخر 30 يوماً (Line Chart)
          </Typography>
          <Box sx={{ width: '100%', height: 300, dir: 'ltr' }}>
            {lineChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={lineChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip formatter={(val: any) => [`${val} ساعة`, 'ساعات التشغيل']} labelFormatter={(lbl: any) => `التاريخ: ${lbl}`} />
                  <Legend formatter={() => 'ساعات التشغيل'} />
                  <Line type="monotone" dataKey="hours" stroke="#0284c7" strokeWidth={3} dot={{ r: 4, fill: '#0284c7' }} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'text.secondary' }}>
                <Typography variant="body2" sx={{ fontFamily: 'Cairo, sans-serif' }}>لا توجد سجلات تشغيل خلال آخر 30 يوماً</Typography>
              </Box>
            )}
          </Box>
        </Paper>

        {/* Chart 2: Bar Chart (Monthly Hours) */}
        <Paper elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 2, fontFamily: 'Cairo, sans-serif', display: 'flex', alignItems: 'center', gap: 1 }}>
            <BarChartIcon color="secondary" /> إجمالي ساعات التشغيل لكل شهر (Bar Chart)
          </Typography>
          <Box sx={{ width: '100%', height: 300, dir: 'ltr' }}>
            {barChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barChartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ChartTooltip formatter={(val: any) => [`${val} ساعة`, 'إجمالي الشهر']} labelFormatter={(lbl: any) => `الشهر: ${lbl}`} />
                  <Legend formatter={() => 'إجمالي ساعات الشهر'} />
                  <Bar dataKey="hours" fill="#059669" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'text.secondary' }}>
                <Typography variant="body2" sx={{ fontFamily: 'Cairo, sans-serif' }}>لا توجد بيانات سجلات مجمعة حسب الأشهر</Typography>
              </Box>
            )}
          </Box>
        </Paper>
      </Box>

      {/* Bottom Section: Data Table & Filters */}
      <Paper elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif', display: 'flex', alignItems: 'center', gap: 1 }}>
            <FilterListIcon color="primary" /> جدول سجلات تشغيل المولد
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            <TextField
              size="small"
              type="date"
              label="من تاريخ"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              sx={{ width: 160 }}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              size="small"
              type="date"
              label="إلى تاريخ"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              sx={{ width: 160 }}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              size="small"
              placeholder="بحث بالملاحظات أو المُدخل..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              sx={{ width: 220 }}
            />
            {(fromDate || toDate || searchQuery) && (
              <Button
                variant="outlined"
                size="small"
                startIcon={<RotateLeftIcon />}
                onClick={() => {
                  setFromDate('');
                  setToDate('');
                  setSearchQuery('');
                }}
                sx={{ fontFamily: 'Cairo, sans-serif' }}
              >
                إعادة ضبط
              </Button>
            )}
          </Box>
        </Box>

        <TableContainer>
          <Table sx={{ minWidth: 700 }}>
            <TableHead>
              <TableRow sx={{ bgcolor: 'action.hover' }}>
                <TableCell sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>التاريخ</TableCell>
                <TableCell sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>اليوم</TableCell>
                <TableCell align="center" sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>القراءة السابقة</TableCell>
                <TableCell align="center" sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>القراءة الحالية</TableCell>
                <TableCell align="center" sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>ساعات التشغيل</TableCell>
                <TableCell sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>الملاحظات</TableCell>
                <TableCell sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>المُدخل</TableCell>
                <TableCell align="center" sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>الإجراءات</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredLogs.length > 0 ? (
                filteredLogs.map((item) => (
                  <TableRow key={item.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{item.date}</TableCell>
                    <TableCell>
                      <Chip label={item.dayName} size="small" variant="outlined" sx={{ fontWeight: 600 }} />
                    </TableCell>
                    <TableCell align="center">{item.previousReading}</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 700, color: 'primary.main' }}>
                      {item.currentReading}
                    </TableCell>
                    <TableCell align="center">
                      <Chip
                        label={`${item.operatingHours} ساعة`}
                        size="small"
                        color="success"
                        sx={{ fontWeight: 700 }}
                      />
                    </TableCell>
                    <TableCell sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.notes || '-'}
                    </TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: '0.82rem' }}>
                      {item.createdBy}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title="عرض التفاصيل">
                        <IconButton size="small" color="info" onClick={() => handleOpenView(item)}>
                          <VisibilityIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="تعديل">
                        <IconButton size="small" color="primary" onClick={() => handleOpenEdit(item)}>
                          <EditIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="حذف">
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => {
                            setDeletingId(item.id);
                            setDeleteDialogOpen(true);
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    <Typography variant="body1" sx={{ fontFamily: 'Cairo, sans-serif' }}>
                      لا توجد سجلات تشغيل مضافة تتطابق مع شروط البحث والفلترة.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Add / Edit / View Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth dir="rtl">
        <DialogTitle sx={{ fontFamily: 'Cairo, sans-serif', fontWeight: 800, bgcolor: 'primary.main', color: 'white' }}>
          {dialogMode === 'add' && 'تسجيل قراءة مولد جديدة'}
          {dialogMode === 'edit' && 'تعديل سجل تشغيل المولد'}
          {dialogMode === 'view' && 'عرض تفاصيل سجل تشغيل المولد'}
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          {formError && (
            <Alert severity="error" sx={{ mb: 2.5, fontFamily: 'Cairo, sans-serif' }}>
              {formError}
            </Alert>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2.5, mt: 1 }}>
            <TextField
              fullWidth
              type="date"
              label="تاريخ التشغيل"
              value={formDate}
              disabled={dialogMode === 'view'}
              onChange={(e) => handleDateChange(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />

            {/* ReadOnly Day Field */}
            <TextField
              fullWidth
              label="اليوم (محسوب تلقائياً)"
              value={getArabicDayName(formDate)}
              disabled
              slotProps={{ input: { readOnly: true } }}
              sx={{ bgcolor: 'action.hover' }}
            />

            {/* Previous Reading: Editable ONLY if empty system on add mode, locked otherwise */}
            <TextField
              fullWidth
              type="number"
              label="القراءة السابقة للعداد"
              value={formPreviousReading}
              disabled={dialogMode === 'view' || (logs.length > 0 && dialogMode === 'add')}
              onChange={(e) => {
                setFormPreviousReading(e.target.value);
                setFormError(null);
              }}
              helperText={
                logs.length === 0 && dialogMode === 'add'
                  ? 'يمكنك إدخال القراءة السابقة يدوياً لأول سجل في النظام'
                  : 'محسوبة قفلاً من آخر سجل مسبق'
              }
              slotProps={{
                input: {
                  readOnly: dialogMode === 'view' || (logs.length > 0 && dialogMode === 'add'),
                  endAdornment: (logs.length > 0 || dialogMode !== 'add') ? (
                    <Tooltip title="قيمة محسوبة تلقائياً ومقفلة">
                      <LockIcon fontSize="small" color="action" />
                    </Tooltip>
                  ) : undefined,
                },
              }}
              sx={{ bgcolor: (logs.length > 0 || dialogMode !== 'add') ? 'action.hover' : 'background.paper' }}
            />

            <TextField
              fullWidth
              type="number"
              label="القراءة الحالية للعداد *"
              value={formCurrentReading}
              disabled={dialogMode === 'view'}
              onChange={(e) => {
                setFormCurrentReading(e.target.value);
                setFormError(null);
              }}
              autoFocus={dialogMode !== 'view'}
            />

            <Box sx={{ gridColumn: { xs: '1', sm: 'span 2' } }}>
              <Paper elevation={0} sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2, border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="body2" sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
                    عدد ساعات التشغيل المحسوبة تلقائياً:
                  </Typography>
                  <Chip
                    label={`${computedOperatingHours} ساعة`}
                    color={computedOperatingHours > 0 ? 'success' : 'default'}
                    sx={{ fontWeight: 800, fontSize: '1rem', px: 1 }}
                  />
                </Box>
              </Paper>
            </Box>

            <Box sx={{ gridColumn: { xs: '1', sm: 'span 2' } }}>
              <TextField
                fullWidth
                multiline
                rows={3}
                label="الملاحظات والتفاصيل التشغيلية"
                value={formNotes}
                disabled={dialogMode === 'view'}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="أدخل أي ملاحظات فنية أو ظروف تشغيل خاصة..."
              />
            </Box>
          </Box>
        </DialogContent>

        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={() => setDialogOpen(false)} sx={{ fontFamily: 'Cairo, sans-serif' }}>
            {dialogMode === 'view' ? 'إغلاق' : 'إلغاء'}
          </Button>
          {dialogMode !== 'view' && (
            <Button
              variant="contained"
              color="primary"
              onClick={() => initiateSave(false)}
              sx={{ fontFamily: 'Cairo, sans-serif', fontWeight: 700, px: 3 }}
            >
              حفظ السجل
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Future Date Warning Dialog */}
      <Dialog open={futureDateWarningOpen} onClose={() => setFutureDateWarningOpen(false)} dir="rtl" maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontFamily: 'Cairo, sans-serif', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1, color: 'warning.main' }}>
          <WarningAmberIcon color="warning" /> تنبيه: تاريخ مستقبلي
        </DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ fontFamily: 'Cairo, sans-serif', mt: 1 }}>
            التاريخ المحدد ({formDate}) يقع في المستقبل مقارنة بتاريخ اليوم. هل ترغب بالمتابعة وتأكيد الحفظ؟
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setFutureDateWarningOpen(false)} sx={{ fontFamily: 'Cairo, sans-serif' }}>
            إلغاء
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => {
              setFutureDateWarningOpen(false);
              initiateSave(true);
            }}
            sx={{ fontFamily: 'Cairo, sans-serif', fontWeight: 700 }}
          >
            متابعة
          </Button>
        </DialogActions>
      </Dialog>

      {/* Impact Simulation Review Dialog */}
      <Dialog open={impactDialogOpen} onClose={() => setImpactDialogOpen(false)} maxWidth="md" fullWidth dir="rtl">
        <DialogTitle sx={{ fontFamily: 'Cairo, sans-serif', fontWeight: 800, bgcolor: 'primary.dark', color: 'white', display: 'flex', alignItems: 'center', gap: 1 }}>
          <SpeedIcon /> نافذة مراجعة تأثير إعادة الحساب الزمني (Impact Review)
        </DialogTitle>
        <DialogContent sx={{ pt: 3 }}>
          <Alert severity="info" sx={{ mb: 2.5, fontFamily: 'Cairo, sans-serif' }}>
            التعديل الذي تود إجرائه يؤثر على التسلسل الزمني للعداد ويستدعي إعادة احتساب السجلات اللاحقة المترتبة زمنياً.
          </Alert>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2, mb: 3 }}>
            <Paper elevation={0} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
                عدد السجلات المتأثرة
              </Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, color: 'primary.main', fontFamily: 'Cairo, sans-serif' }}>
                {simulationResult?.affectedCount || 0} سجل
              </Typography>
            </Paper>

            <Paper elevation={0} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
                تاريخ آخر سجل متأثر
              </Typography>
              <Typography variant="h5" sx={{ fontWeight: 800, color: 'secondary.main', fontFamily: 'Cairo, sans-serif' }}>
                {simulationResult?.lastAffectedRecordDate || formDate}
              </Typography>
            </Paper>
          </Box>

          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, fontFamily: 'Cairo, sans-serif' }}>
              تفاصيل التغييرات على السلسلة الزمنية
            </Typography>
            <Button
              size="small"
              endIcon={showImpactDetails ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              onClick={() => setShowImpactDetails(!showImpactDetails)}
              sx={{ fontFamily: 'Cairo, sans-serif' }}
            >
              {showImpactDetails ? 'إخفاء التفاصيل' : 'عرض التفاصيل'}
            </Button>
          </Box>

          <Collapse in={showImpactDetails}>
            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 280, mb: 2 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>التاريخ</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>القراءة السابقة (السابقة ➔ الجديدة)</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>القراءة الحالية</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>ساعات التشغيل (السابقة ➔ الجديدة)</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {simulationResult?.impactedItems.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell sx={{ fontWeight: 700 }}>{item.date}</TableCell>
                      <TableCell>
                        {item.oldPreviousReading} ➔ <strong style={{ color: '#0284c7' }}>{item.newPreviousReading}</strong>
                      </TableCell>
                      <TableCell>{item.newCurrentReading}</TableCell>
                      <TableCell>
                        {item.oldOperatingHours} س ➔ <strong style={{ color: '#059669' }}>{item.newOperatingHours} س</strong>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Collapse>
        </DialogContent>

        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={() => setImpactDialogOpen(false)} sx={{ fontFamily: 'Cairo, sans-serif' }}>
            إلغاء
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={async () => {
              if (pendingDeleteId) {
                await dataService.deleteGeneratorLog(pendingDeleteId);
                setPendingDeleteId(null);
                setImpactDialogOpen(false);
                setSnackbar({ open: true, message: 'تم الحذف وإعادة احتساب السجلات بنجاح', severity: 'success' });
              } else {
                handleConfirmSimulationCommit();
              }
            }}
            sx={{ fontFamily: 'Cairo, sans-serif', fontWeight: 700, px: 3 }}
          >
            متابعة
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} dir="rtl">
        <DialogTitle sx={{ fontFamily: 'Cairo, sans-serif', fontWeight: 800 }}>
          تأكيد حذف سجل تشغيل المولد
        </DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ fontFamily: 'Cairo, sans-serif' }}>
            هل أنت تأكد من رغبتك في حذف هذا السجل نهائياً من النظام؟ سيعيد النظام احتساب السلسلة الزمنية والقراءات للسجلات اللاحقة المترتبة.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setDeleteDialogOpen(false)} sx={{ fontFamily: 'Cairo, sans-serif' }}>
            إلغاء
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => deletingId && initiateDelete(deletingId)}
            sx={{ fontFamily: 'Cairo, sans-serif', fontWeight: 700 }}
          >
            حذف السجل
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar Toast Notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={4000}
        onClose={() => setSnackbar({ ...snackbar, open: false })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={() => setSnackbar({ ...snackbar, open: false })}
          severity={snackbar.severity}
          variant="filled"
          sx={{ width: '100%', fontFamily: 'Cairo, sans-serif', fontWeight: 700 }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Container>
  );
}
