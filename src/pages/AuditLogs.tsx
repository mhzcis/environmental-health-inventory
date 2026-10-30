import { useState, useEffect } from 'react';
import { 
  Box, Typography, Paper, TextField, MenuItem, Table, TableBody, 
  TableCell, TableContainer, TableHead, TableRow, TablePagination, Grid, Chip,
  IconButton, Tooltip, Dialog, DialogTitle, DialogContent, Button
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import HistoryIcon from '@mui/icons-material/History';
import InfoIcon from '@mui/icons-material/Info';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import { dataService } from '../services/dataService';
import { AuditLog } from '../types';
import { renderOption } from '../utils/emoji';
import { getAuditAffectedEntities, normalizeAuditLog } from '../utils/auditPolicy';


export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(15);

  // Attachment Dialog State
  const [openAttachmentDialog, setOpenAttachmentDialog] = useState(false);
  const [viewingAttachment, setViewingAttachment] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      loadLogs();
    };
    load();
    return dataService.subscribe(load);
  }, []);

  const loadLogs = () => {
    setLogs(dataService.getAuditLogs().map(log => normalizeAuditLog(log)).filter((log): log is AuditLog => !!log));
  };

  const filteredLogs = logs.filter((log) => {
    const matchesSearch = 
      log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.details.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.user.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (log.actorUserId || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      getAuditAffectedEntities(log.primaryEntity ?? log.affectedEntities).some((entity) => entity.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesType = typeFilter === 'all' || log.itemType === typeFilter;

    return matchesSearch && matchesType;
  });

  const paginatedLogs = filteredLogs.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage
  );

  const getLogChipStyle = (type?: string) => {
    if (type === 'مادة') return { bg: '#e0f2fe', text: '#0369a1', label: 'المواد 📦' };
    if (type === 'مبيد') return { bg: '#fef3c7', text: '#d97706', label: 'المبيدات 🧪' };
    if (type === 'حركة') return { bg: '#dcfce7', text: '#166534', label: 'حركة مخزن 🔄' };
    if (type === 'إعدادات') return { bg: '#f1f5f9', text: '#475569', label: 'النظام ⚙️' };
    return { bg: '#f3e8ff', text: '#6b21a8', label: 'عام 👤' };
  };

  return (
    <Box sx={{ p: 1 }}>
      {/* Header */}
      <Box sx={{ mb: 4, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Box sx={{ p: 1.5, bgcolor: '#e0f2fe', borderRadius: '12px' }}>
          <HistoryIcon sx={{ color: '#0284c7', fontSize: '2rem' }} />
        </Box>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#1e293b' }}>
            سجل العمليات والتدقيق الأمني العام (Audit Trail)
          </Typography>
          <Typography variant="body2" sx={{ color: '#64748b', mt: 0.5 }}>
            تتبع ورصد كافة التحركات المخزنية الحيوية، تسجيل الإدخال وعمليات الحذف والتحويلات مع معلومات التوقيت الآمن وهوية المستخدم للمساءلة والشفافية الكاملة
          </Typography>
        </Box>
      </Box>

      {/* Toolbar filters */}
      <Paper sx={{ p: 2.5, mb: 3 }}>
        <Grid container spacing={2} sx={{ alignItems: 'center' }}>
          <Grid size={{ xs: 12, md: 5 }}>
            <TextField
              fullWidth
              placeholder="البحث بالإجراء، تفاصيل المشهد، هوية الموظف المسؤول..."
              size="small"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: <SearchIcon sx={{ color: '#94a3b8', mr: 1 }} />,
                  style: { borderRadius: '10px' }
                }
              }}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 4, md: 3 }}>
            <TextField
              select
              fullWidth
              size="small"
              label="تصفية نوع الحدث"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              slotProps={{ input: { style: { borderRadius: '10px' } } }}
            >
              <MenuItem value="all">{renderOption("كل الأحداث المسجلة")}</MenuItem>
              <MenuItem value="مادة">{renderOption("المواد واللوازم")}</MenuItem>
              <MenuItem value="مبيد">{renderOption("مستودع المبيدات")}</MenuItem>
              <MenuItem value="حركة">{renderOption("حركة مخازن وصرف")}</MenuItem>
              <MenuItem value="إعدادات">{renderOption("تهيئة وتحديث إعدادات")}</MenuItem>
            </TextField>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }} sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#64748b' }}>
              وجدت: {filteredLogs.length} سجل محاسبي مأمون
            </Typography>
          </Grid>
        </Grid>
      </Paper>

      {/* Logs Table */}
      <TableContainer component={Paper} sx={{ border: '1px solid #f1f5f9' }}>
        <Table sx={{ minWidth: 650 }}>
          <TableHead sx={{ bgcolor: '#f8fafc' }}>
            <TableRow>
              <TableCell sx={{ fontWeight: 'bold', width: '20%' }}>التوقيت المحلي والتاريخ</TableCell>
              <TableCell sx={{ fontWeight: 'bold', width: '15%' }}>الحدث والعملية</TableCell>
              <TableCell sx={{ fontWeight: 'bold', width: '15%' }}>قسم التصنيف</TableCell>
              <TableCell sx={{ fontWeight: 'bold', width: '30%' }}>التفاصيل والمبررات الفنية</TableCell>
              <TableCell sx={{ fontWeight: 'bold', width: '12%' }}>الموظف المسؤول</TableCell>
              <TableCell sx={{ fontWeight: 'bold', width: '8%' }} align="center">المستند المرفق</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {paginatedLogs.length > 0 ? (
              paginatedLogs.map((log, idx) => {
                const chipStyle = getLogChipStyle(log.itemType);
                return (
                  <TableRow key={`${log.id}-${idx}`} sx={{ '&:hover': { bgcolor: '#f8fafc' }, transition: 'all 0.1s ease' }}>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                      {new Date(log.timestamp).toLocaleString('ar-EG', { dateStyle: 'long', timeStyle: 'medium' })}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold', color: '#1e293b' }}>
                      {log.action}
                    </TableCell>
                    <TableCell>
                      <Chip 
                        label={chipStyle.label} 
                        size="small" 
                        sx={{ bgcolor: chipStyle.bg, color: chipStyle.text, fontWeight: 'bold', borderRadius: '8px' }} 
                      />
                    </TableCell>
                    <TableCell sx={{ fontSize: '0.88rem', color: '#475569', lineHeight: 1.5 }}>
                      {log.details}
                      {getAuditAffectedEntities(log.primaryEntity ?? log.affectedEntities).length > 0 && (
                        <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: '#64748b', fontFamily: 'monospace' }}>
                          {getAuditAffectedEntities(log.primaryEntity ?? log.affectedEntities).join('، ')}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'semibold', color: '#047857' }}>
                      👤 {log.user}
                      {log.actorUserId && (
                        <Typography variant="caption" sx={{ display: 'block', color: '#64748b', fontFamily: 'monospace' }}>
                          {log.actorUserId}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="center">
                      {log.attachment ? (
                        <Tooltip title="عرض كرت الاستلام / المستند المرفق بهذه العملية">
                          <IconButton 
                            size="small" 
                            sx={{ color: '#059669' }} 
                            onClick={() => {
                              setViewingAttachment(log.attachment || null);
                              setOpenAttachmentDialog(true);
                            }}
                          >
                            <AttachFileIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      ) : (
                        <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>---</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={6} align="center" sx={{ py: 6 }}>
                  <Box sx={{ color: '#94a3b8', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <InfoIcon sx={{ fontSize: '3rem', mb: 1 }} />
                    <Typography variant="body1" sx={{ color: '#64748b', fontStyle: 'italic' }}>
                      لم يعثر على أي حدث يدعم شروط الفرز الحالية بسجل التدقيق الرقمي.
                    </Typography>
                  </Box>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <TablePagination
          rowsPerPageOptions={[10, 15, 30]}
          component="div"
          count={filteredLogs.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(_, newPage) => setPage(newPage)}
          onRowsPerPageChange={(e) => {
            setRowsPerPage(parseInt(e.target.value, 10));
            setPage(0);
          }}
          labelRowsPerPage="صفوف الصفحة:"
          labelDisplayedRows={({ from, to, count }) => `${from}-${to} من ${count}`}
        />
      </TableContainer>

      {/* View Attachment Dialog */}
      <Dialog 
        open={openAttachmentDialog} 
        onClose={() => setOpenAttachmentDialog(false)}
        maxWidth="md"
        fullWidth
        id="audit-attachment-view-dialog"
      >
        <DialogTitle sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>معاينة مستند الحركة المرفق بالسجل</span>
          <IconButton onClick={() => setOpenAttachmentDialog(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {viewingAttachment ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <img 
                src={viewingAttachment} 
                alt="مستند الحركة المرفق بالسجل" 
                style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                referrerPolicy="no-referrer"
              />
              <Button 
                variant="outlined" 
                startIcon={<DownloadIcon />}
                onClick={() => {
                  const link = document.createElement('a');
                  link.href = viewingAttachment;
                  link.download = `attachment-${Date.now()}.jpg`;
                  link.click();
                }}
                sx={{ fontFamily: '"Cairo", sans-serif' }}
              >
                تحميل المستند المرفق
              </Button>
            </Box>
          ) : (
            <Typography sx={{ py: 3, textAlign: 'center', color: '#64748b' }}>
              لا يوجد مستند مرفق لهذه الحركة.
            </Typography>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
