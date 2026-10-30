import { requireStableStringPart } from '../utils/printHtml';
import { presentResultMessage } from '../services/safeUserMessage';
import { exportToPDF } from '../utils/printHtml';
import { Fragment, useState, useEffect, useMemo } from 'react';
import NotificationToast from '../components/NotificationToast';
import EmptyTableState from '../components/EmptyTableState';
import { 
  Box, Typography, Button, TextField, MenuItem, Paper, Table, TableBody, 
  TableCell, TableContainer, TableHead, TableRow, TablePagination, IconButton, Dialog, DialogTitle, DialogContent, DialogActions, 
  Tooltip, Chip, CircularProgress, Checkbox
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import FilterAltOffIcon from "@mui/icons-material/FilterAltOff";
import SearchIcon from '@mui/icons-material/Search';
import DeleteIcon from '@mui/icons-material/Delete';
import PrintIcon from '@mui/icons-material/Print';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CreateTransactionModal from '../components/CreateTransactionModal';

const getSupplierOrReceiverLabel = (txType: string) => {
  if (txType === 'وارد') return 'الجهة الموردة';
  if (txType === 'صادر') return 'الجهة المستلمة';
  if (txType === 'مستهلك') return 'جهة الاستهلاك / بيان السند';
  if (txType === 'افتتاحي') return 'الجهة الموردة / بيان الرصيد الافتتاحي';
  if (txType === 'تسوية') return 'بيان التسوية';
  if (txType === 'تحويل') return 'جهة التحويل';
  return 'الجهة المعنية بالعملية';
};

import { exportToExcel } from '../utils/exportExcel';
import { dataService } from '../services/dataService';
import { buildTransactionLedger, getHistoricalWarehouseStocksDetailed, TransactionViewRow } from '../utils/inventoryLogic';
import { useStorehouse } from '../context/StorehouseContext';


import { InventoryTransaction, Material } from '../types';
import { renderOption } from '../utils/emoji';


// Zod form validation for transaction

export default function Transactions() {
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [settings, setSettings] = useState(dataService.getSettings());

  // Filters State
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // وارد / صادر / مستهلك / all
  const [itemTypeFilter, setItemTypeFilter] = useState('all'); // Categories / all
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [smartDateRange, setSmartDateRange] = useState('all');
  const [attachmentFilter, setAttachmentFilter] = useState('all'); // all, hasAttachment, noAttachment
  const { selectedStorehouse } = useStorehouse();
  const [employeeFilter, setEmployeeFilter] = useState('all');

  const loadData = () => {
    setTransactions(dataService.getTransactions());
    setMaterials(dataService.getMaterials());
    setSettings(dataService.getSettings());
  };

  useEffect(() => {
    const load = () => {
      loadData();
    };
    load();
    return dataService.subscribe(load);
  }, []);




  const handleSmartDateChange = (range: string) => {
    setSmartDateRange(range);
    const todayStr = new Date().toISOString().split('T')[0];
    
    if (range === 'all') {
      setDateFrom('');
      setDateTo('');
    } else if (range === 'today') {
      setDateFrom(todayStr);
      setDateTo(todayStr);
    } else if (range === 'yesterday') {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      setDateFrom(yesterdayStr);
      setDateTo(yesterdayStr);
    } else if (range === 'last7') {
      const last7 = new Date();
      last7.setDate(last7.getDate() - 7);
      const last7Str = last7.toISOString().split('T')[0];
      setDateFrom(last7Str);
      setDateTo(todayStr);
    } else if (range === 'last30') {
      const last30 = new Date();
      last30.setDate(last30.getDate() - 30);
      const last30Str = last30.toISOString().split('T')[0];
      setDateFrom(last30Str);
      setDateTo(todayStr);
    } else if (range === 'currentMonth') {
      const now = new Date();
      const currentMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      setDateFrom(currentMonthStart);
      setDateTo(todayStr);
    }
  };

  const handleDateFromChange = (val: string) => {
    setDateFrom(val);
    setSmartDateRange('custom');
  };

  const handleDateToChange = (val: string) => {
    setDateTo(val);
    setSmartDateRange('custom');
  };

  // Table pagination
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  // Dialogs
  const [openAddDialog, setOpenAddDialog] = useState(false);
  const [openDeleteDialog, setOpenDeleteDialog] = useState(false);
  const [openBulkDeleteDialog, setOpenBulkDeleteDialog] = useState(false);
  const [transactionToDelete, setTransactionToDelete] = useState<TransactionViewRow | null>(null);
  const [openVoucherDialog, setOpenVoucherDialog] = useState(false);
  const [transactionToPrint, setTransactionToPrint] = useState<TransactionViewRow | null>(null);
  
  // Image attachments states
  const [openAttachmentDialog, setOpenAttachmentDialog] = useState(false);
  const [viewingAttachment, setViewingAttachment] = useState<string | null>(null);

  // Crop Dialog states
  
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exportingPDF, setExportingPDF] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<string[]>([]);

  const handleOpenAddDialog = () => { setOpenAddDialog(true); };

  const handleOpenDelete = (item: TransactionViewRow) => {
    setTransactionToDelete(item);
    setOpenDeleteDialog(true);
  };

  const [isDeletingTx, setIsDeletingTx] = useState(false);

  const confirmDelete = async () => {
    if (!transactionToDelete) return;
    if (!dataService.hasPermission('transactions_delete')) {
      setErrorMessage('لا تملك الصلاحية اللازمة لحذف الحركات المخزنية!');
      setOpenDeleteDialog(false);
      return;
    }
    
    setIsDeletingTx(true);
    await new Promise(resolve => setTimeout(resolve, 500)); // Simulate UI loading

    const res = await dataService.deleteTransaction(transactionToDelete.id);
    setIsDeletingTx(false);
    setOpenDeleteDialog(false);
    
    if (res.success) {
      setSuccessMessage(res.message);
      loadData();
      setTimeout(() => setSuccessMessage(null), 4000);
    } else {
      setErrorMessage(presentResultMessage(res.message));
      setTimeout(() => setErrorMessage(null), 6000);
    }
  };

  const handleOpenVoucher = (item: TransactionViewRow) => {
    setTransactionToPrint(item);
    setOpenVoucherDialog(true);
  };

  const handleBulkExportPDF = async () => {
    try {
      setExportingPDF(true);
      const selectedItems = ledgerTransactions.filter(t => selectedTransactionIds.includes(t.id));
      
      const titleHeader = 'كشف وسجل الحركات المخزنية المحددة جماعياً';
      const filename = `كشف_حركات_المواد_المحددة_${new Date().toISOString().split('T')[0]}.pdf`;
      const headers = ['رقم السند', 'تاريخ العمل', 'المستودع', 'اسم وصنف المادة', 'كود الصنف', 'نظام الحركة', 'الكمية', 'الرصيد قبل', 'الرصيد بعد', 'جهة التعامل / المورد / المستلم'];
      
      const rows = selectedItems.flatMap(t => {
        let badgeColor = { bg: '#e2e8f0', text: '#334155' };
        if (t.transactionType === 'افتتاحي') badgeColor = { bg: '#dcfce7', text: '#15803d' };
        else if (t.transactionType === 'وارد') badgeColor = { bg: '#e0f2fe', text: '#007ab7' };
        else if (t.transactionType === 'صادر') badgeColor = { bg: '#fee2e2', text: '#b91c1c' };
        else if (t.transactionType === 'مستهلك') badgeColor = { bg: '#fffbeb', text: '#b45309' };
        else if (t.transactionType === 'تحويل') badgeColor = { bg: '#f3e8ff', text: '#6b21a8' };
        else if (t.transactionType === 'تسوية') badgeColor = { bg: '#f1f5f9', text: '#475569' };
        
        const typeCell = `<span style="display: inline-block; padding: 2px 8px; background-color: ${badgeColor.bg}; color: ${badgeColor.text}; font-weight: bold; border-radius: 4px; font-size: 11px;">${t.transactionType || ''}</span>`;
        
        const parent = [
          t.transactionNumber || t.id,
          t.date || '',
          selectedStorehouse === 'all' ? 'جميع المستودعات (الإجمالي)' : (t.storehouse || ''),
          `${t.itemName} (${t.itemCategory || t.itemType || 'عام'})`,
          t.itemCode || '',
          typeCell,
          `${t.quantity} ${t.unit || 'وحدة'}`,
          String(t.displayStockBefore ?? t.stockBefore ?? 0),
          String(t.displayStockAfter ?? t.stockAfter ?? 0),
          t.supplierOrReceiver || ''
        ];
        if (selectedStorehouse !== 'all') return [parent];
        const details = settings.storehouses
          .filter((warehouse) => (t.displayWarehouseStockBefore?.[warehouse] || 0) !== 0 || (t.displayWarehouseStockAfter?.[warehouse] || 0) !== 0 || warehouse === t.storehouse)
          .map((warehouse) => [
            '', '', `↳ ${warehouse}`, `↳ تفصيل رصيد ${t.itemName}`, '', 'تفصيل',
            warehouse === t.storehouse ? `${t.quantity} ${t.unit || 'وحدة'}` : '—',
            String(t.displayWarehouseStockBefore?.[warehouse] ?? 0),
            String(t.displayWarehouseStockAfter?.[warehouse] ?? 0),
            ''
          ]);
        return [parent, ...details];
      });

      const alignments: ('right' | 'center' | 'left')[] = ['center', 'center', 'center', 'right', 'center', 'center', 'center', 'center', 'center', 'right'];


      const recordIds = selectedItems.flatMap((t: any) => {
        const txId = requireStableStringPart(t.id, 'txId');
        const parent = JSON.stringify(['bulk_transactions', txId, 'all_or_selected']);
        if (selectedStorehouse !== 'all') return [parent];
        const details = settings.storehouses
          .filter((warehouse) => (t.displayWarehouseStockBefore?.[warehouse] || 0) !== 0 || (t.displayWarehouseStockAfter?.[warehouse] || 0) !== 0 || warehouse === t.storehouse)
          .map((warehouse) => JSON.stringify(['bulk_transactions', txId, 'warehouse', requireStableStringPart(warehouse, 'warehouse')]));
        return [parent, ...details];
      });

      await exportToPDF({
        title: titleHeader,
        organizationName: settings.organizationName || 'المستودع البلدي العام',
        departmentName: settings.departmentName || 'قسم الصحة والبيئة ومكافحة الأوبئة',
        filename,
        orientation: 'landscape',
        metaFields: [
          { label: 'نوع التقرير:', value: 'تصدير أرشيف حركات مخزنية منتقاة جماعياً' },
          { label: 'إجمالي العمليات:', value: `${selectedItems.length} حركة مخزنية معتمدة` }
        ],
        tables: [
          {
            headers,
            rows,
            recordIds,
            columnAlignments: alignments
          }
        ],
        signatures: [
          { role: settings.storekeeperRole || 'أمين المخزن', name: settings.storekeeperName || '', show: settings.showStorekeeperSignature !== false },
          { role: settings.systemManagerRole || '', name: settings.systemManagerName || '', show: settings.showSystemManagerSignature !== false },
          { role: settings.healthDirectorRole || '', name: settings.healthDirectorName || '', show: settings.showHealthDirectorSignature !== false }
        ]
      });

      setSuccessMessage(`تم تصدير الحركات المحددة بنجاح إلى ملف PDF 📄`);
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch {

      setErrorMessage('حدث خطأ أثناء تصدير الحركات إلى PDF');
      setTimeout(() => setErrorMessage(null), 5000);
    } finally {
      setExportingPDF(false);
    }
  };

  const handleBulkExportExcel = async () => {
    try {
      setExportingExcel(true);
      const selectedItems = ledgerTransactions.filter(t => selectedTransactionIds.includes(t.id));
      
      const titleHeader = 'كشف وسجل الحركات المخزنية المحددة جماعياً';
      const filename = `كشف_حركات_المواد_المحددة_${new Date().toISOString().split('T')[0]}.xlsx`;
      const headers = ['رقم السند', 'تاريخ العمل', 'المستودع', 'اسم وصنف المادة', 'كود الصنف', 'نظام الحركة', 'الكمية', 'الرصيد قبل', 'الرصيد بعد', 'جهة التعامل / المورد / المستلم'];
      
      const rows = selectedItems.flatMap(t => {
        const parent = [
          t.transactionNumber || t.id,
          t.date || '',
          selectedStorehouse === 'all' ? 'جميع المستودعات (الإجمالي)' : (t.storehouse || ''),
          `${t.itemName} (${t.itemCategory || t.itemType || 'عام'})`,
          t.itemCode || '',
          t.transactionType || '',
          `${t.quantity} ${t.unit || 'وحدة'}`,
          t.supplierOrReceiver || ''
        ];
        if (selectedStorehouse !== 'all') return [parent];
        const details = settings.storehouses
          .filter((warehouse) => (t.displayWarehouseStockBefore?.[warehouse] || 0) !== 0 || (t.displayWarehouseStockAfter?.[warehouse] || 0) !== 0 || warehouse === t.storehouse)
          .map((warehouse) => [
            '', '', `↳ ${warehouse}`, `↳ تفصيل رصيد ${t.itemName}`, '', 'تفصيل',
            warehouse === t.storehouse ? `${t.quantity} ${t.unit || 'وحدة'}` : '—', ''
          ]);
        return [parent, ...details];
      });

      await exportToExcel({
        title: titleHeader,
        organizationName: settings.organizationName || 'المستودع البلدي العام',
        departmentName: settings.departmentName || 'قسم الصحة والبيئة ومكافحة الأوبئة',
        filename,
        metaFields: [
          { label: 'نوع التقرير:', value: 'تصدير أرشيف حركات مخزنية منتقاة جماعياً' },
          { label: 'إجمالي العمليات:', value: `${selectedItems.length} حركة مخزنية معتمدة` }
        ],
        headers,
        rows,
        signatures: [
          { role: settings.storekeeperRole || 'أمين المخزن', name: settings.storekeeperName || '', show: settings.showStorekeeperSignature !== false },
          { role: settings.systemManagerRole || '', name: settings.systemManagerName || '', show: settings.showSystemManagerSignature !== false },
          { role: settings.healthDirectorRole || '', name: settings.healthDirectorName || '', show: settings.showHealthDirectorSignature !== false }
        ]
      });

      setSuccessMessage(`تم تصدير الحركات المحددة بنجاح إلى ملف Excel 🟢`);
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch {

      setErrorMessage('حدث خطأ أثناء تصدير الحركات إلى Excel');
      setTimeout(() => setErrorMessage(null), 5000);
    } finally {
      setExportingExcel(false);
    }
  };

  const handleBulkDelete = () => {
    if (selectedTransactionIds.length === 0) {
      setErrorMessage('يرجى تحديد حركة مخزنية واحدة على الأقل لإجراء عملية الإلغاء والحذف');
      setTimeout(() => setErrorMessage(null), 5000);
      return;
    }
    setOpenBulkDeleteDialog(true);
  };

  const confirmBulkDeleteTransaction = async () => {
    setOpenBulkDeleteDialog(false);
    const result = await dataService.deleteTransactions(selectedTransactionIds);
    if (result.success) {
      const deletedIds = result.deletedIds || selectedTransactionIds;
      setSelectedTransactionIds(prev => prev.filter(id => !deletedIds.includes(id)));
      setSuccessMessage(result.message);
      loadData();
      setTimeout(() => setSuccessMessage(null), 5000);
    } else {
      setErrorMessage(presentResultMessage(result.message));
      setTimeout(() => setErrorMessage(null), 7000);
    }
  };

  const handlePrintVoucher = async () => {
    if (!transactionToPrint) return;
    try {
      setExportingPDF(true);
      const appSettings = dataService.getSettings();
      const item = transactionToPrint;
      const targetMaterial = materials.find(m => m.id === item.itemId);
      
      const voucherName = item.transactionType === 'وارد' ? 'سند توريد أصناف' : 
                          item.transactionType === 'صادر' ? 'سند صرف فوري' : 
                          item.transactionType === 'تحويل' ? 'سند تحويل مخزني' :
                          item.transactionType === 'تسوية' ? 'سند تسوية مخزنية' :
                          item.transactionType === 'افتتاحي' ? 'سند رصيد افتتاحي' :
                          'سند استهلاك معتمد';

      const filePrefix = item.transactionType === 'وارد' ? 'سند_توريد' : 
                         item.transactionType === 'صادر' ? 'سند_صرف' : 
                         item.transactionType === 'تحويل' ? 'سند_تحويل' :
                         item.transactionType === 'تسوية' ? 'سند_تسوية' :
                         item.transactionType === 'افتتاحي' ? 'سند_افتتاحي' :
                         'سند_استهلاك';

      const itemUnit = item.unit || 'وحدة';
      const storehouseName = item.storehouse;
      if (!storehouseName) throw new Error('WAREHOUSE_REFERENCE_REQUIRED_FOR_VOUCHER');
      const isAllStorehouses = selectedStorehouse === 'all' || storehouseName === 'جميع المستودعات';


      let balanceHeaders: string[] = [];
      let balanceRows: string[][] = [];
      let balanceAlignments: ('right' | 'center' | 'left')[] | undefined = undefined;
      let balanceRowBgColors: (string | null)[] | undefined = undefined;

      const txIdForIds = requireStableStringPart(item.id, 'txId');
      let recordIds1ForIds: string[] = [];

      if (isAllStorehouses) {
        const history = getHistoricalWarehouseStocksDetailed(
          transactions,
          item.itemId,
          item.id,
          targetMaterial,
          appSettings.storehouses
        );

        balanceHeaders = ['المستودع', 'الكمية قبل الحركة', 'الكمية بعد الحركة'];
        balanceAlignments = ['right', 'center', 'center'];

        const storehousesWithStock = Object.keys(history.before).filter(wh =>
          (history.before[wh] || 0) > 0 || (history.after[wh] || 0) > 0 || wh === storehouseName
        );

        const activeList = storehousesWithStock.length > 0 ? storehousesWithStock : appSettings.storehouses;
        if (activeList.length === 0) throw new Error('ACTIVE_WAREHOUSE_REQUIRED_FOR_VOUCHER');

        recordIds1ForIds = activeList.map(wh => JSON.stringify([
          'voucher_balance',
          txIdForIds,
          'warehouse',
          requireStableStringPart(wh, 'balanceWarehouse')
        ]));

        const warehouseBalanceRows = activeList.map(wh => [
          wh,
          `${history.before[wh] ?? 0} ${itemUnit}`,
          `${history.after[wh] ?? 0} ${itemUnit}`
        ]);
        balanceRows = [[
          'جميع المستودعات (الإجمالي)',
          `${item.displayStockBefore ?? history.totalBefore} ${itemUnit}`,
          `<span style="font-weight: bold; color: #0369a1">${item.displayStockAfter ?? history.totalAfter} ${itemUnit}</span>`
        ], ...warehouseBalanceRows];
        recordIds1ForIds = [
          JSON.stringify(['voucher_balance', txIdForIds, 'all_storehouses_total']),
          ...recordIds1ForIds,
        ];

        balanceRowBgColors = balanceRows.map((_, idx) => idx === 0 ? '#f1f5f9' : null);
      } else {
        const stableStorehouseForId = requireStableStringPart(storehouseName, 'voucherStorehouse');
        balanceHeaders = ['بيان الرصيد والكميات', 'مقدار الرصيد الدفتري والميداني'];
        balanceAlignments = ['right', 'center'];
        recordIds1ForIds = [
          JSON.stringify(['voucher_balance', txIdForIds, 'warehouse', stableStorehouseForId, 'before']),
          JSON.stringify(['voucher_balance', txIdForIds, 'warehouse', stableStorehouseForId, 'after'])
        ];
        balanceRows = [
          [
            `الرصيد الدفتري المتوفر بالمستودع (${storehouseName}) قبل الحركة`,
            `${item.stockBefore ?? item.displayStockBefore ?? 0} ${itemUnit}`
          ],
          [
            `الرصيد الميداني المتوفر حالياً بالمستودع (${storehouseName}) بعد الحركة`,
            `<span style="font-weight: bold; color: #0369a1">${item.stockAfter ?? item.displayStockAfter ?? 0} ${itemUnit}</span>`
          ]
        ];
      }




      await exportToPDF({
        title: voucherName,
        organizationName: appSettings.organizationName || 'المستودع البلدي العام',
        departmentName: `${appSettings.departmentName || 'قسم الصحة والبيئة ومكافحة الأوبئة'} - ${isAllStorehouses ? 'جميع المستودعات' : storehouseName}`,
        filename: `${filePrefix}_${item.transactionNumber || item.id.substring(0, 8)}.pdf`,
        orientation: 'portrait',
        metaFields: [
          { label: 'رقم السند المخزني:', value: item.transactionNumber || 'تلقائي' },
          { label: 'معرف النظام:', value: item.id },
          { label: 'تاريخ القيد:', value: item.date },
          { label: 'توقيت تسجيل الحركة:', value: item.createdAt ? new Date(item.createdAt).toLocaleString('ar-EG') : item.date },
          { label: 'المستودع (موقع التخزين):', value: storehouseName },
          { label: 'مُنفّذ الحركة المعتمد بالنظام:', value: item.executedBy || 'أمين المستودع الفني' },
          { label: getSupplierOrReceiverLabel(item.transactionType) + ':', value: item.supplierOrReceiver || '-' },
          { label: 'تصنيف الصنف الأساسي:', value: item.itemCategory || item.itemType || 'تصنيف عام' }
        ],
        tables: [
          {
            title: 'تفاصيل وجرد الصنف المحرّك مخزنياً:',
            headers: ['كود الصنف', 'الاسم الفني التجاري المعتمد', 'المستودع', 'التصنيف', 'الكمية المستندة', 'الوحدة'],
            rows: [
              [
                item.itemCode || '-',
                item.itemName || '-',
                storehouseName,
                item.itemCategory || item.itemType || 'تصنيف عام',
                `${item.quantity} ${itemUnit}`,
                itemUnit
              ]
            ],
            recordIds: [JSON.stringify(['voucher_detail', txIdForIds])],
            columnAlignments: ['center', 'center', 'center', 'center', 'center', 'center']
          },
          {
            title: 'ملخص الحركة والأرصدة الدفترية والميدانية للصنف:',
            headers: balanceHeaders,
            rows: balanceRows,
            recordIds: recordIds1ForIds,
            columnAlignments: balanceAlignments as any,
            rowBgColors: balanceRowBgColors
          }
        ],
        signatures: [
          { role: appSettings.storekeeperRole || 'أمين المخزن', name: appSettings.storekeeperName || '', show: appSettings.showStorekeeperSignature !== false },
          { role: appSettings.systemManagerRole || '', name: appSettings.systemManagerName || '', show: appSettings.showSystemManagerSignature !== false },
          { role: appSettings.healthDirectorRole || '', name: appSettings.healthDirectorName || '', show: appSettings.showHealthDirectorSignature !== false }
        ],
        notes: item.notes || 'سند رسمي معتمد وموقع إلكترونياً، لا يوجد ملاحظات إرشادية إضافية.',
        barcode: item.transactionNumber || item.id
      });
      setSuccessMessage('تم تصدير سند الحركة بنجاح كملف PDF.');
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {

      setErrorMessage('حدث خطأ أثناء تصدير السند كملف PDF.');
      setTimeout(() => setErrorMessage(null), 5000);
    } finally {
      setExportingPDF(false);
    }
  };

  // Live simulation helper displayed in form

  // Extract unique executing employees from current transactions
  const uniqueEmployees = useMemo(() => {
    const emps = transactions.map((t) => t.executedBy).filter(Boolean);
    return Array.from(new Set(emps));
  }, [transactions]);

  // Filters calculation
    // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [searchQuery, typeFilter, itemTypeFilter, dateFrom, dateTo, smartDateRange, attachmentFilter, employeeFilter, selectedStorehouse]);

  useEffect(() => {
    setSelectedTransactionIds([]);
  }, [selectedStorehouse]);

  const ledgerTransactions = buildTransactionLedger(transactions, selectedStorehouse, settings.storehouses, materials);
  
  const unfilteredFilteredTransactions = ledgerTransactions.filter((t) => {
    const matchesSearch = 
      t.itemName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.itemCode.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.supplierOrReceiver.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (t.notes && t.notes.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesType = typeFilter === 'all' || t.transactionType === typeFilter;
    const currentTxCategory = t.itemCategory || t.itemType || 'تصنيف عام';
    const matchesItemType = itemTypeFilter === 'all' || currentTxCategory === itemTypeFilter;

    let matchesDate = true;
    if (dateFrom) {
      matchesDate = matchesDate && t.date >= dateFrom;
    }
    if (dateTo) {
      matchesDate = matchesDate && t.date <= dateTo;
    }

    const matchesAttachment = 
      attachmentFilter === 'all' || 
      (attachmentFilter === 'hasAttachment' && !!t.attachment) || 
      (attachmentFilter === 'noAttachment' && !t.attachment);

    const matchesEmployee = 
      employeeFilter === 'all' || 
      t.executedBy === employeeFilter;
      
    const matchesStorehouse = true; // Central ledger already enforces exact warehouse scope.

    return matchesSearch && matchesType && matchesItemType && matchesDate && matchesAttachment && matchesEmployee && matchesStorehouse;
  });


  // Sort transactions descending: latest first (by date, then by createdAt or id)
  const filteredTransactions = [...unfilteredFilteredTransactions].sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    if (dateB !== dateA) return dateB - dateA;
    
    // If dates are identical, fallback to createdAt or ID
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (timeB !== timeA) return timeB - timeA;
    
    return b.id.localeCompare(a.id);
  });

  const paginatedTransactions = filteredTransactions.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage
  );

  return (
    <Box sx={{ p: 1 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#1e293b' }}>
            الحركات وإيصالات التدفق المخزني
          </Typography>
          <Typography variant="body2" sx={{ color: '#64748b', mt: 0.5 }}>
            تسجيل وإدارة عمليات التوريد والصرف والاستهلاك اليومي والسنوي مع تطبيق قيود التوازن المالي
          </Typography>
        </Box>
        {dataService.hasPermission('transactions_create') && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={handleOpenAddDialog}
            sx={{ 
              bgcolor: '#059669', 
              borderRadius: '12px', 
              px: 3, 
              py: 1.2,
              fontWeight: 'bold',
              boxShadow: '0 4px 12px rgba(5, 150, 105, 0.2)',
              '&:hover': { bgcolor: '#047857' }
            }}
          >
            تسجيل حركة مخزنية جديدة
          </Button>
        )}
      </Box>

      {/* Alert toast banners */}
      <NotificationToast open={!!successMessage} message={successMessage} severity="success" onClose={() => setSuccessMessage('')} />
      <NotificationToast open={!!errorMessage} message={errorMessage} severity="error" onClose={() => setErrorMessage('')} />

      {/* Filters Toolbar */}
      <Paper sx={{ p: 2.5, mb: 3 }}>
        <Box className="grid grid-cols-1 sm:grid-cols-12 md:grid-cols-12 gap-4 items-center">
          {/* Row 1 */}
          <Box className="col-span-1 sm:col-span-6 md:col-span-4">
            <TextField
              fullWidth
              placeholder="البحث بالصنف، الكود، المستلم/المورد..."
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
          </Box>
          <Box className="col-span-1 sm:col-span-6 md:col-span-4">
            <TextField
              select
              fullWidth
              size="small"
              label="الحركة"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كل الحركات")}</MenuItem>
              <MenuItem value="وارد">{renderOption("وارد")}</MenuItem>
              <MenuItem value="صادر">{renderOption("صادر")}</MenuItem>
              <MenuItem value="مستهلك">{renderOption("مستهلك")}</MenuItem>
              <MenuItem value="تحويل">{renderOption("تحويل")}</MenuItem>
              <MenuItem value="تسوية">{renderOption("تسوية")}</MenuItem>
              <MenuItem value="افتتاحي">{renderOption("افتتاحي")}</MenuItem>
            </TextField>
          </Box>
          <Box className="col-span-1 sm:col-span-12 md:col-span-4">
            <TextField
              select
              fullWidth
              size="small"
              label="تصفية بالتصنيف"
              value={itemTypeFilter}
              onChange={(e) => setItemTypeFilter(e.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كل التصنيفات")}</MenuItem>
              {settings.categories.map((c) => (
                <MenuItem key={c.name} value={c.name}>{renderOption(c.name, "category")}</MenuItem>
              ))}
            </TextField>
          </Box>

          {/* Row 2 */}
          <Box className="col-span-1 sm:col-span-6 md:col-span-3">
            <TextField
              select
              fullWidth
              size="small"
              label="النطاقات الزمنية الذكية"
              value={smartDateRange}
              onChange={(e) => handleSmartDateChange(e.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كل الأوقات")}</MenuItem>
              <MenuItem value="today">{renderOption("اليوم")}</MenuItem>
              <MenuItem value="yesterday">{renderOption("الأمس")}</MenuItem>
              <MenuItem value="last7">{renderOption("آخر 7 أيام")}</MenuItem>
              <MenuItem value="last30">{renderOption("آخر 30 يوم")}</MenuItem>
              <MenuItem value="currentMonth">{renderOption("الشهر الحالي")}</MenuItem>
              <MenuItem value="custom">{renderOption("نطاق مخصص")}</MenuItem>
            </TextField>
          </Box>
          <Box className="col-span-1 sm:col-span-3 md:col-span-2">
            <TextField
              fullWidth
              type="date"
              size="small"
              label="من تاريخ"
              slotProps={{ inputLabel: { shrink: true } }}
              value={dateFrom}
              onChange={(e) => handleDateFromChange(e.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            />
          </Box>
          <Box className="col-span-1 sm:col-span-3 md:col-span-2">
            <TextField
              fullWidth
              type="date"
              size="small"
              label="إلى تاريخ"
              slotProps={{ inputLabel: { shrink: true } }}
              value={dateTo}
              onChange={(e) => handleDateToChange(e.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            />
          </Box>
          <Box className="col-span-1 sm:col-span-6 md:col-span-2">
            <TextField
              select
              fullWidth
              size="small"
              label="حالة المرفقات"
              value={attachmentFilter}
              onChange={(e) => setAttachmentFilter(e.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كل المرفقات")}</MenuItem>
              <MenuItem value="hasAttachment">{renderOption("يحتوي مرفق")}</MenuItem>
              <MenuItem value="noAttachment">{renderOption("بلا مرفق")}</MenuItem>
            </TextField>
          </Box>
          <Box className="col-span-1 sm:col-span-6 md:col-span-3">
            <TextField
              select
              fullWidth
              size="small"
              label="الموظف المنفذ"
              value={employeeFilter}
              onChange={(e) => setEmployeeFilter(e.target.value)}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كل المنفذين")}</MenuItem>
              {uniqueEmployees.map((emp) => (
                <MenuItem key={emp} value={emp}>{renderOption(emp, "employee")}</MenuItem>
              ))}
            </TextField>
          </Box>
          <Box className="col-span-1 sm:col-span-12 md:col-span-3">
            <Box sx={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'space-between', 
              p: 0.8, 
              px: 1.5,
              bgcolor: '#f0f9ff', 
              border: '1px solid #bae6fd', 
              borderRadius: '10px',
              minHeight: '40px',
              width: '100%',
              boxSizing: 'border-box',
              gap: 1,
              overflow: 'hidden'
            }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#0369a1', fontFamily: '"Cairo", sans-serif', whiteSpace: 'nowrap', flexShrink: 0 }}>
                🏢 المستودع النشط:
              </Typography>
              <Chip
                label={selectedStorehouse === 'all' ? 'جميع المستودعات' : selectedStorehouse}
                size="small"
                sx={{ 
                  fontWeight: 'bold', 
                  fontFamily: '"Cairo", sans-serif', 
                  bgcolor: '#007ab7', 
                  color: '#ffffff', 
                  height: '26px',
                  maxWidth: 'calc(100% - 100px)',
                  '& .MuiChip-label': {
                    px: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }
                }}
              />
            </Box>
          </Box>


          {/* Results count indicator */}
          <Box className="col-span-1 md:col-span-12" sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1, borderTop: '1px solid #f1f5f9', pt: 1.5, direction: 'rtl' }}>
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#64748b', fontFamily: '"Cairo", sans-serif' }}>
              وجدت: {filteredTransactions.length} حركة مطابقة للتصفية الحالية
            </Typography>
            <Tooltip title="تفريغ كافة فلاتر البحث وإعادتها للافتراضي">
              <Button
                variant="outlined"
                color="secondary"
                onClick={() => {
                  setSearchQuery('');
                  setTypeFilter('all');
                  setItemTypeFilter('all');
                  handleSmartDateChange('all');
                  setAttachmentFilter('all');
                  setEmployeeFilter('all');
                }}
                startIcon={<FilterAltOffIcon sx={{ ml: 1, mr: -0.5 }} />}
                sx={{ borderRadius: '10px', px: 2, fontFamily: '"Cairo", sans-serif' }}
              >
                مسح الفلاتر
              </Button>
            </Tooltip>
          </Box>
        </Box>
      </Paper>

      {/* Bulk Operations Bar */}
      {selectedTransactionIds.length > 0 && (
        <Paper
          id="transactions-bulk-actions-bar"
          elevation={0}
          sx={{
            p: 2,
            mb: 2,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            bgcolor: '#eff6ff',
            border: '1px dashed #3b82f6',
            borderRadius: '12px'
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body1" sx={{ color: '#1e3a8a', fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>
              تم تحديد ({selectedTransactionIds.length}) من الحركات المخزنية
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <Button
              id="bulk-export-transactions-pdf"
              variant="contained"
              size="small"
              onClick={handleBulkExportPDF}
              disabled={exportingPDF}
              sx={{
                bgcolor: '#0f766e',
                color: 'white',
                '&:hover': { bgcolor: '#0d5f58' },
                fontWeight: 'bold',
                fontFamily: '"Cairo", sans-serif',
                borderRadius: '8px',
                px: 2,
                py: 0.8
              }}
            >
              {exportingPDF ? 'جاري التصدير...' : 'تصدير جماعي PDF 📄'}
            </Button>
            <Button
              id="bulk-export-transactions-excel"
              variant="contained"
              size="small"
              onClick={handleBulkExportExcel}
              disabled={exportingExcel}
              sx={{
                bgcolor: '#15803d',
                color: 'white',
                '&:hover': { bgcolor: '#166534' },
                fontWeight: 'bold',
                fontFamily: '"Cairo", sans-serif',
                borderRadius: '8px',
                px: 2,
                py: 0.8
              }}
            >
              {exportingExcel ? 'جاري التصدير...' : 'تصدير جماعي Excel 📊'}
            </Button>
            {dataService.hasPermission('transactions_delete') && (
              <Button
                id="bulk-delete-transactions"
                variant="contained"
                size="small"
                onClick={handleBulkDelete}
                disabled={selectedTransactionIds.length === 0}
                sx={{
                  bgcolor: '#b91c1c',
                  color: 'white',
                  '&:hover': { bgcolor: '#991b1b' },
                  '&:disabled': { bgcolor: '#ef4444', opacity: 0.5, color: '#f3f4f6' },
                  fontWeight: 'bold',
                  fontFamily: '"Cairo", sans-serif',
                  borderRadius: '8px',
                  px: 2,
                  py: 0.8
                }}
              >
                تراجع جماعي وحذف المعاملات 🗑️
              </Button>
            )}
          </Box>
        </Paper>
      )}

      {/* Transactions list table */}
      <TableContainer component={Paper} sx={{ border: '1px solid #f1f5f9' }}>
        <Table sx={{ minWidth: 650 }}>
          <TableHead>
            <TableRow sx={{ bgcolor: '#f8fafc' }}>
              <TableCell padding="checkbox">
                <Checkbox
                  id="select-all-transactions"
                  indeterminate={selectedTransactionIds.length > 0 && selectedTransactionIds.length < filteredTransactions.length}
                  checked={filteredTransactions.length > 0 && selectedTransactionIds.length === filteredTransactions.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedTransactionIds(filteredTransactions.map(t => t.id));
                    } else {
                      setSelectedTransactionIds([]);
                    }
                  }}
                />
              </TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>رقم السند/الحركة</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>التاريخ</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>المستودع</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>اسم الصنف وتصنيفه</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>كود الصنف</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold' }}>نوع الإجراء</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold' }}>الكمية</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold' }}>الرصيد قبل</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold' }}>الرصيد بعد</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>الجهة الموردة / المستلمة</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>المسؤول</TableCell>
              <TableCell align="center" sx={{  fontWeight: 'bold' ,  position: 'sticky', right: 0, zIndex: 2, bgcolor: 'inherit', boxShadow: '2px 0 5px -2px rgba(0,0,0,0.1)', borderLeft: '1px solid rgba(226, 232, 240, 1)'  }}>الإجراءات</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {paginatedTransactions.length > 0 ? (
              paginatedTransactions.map((tx, idx) => {
                let badgeColor = { bg: '#e2e8f0', text: '#334155' };
                if (tx.transactionType === 'افتتاحي') {
                  badgeColor = { bg: '#dcfce7', text: '#15803d' };
                } else if (tx.transactionType === 'وارد') {
                  badgeColor = { bg: '#e0f2fe', text: '#007ab7' };
                } else if (tx.transactionType === 'صادر') {
                  badgeColor = { bg: '#fee2e2', text: '#b91c1c' };
                } else if (tx.transactionType === 'مستهلك') {
                  badgeColor = { bg: '#fffbeb', text: '#b45309' };
                } else if (tx.transactionType === 'تحويل') {
                  badgeColor = { bg: '#f3e8ff', text: '#6b21a8' };
                } else if (tx.transactionType === 'تسوية') {
                  badgeColor = { bg: '#f1f5f9', text: '#475569' };
                }

                const isInbound = 
                  tx.transactionType === 'وارد' || 
                  tx.transactionType === 'افتتاحي' || 
                  (tx.transactionType === 'تحويل' && tx.transferType === 'in') || 
                  (tx.transactionType === 'تسوية' && (tx.transferType === 'in' || tx.quantity >= 0));

                return (
                  <Fragment key={`${tx.id}-${idx}`}>
                  <TableRow sx={{ bgcolor: '#ffffff', '&:hover': { bgcolor: '#f8fafc' } }}>
                    <TableCell padding="checkbox">
                      <Checkbox
                        id={`select-transaction-${tx.id}`}
                        checked={selectedTransactionIds.includes(tx.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedTransactionIds(prev => [...prev, tx.id]);
                          } else {
                            setSelectedTransactionIds(prev => prev.filter(id => id !== tx.id));
                          }
                        }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: '#007ab7' }}><span dir="ltr">{tx.transactionNumber || '---'}</span></TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{tx.date}</TableCell>
                    <TableCell sx={{ color: '#475569', fontSize: '0.85rem', fontWeight: selectedStorehouse === 'all' ? 'bold' : 'normal' }}>
                      {selectedStorehouse === 'all' ? 'جميع المستودعات (الإجمالي)' : (tx.storehouse || '')}
                    </TableCell>
                    <TableCell >
                      <Box>
                        <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#1e293b' }}>{tx.itemName}</Typography>
                        <Typography variant="caption" sx={{ color: '#0284c7', fontWeight: 600 }}>📦 {tx.itemCategory || tx.itemType || 'تصنيف عام'}</Typography>
                      </Box>
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: '#64748b' }}>{tx.itemCode}</TableCell>
                    <TableCell align="center">
                      <Box sx={{ px: 1.5, py: 0.5, borderRadius: '12px', bgcolor: badgeColor.bg, color: badgeColor.text, display: 'inline-block', fontSize: '11px', fontWeight: 'bold' }}>
                        {tx.transactionType}
                      </Box>
                    </TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold', color: isInbound ? '#15803d' : '#ef4444' }}>
                      <span dir="ltr">{isInbound ? '+' : '-'}{tx.quantity}</span> {tx.unit || 'وحدة'}
                    </TableCell>
                    <TableCell align="center" sx={{ color: '#64748b' }}>{tx.displayStockBefore}</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold', color: '#111827' }}>{tx.displayStockAfter}</TableCell>
                    <TableCell sx={{ fontSize: '0.82rem', color: '#475569' }}>{tx.supplierOrReceiver}</TableCell>
                    <TableCell sx={{ fontSize: '0.8rem', color: '#64748b' }}>{tx.executedBy}</TableCell>
                    <TableCell align="center" sx={{ position: 'sticky', right: 0, zIndex: 1, bgcolor: 'inherit', boxShadow: '2px 0 5px -2px rgba(0,0,0,0.1)', borderLeft: '1px solid #e2e8f0' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 1, minWidth: '160px' }}>
                        {/* Slot 1: Attachment (Width: 36px) */}
                        <Box sx={{ width: 36, display: 'flex', justifyContent: 'center' }}>
                          {tx.attachment ? (
                            <Tooltip title="عرض كرت الاستلام / مستند الحركة المرفق">
                              <IconButton 
                                size="small" 
                                sx={{ color: '#059669' }} 
                                onClick={() => {
                                  setViewingAttachment(tx.attachment || null);
                                  setOpenAttachmentDialog(true);
                                }}
                              >
                                <AttachFileIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          ) : null}
                        </Box>

                        {/* Slot 2: Print (Width: 36px) */}
                        <Box sx={{ width: 36, display: 'flex', justifyContent: 'center' }}>
                          <Tooltip title="معاينة وطباعة السند المخزني">
                            <IconButton size="small" sx={{ color: '#0284c7' }} onClick={() => handleOpenVoucher(tx)}>
                              <PrintIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Box>

                        {/* Slot 3: Delete / Archive (Width: 72px) */}
                        <Box sx={{ width: 72, display: 'flex', justifyContent: 'center' }}>
                          {dataService.hasPermission('transactions_delete') ? (
                            <Tooltip title="تراجع وإلغاء الحركة">
                              <IconButton size="small" color="error" onClick={() => handleOpenDelete(tx)}>
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          ) : (
                            <Chip label="مؤرشفة" size="small" sx={{ height: 20, fontSize: '9px', fontWeight: 'bold', bgcolor: '#f1f5f9', color: '#64748b' }} />
                          )}
                        </Box>
                      </Box>
                    </TableCell>
                  </TableRow>
                  {selectedStorehouse === 'all' && settings.storehouses
                    .filter((warehouse) => (tx.displayWarehouseStockBefore?.[warehouse] || 0) !== 0 || (tx.displayWarehouseStockAfter?.[warehouse] || 0) !== 0 || warehouse === tx.storehouse)
                    .map((warehouse) => (
                      <TableRow key={`${tx.id}-warehouse-${warehouse}`} sx={{ bgcolor: '#f8fafc' }}>
                        <TableCell padding="checkbox" />
                        <TableCell />
                        <TableCell />
                        <TableCell sx={{ color: '#0284c7', fontWeight: 'bold' }}>↳ {warehouse}</TableCell>
                        <TableCell sx={{ color: '#64748b' }}>↳ تفصيل رصيد {tx.itemName}</TableCell>
                        <TableCell />
                        <TableCell align="center"><Chip label="تفصيل" size="small" variant="outlined" /></TableCell>
                        <TableCell align="center" sx={{ color: warehouse === tx.storehouse ? (isInbound ? '#15803d' : '#ef4444') : '#94a3b8' }}>
                          {warehouse === tx.storehouse ? <><span dir="ltr">{isInbound ? '+' : '-'}{tx.quantity}</span> {tx.unit || 'وحدة'}</> : '—'}
                        </TableCell>
                        <TableCell align="center" sx={{ color: '#64748b' }}>{tx.displayWarehouseStockBefore?.[warehouse] ?? 0}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold' }}>{tx.displayWarehouseStockAfter?.[warehouse] ?? 0}</TableCell>
                        <TableCell colSpan={3} />
                      </TableRow>
                    ))}
                  </Fragment>
                );
              })
            ) : (
              <EmptyTableState colSpan={11} message="لا يوجد حركات مخزنية قياسية مسجلة تطابق التصفية الحالية." minHeight={150} />
            )}
          </TableBody>
        </Table>
        <TablePagination
          rowsPerPageOptions={[5, 10, 25]}
          component="div"
          count={filteredTransactions.length}
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

      
      <CreateTransactionModal
        open={openAddDialog}
        onClose={() => setOpenAddDialog(false)}
        onSuccess={(msg) => {
          setSuccessMessage(msg);
          loadData();
          setTimeout(() => setSuccessMessage(null), 4000);
        }}
        onError={(msg) => {
          setErrorMessage(msg);
          setTimeout(() => setErrorMessage(null), 6000);
        }}
        globalStorehouseScope={selectedStorehouse}
      />

      {/* Track movement rollback warning */}
      <Dialog 
        open={openDeleteDialog} 
        onClose={() => setOpenDeleteDialog(false)}
        slotProps={{ paper: { sx: { p: 1, direction: 'rtl' } } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#ef4444' }}>تحذير محاسبي هام</DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ mb: 2 }}>
            هل أنت متأكد تماماً من رغبتك في حذف وإلغاء الحركة المخزنية رقم: <strong>{transactionToDelete?.transactionNumber || transactionToDelete?.id}</strong> على صنف: <strong>{transactionToDelete?.itemName}</strong>؟
          </Typography>
          <Typography variant="body2" sx={{ color: '#b91c1c', bgcolor: '#fef2f2', p: 1.5, borderRadius: '8px', border: '1px solid #fee2e2' }}>
            تحذير: سيقوم النظام بإلغاء تأثير الكمية ({transactionToDelete?.quantity} {transactionToDelete?.unit || 'وحدة'}) من الرصيد التاريخي، وفي حال تسببت هذه الإزالة في حدوث رصيد سالب بالأصناف التابعة لاحقاً، فسيقوم النظام بمنع الإجراء حمايةً لقيد الموازنات.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 3, justifyContent: 'flex-start', gap: 2 }}>
          <Button 
            variant="contained" 
            color="error" 
            disabled={isDeletingTx}
            startIcon={isDeletingTx ? <CircularProgress size={20} color="inherit" /> : null}
            onClick={confirmDelete}
            sx={{ fontWeight: 'bold', borderRadius: '10px', px: 3 }}
          >
            {isDeletingTx ? 'جاري الحذف...' : 'نعم، احذف وألغ الحركة'}
          </Button>
          <Button 
            variant="outlined" 
            disabled={isDeletingTx}
            onClick={() => setOpenDeleteDialog(false)}
            sx={{ color: '#475569', borderColor: '#cbd5e1', borderRadius: '10px', px: 3 }}
          >
            تراجع وعودة
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <Dialog 
        open={openBulkDeleteDialog} 
        onClose={() => setOpenBulkDeleteDialog(false)}
        slotProps={{ paper: { sx: { p: 1, direction: 'rtl' } } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#ef4444' }}>تحذير إلغاء جماعي هام</DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ mb: 2 }}>
            هل أنت متأكد من التراجع عن وحذف <strong>{selectedTransactionIds.length}</strong> من الحركات المخزنية المحددة نهائياً؟
          </Typography>
          <Typography variant="body2" sx={{ color: '#b91c1c', bgcolor: '#fef2f2', p: 1.5, borderRadius: '8px', border: '1px solid #fee2e2' }}>
            تحذير: سيقوم النظام بإلغاء تأثير هذه الحركات من الرصيد التاريخي. وفي حال تسببت هذه الإزالة في حدوث رصيد سالب بالأصناف التابعة لاحقاً، فسيقوم النظام بمنع حذف هذه الحركات لضمان سلامة الدفاتر. لا يمكن التراجع عن هذه الخطوة نهائياً!
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 3, justifyContent: 'flex-start', gap: 2 }}>
          <Button 
            variant="contained" 
            color="error" 
            onClick={confirmBulkDeleteTransaction}
            sx={{ fontWeight: 'bold', borderRadius: '10px', px: 3 }}
          >
            تأكيد الإلغاء والحذف الجماعي
          </Button>
          <Button 
            variant="outlined" 
            onClick={() => setOpenBulkDeleteDialog(false)}
            sx={{ color: '#475569', borderColor: '#cbd5e1', borderRadius: '10px', px: 3 }}
          >
            إلغاء وعودة
          </Button>
        </DialogActions>
      </Dialog>

      {/* Voucher Print Preview Dialog */}
      <Dialog
        open={openVoucherDialog}
        onClose={() => setOpenVoucherDialog(false)}
        maxWidth="md"
        fullWidth
        slotProps={{ paper: { sx: { py: 1, direction: 'rtl' } } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>معاينة سند الحركة المخزنية المعتمد</span>
          <Chip 
            label={transactionToPrint?.transactionNumber || transactionToPrint?.id} 
            size="small" 
            sx={{ fontWeight: 'bold', fontFamily: 'monospace', bgcolor: '#f1f5f9' }} 
          />
        </DialogTitle>
        <DialogContent sx={{ pb: 1 }}>
          {transactionToPrint && (
            <Paper variant="outlined" sx={{ p: 4, bgcolor: '#fbfcfd', borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {/* Official header */}
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px double #cbd5e1', pb: 2 }}>
                <Box>
                  <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: '#334155' }}>{settings.organizationName}</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#0f172a' }}>{settings.departmentName}</Typography>
                </Box>
                <Box sx={{ textAlign: 'center' }}>
                  <Typography variant="h6" sx={{ fontWeight: '900', color: '#0f172a', border: '1px solid #94a3b8', px: 2, py: 0.5, borderRadius: '8px' }}>
                    {transactionToPrint.transactionType === 'وارد' ? 'سند توريد' : 
                     transactionToPrint.transactionType === 'صادر' ? 'سند صرف' : 
                     transactionToPrint.transactionType === 'تحويل' ? 'سند تحويل مخزني' :
                     transactionToPrint.transactionType === 'تسوية' ? 'سند تسوية مخزنية' :
                     transactionToPrint.transactionType === 'افتتاحي' ? 'سند رصيد افتتاحي' :
                     'سند استهلاك'}
                  </Typography>
                </Box>
                <Box sx={{ textAlign: 'end' }}>
                  <Typography variant="caption" sx={{ color: '#475569', display: 'block' }}>التوقيت: {transactionToPrint.createdAt ? new Date(transactionToPrint.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '-'}</Typography>
                  <Typography variant="caption" sx={{ color: '#475569', display: 'block' }}>التاريخ: {transactionToPrint.date}</Typography>
                  <Typography variant="caption" sx={{ color: '#475569', display: 'block' }}>رقم الحركة: {transactionToPrint.transactionNumber || 'تلقائي'}</Typography>
                  <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block' }}>معرف: {transactionToPrint.id.substring(0, 10)}</Typography>
                </Box>
              </Box>

              {/* General Voucher Info Grid */}
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
                <Box sx={{ p: 1.5, bgcolor: '#f8fafc', borderRadius: '8px' }}>
                  <Typography variant="caption" sx={{ color: '#64748b', fontWeight: 'bold', display: 'block' }}>
                    {getSupplierOrReceiverLabel(transactionToPrint.transactionType)}:
                  </Typography>
                  <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#1e293b', mt: 0.5 }}>
                    {transactionToPrint.supplierOrReceiver}
                  </Typography>
                </Box>
                <Box sx={{ p: 1.5, bgcolor: '#f8fafc', borderRadius: '8px' }}>
                  <Typography variant="caption" sx={{ color: '#64748b', fontWeight: 'bold', display: 'block' }}>مسجّل العملية في النظام:</Typography>
                  <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#1e293b', mt: 0.5 }}>
                    {transactionToPrint.executedBy}
                  </Typography>
                </Box>
              </Box>

              {/* Main table of item */}
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: '8px', overflow: 'hidden' }}>
                <Table>
                  <TableHead sx={{ bgcolor: '#f1f5f9' }}>
                    <TableRow>
                      <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>كود الصنف</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>الاسم الفني التجاري</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>المستودع</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>التصنيف</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>الكمية المستهدفة</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>الوحدة القياسية</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <TableRow>
                      <TableCell align="center" sx={{ fontFamily: 'monospace' }}>{transactionToPrint.itemCode}</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 'bold' }}>{transactionToPrint.itemName}</TableCell>
                      <TableCell align="center">{transactionToPrint.storehouse || 'المخزن الرئيسي'}</TableCell>
                      <TableCell align="center">📦 {transactionToPrint.itemCategory || transactionToPrint.itemType || 'تصنيف عام'}</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 'bold', color: (transactionToPrint.transactionType === 'وارد' || transactionToPrint.transactionType === 'افتتاحي' || (transactionToPrint.transactionType === 'تحويل' && transactionToPrint.transferType === 'in') || (transactionToPrint.transactionType === 'تسوية' && (transactionToPrint.transferType === 'in' || transactionToPrint.quantity >= 0))) ? '#16a34a' : '#ef4444', fontSize: '1.1rem' }}>
                        {(transactionToPrint.transactionType === 'وارد' || transactionToPrint.transactionType === 'افتتاحي' || (transactionToPrint.transactionType === 'تحويل' && transactionToPrint.transferType === 'in') || (transactionToPrint.transactionType === 'تسوية' && (transactionToPrint.transferType === 'in' || transactionToPrint.quantity >= 0))) ? '+' : '-'}{transactionToPrint.quantity}
                      </TableCell>
                      <TableCell align="center">
                        {transactionToPrint.unit || 'وحدة'}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </TableContainer>

              {/* Balances Audit Trail */}
              {(() => {
                const targetMat = materials.find(m => m.id === transactionToPrint.itemId);
                const storehouseName = transactionToPrint.storehouse || 'المخزن الرئيسي';
                const isAll = selectedStorehouse === 'all' || storehouseName === 'جميع المستودعات';

                if (!isAll) {
                  return (
                    <Box sx={{ p: 2, bgcolor: '#e0f2fe', border: '1px solid #bae6fd', borderRadius: '8px' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                        <Typography variant="body2" sx={{ color: '#0369a1', fontWeight: 'bold' }}>
                          تقرير المحاسبة والتوازن المخزني بمستودع ({storehouseName}):
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                          <Typography variant="body2" sx={{ color: '#475569' }}>
                            الرصيد الدفتري قبل الإجراء: <strong>{transactionToPrint.displayStockBefore ?? transactionToPrint.stockBefore} {transactionToPrint.unit || 'وحدة'}</strong>
                          </Typography>
                          <Typography variant="body2" sx={{ color: '#0369a1', fontWeight: 'bold' }}>
                            الرصيد الدفتري بعد الإجراء: <strong>{transactionToPrint.displayStockAfter ?? transactionToPrint.stockAfter} {transactionToPrint.unit || 'وحدة'}</strong>
                          </Typography>
                        </Box>
                      </Box>
                    </Box>
                  );
                }

                const history = getHistoricalWarehouseStocksDetailed(
                  transactions,
                  transactionToPrint.itemId,
                  transactionToPrint.id,
                  targetMat,
                  settings.storehouses
                );

                const storehousesWithStock = Object.keys(history.before).filter(wh =>
                  (history.before[wh] || 0) > 0 || (history.after[wh] || 0) > 0 || wh === storehouseName
                );
                const activeList = storehousesWithStock.length > 0 ? storehousesWithStock : (settings.storehouses.length > 0 ? settings.storehouses : ['المخزن الرئيسي']);

                return (
                  <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: '8px', overflow: 'hidden' }}>
                    <Box sx={{ p: 1.5, bgcolor: '#e0f2fe', borderBottom: '1px solid #bae6fd' }}>
                      <Typography variant="subtitle2" sx={{ color: '#0369a1', fontWeight: 'bold' }}>
                        أثر ودورة توازن الأرصدة التراكمية وتوزيع المستودعات:
                      </Typography>
                    </Box>
                    <Table size="small">
                      <TableHead sx={{ bgcolor: '#f1f5f9' }}>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 'bold', color: '#334155' }}>المستودع</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>الكمية قبل الحركة</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>الكمية بعد الحركة</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {activeList.map(wh => (
                          <TableRow key={wh}>
                            <TableCell sx={{ fontWeight: '500' }}>{wh}</TableCell>
                            <TableCell align="center">{history.before[wh] ?? 0} {transactionToPrint.unit || 'وحدة'}</TableCell>
                            <TableCell align="center">{history.after[wh] ?? 0} {transactionToPrint.unit || 'وحدة'}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow sx={{ bgcolor: '#e0f2fe' }}>
                          <TableCell sx={{ fontWeight: 'bold', color: '#0369a1' }}>جميع المستودعات (الإجمالي)</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', color: '#0369a1' }}>
                            {transactionToPrint.displayStockBefore ?? history.totalBefore} {transactionToPrint.unit || 'وحدة'}
                          </TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold', color: '#0369a1' }}>
                            {transactionToPrint.displayStockAfter ?? history.totalAfter} {transactionToPrint.unit || 'وحدة'}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </TableContainer>
                );
              })()}

              {/* Notes */}
              <Box>
                <Typography variant="caption" sx={{ color: '#64748b', fontWeight: 'bold', display: 'block', mb: 0.5 }}>المبررات وملاحظات الصرف والتشغيل المدونة:</Typography>
                <Typography variant="body2" sx={{ p: 2, bg: '#f8fafc', borderRadius: '8px', minHeight: '60px', color: '#1e293b' }}>
                  {transactionToPrint.notes || 'لا يوجد ملاحظات إدارية أو إرشادية مسجلة في هذا السند.'}
                </Typography>
              </Box>

              {/* Attachment Preview inside Voucher Dialog */}
              {(() => {
                const rawAttachment = transactionToPrint.attachment;
              let hasAttachment = rawAttachment;
              if (rawAttachment?.startsWith('opening_ref:')) {
                  const key = rawAttachment.replace('opening_ref:', '');
                  hasAttachment = settings.openingStockAttachments?.[key];
              }
                
                if (!hasAttachment) return null;
                
                return (
                  <Box>
                    <Typography variant="caption" sx={{ color: '#64748b', fontWeight: 'bold', display: 'block', mb: 0.5 }}>مستند الاستلام أو التسليم المرفق مخزنياً:</Typography>
                    <Box sx={{ p: 1, borderRadius: '8px', bgcolor: '#fff', display: 'flex', justifyContent: 'center' }}>
                      <img 
                        src={hasAttachment} 
                        alt="مستند استلام/تسليم مخزني أو سند الرصيد الافتتاحي" 
                        style={{ maxHeight: '200px', maxWidth: '100%', objectFit: 'contain', borderRadius: '4px' }}
                      />
                    </Box>
                  </Box>
                );
              })()}

              {/* Fake aesthetic barcode */}
              <Box sx={{ textAlign: 'center', pt: 1 }}>
                <Typography sx={{ fontFamily: 'monospace', letterSpacing: '4px', color: '#64748b', fontSize: '10px' }}>
                  ||||| | |||| || ||| | ||| |||| | | | {transactionToPrint.id}
                </Typography>
              </Box>
            </Paper>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 3, justifyContent: 'flex-start', gap: 2 }}>
          <Button
            variant="contained"
            color="primary"
            disabled={exportingPDF}
            onClick={handlePrintVoucher}
            sx={{ bgcolor: '#0284c7', px: 4, py: 1.1, fontWeight: 'bold', borderRadius: '10px', '&:hover': { bgcolor: '#0369a1' } }}
          >
            {exportingPDF ? 'جاري تصدير PDF...' : 'طباعة وإصدار المستند الآن 📠'}
          </Button>
          <Button
            variant="outlined"
            onClick={() => setOpenVoucherDialog(false)}
            sx={{ color: '#475569', borderColor: '#cbd5e1', px: 3, py: 1.1, fontWeight: 'bold', borderRadius: '10px' }}
          >
            إغلاق المعاينة
          </Button>
        </DialogActions>
      </Dialog>

      {/* Hidden Print Container for CSS Printer Output */}
      {transactionToPrint && (
        <Box id="printable-voucher" className="print-only">
          <Box sx={{ border: '2px solid #000', p: 4, borderRadius: '8px', bgcolor: '#fff', direction: 'rtl', fontFamily: '"Cairo", sans-serif' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '3px double #000', pb: 2, mb: 3 }}>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: '900', color: '#000' }}>{settings.organizationName}</Typography>
                <Typography variant="body2" sx={{ color: '#000', fontWeight: 'bold' }}>{settings.departmentName}</Typography>
                <Typography variant="body2" sx={{ color: '#000', fontWeight: 'bold', fontSize: '1.2rem', mt: 1 }}>
                  إدارة المستودعات والمخازن - {selectedStorehouse === 'all' || (transactionToPrint.storehouse || 'المخزن الرئيسي') === 'جميع المستودعات' ? 'جميع المستودعات' : (transactionToPrint.storehouse || 'المخزن الرئيسي')}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'center' }}>
                <Typography variant="h5" sx={{ fontWeight: '900', border: '3px solid #000', px: 3, py: 1, borderRadius: '8px', color: '#000' }}>
                  {transactionToPrint.transactionType === 'وارد' ? 'سند توريد' : 
                   transactionToPrint.transactionType === 'صادر' ? 'سند صرف' : 
                   transactionToPrint.transactionType === 'تحويل' ? 'سند تحويل مخزني' :
                   transactionToPrint.transactionType === 'تسوية' ? 'سند تسوية مخزنية' :
                   transactionToPrint.transactionType === 'افتتاحي' ? 'سند رصيد افتتاحي' :
                   'سند استهلاك'}
                </Typography>
                <Typography variant="caption" sx={{ color: '#000', fontWeight: 'bold', display: 'block', mt: 1, fontFamily: 'monospace' }}>
                  الرقم المرجعي للسند: {transactionToPrint.id}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'end' }}>
                <Typography sx={{ color: '#000', fontWeight: 'bold', fontSize: '13px' }}>تاريخ القيد: {transactionToPrint.date}</Typography>
                <Typography sx={{ color: '#000', fontWeight: 'bold', fontSize: '13px' }}>وقت التسجيل: {transactionToPrint.createdAt ? new Date(transactionToPrint.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '-'}</Typography>
                <Typography sx={{ color: '#000', fontWeight: 'bold', fontSize: '13px' }}>صفحة الطباعة: 1 من 1</Typography>
              </Box>
            </Box>

            <Box sx={{ mb: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', border: '2px solid #000', direction: 'rtl' }}>
                <tbody>
                  <tr>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', width: '25%', backgroundColor: '#f1f5f9' }}>نوع العُهدة والعملية:</td>
                    <td style={{ border: '1px solid #000', padding: '10px', width: '25%' }}>{transactionToPrint.transactionType}</td>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', width: '25%', backgroundColor: '#f1f5f9' }}>{getSupplierOrReceiverLabel(transactionToPrint.transactionType)}:</td>
                    <td style={{ border: '1px solid #000', padding: '10px', width: '25%' }}>{transactionToPrint.supplierOrReceiver}</td>
                  </tr>
                  <tr>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', backgroundColor: '#f1f5f9' }}>مُنفّذ الحركة المعتمد بالنظام:</td>
                    <td style={{ border: '1px solid #000', padding: '10px' }}>{transactionToPrint.executedBy}</td>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', backgroundColor: '#f1f5f9' }}>تصنيف الصنف:</td>
                    <td style={{ border: '1px solid #000', padding: '10px' }}>{transactionToPrint.itemCategory || transactionToPrint.itemType || 'تصنيف عام'}</td>
                  </tr>
                  <tr>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', backgroundColor: '#f1f5f9' }}>المستودع (موقع التخزين):</td>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold' }}>{transactionToPrint.storehouse || 'المخزن الرئيسي'}</td>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', backgroundColor: '#f1f5f9' }}>تاريخ القيد والتوقيت:</td>
                    <td style={{ border: '1px solid #000', padding: '10px' }}>{transactionToPrint.date} {transactionToPrint.createdAt ? new Date(transactionToPrint.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : ''}</td>
                  </tr>
                </tbody>
              </table>
            </Box>

            <Typography variant="subtitle2" sx={{ fontWeight: '900', color: '#000', mb: 1, textDecoration: 'underline' }}>تفاصيل وجرد الصنف المحرك مخزنياً:</Typography>
            <Box sx={{ mb: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', border: '2px solid #000', direction: 'rtl', textAlign: 'center' }}>
                <thead style={{ backgroundColor: '#f1f5f9' }}>
                  <tr>
                    <th style={{ border: '2px solid #000', padding: '10px', fontWeight: 'bold', textAlign: 'center' }}>كود الصنف</th>
                    <th style={{ border: '2px solid #000', padding: '10px', fontWeight: 'bold', textAlign: 'center' }}>الاسم الفني التجاري المعتمد</th>
                    <th style={{ border: '2px solid #000', padding: '10px', fontWeight: 'bold', textAlign: 'center' }}>موقع التخزين / المستودع</th>
                    <th style={{ border: '2px solid #000', padding: '10px', fontWeight: 'bold', textAlign: 'center' }}>الكمية المستندة</th>
                    <th style={{ border: '2px solid #000', padding: '10px', fontWeight: 'bold', textAlign: 'center' }}>الوحدة</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ border: '1px solid #000', padding: '10px', fontFamily: 'monospace', fontWeight: 'bold', textAlign: 'center' }}>{transactionToPrint.itemCode}</td>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', textAlign: 'center' }}>{transactionToPrint.itemName}</td>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', textAlign: 'center' }}>{transactionToPrint.storehouse || 'المخزن الرئيسي'}</td>
                    <td style={{ border: '1px solid #000', padding: '10px', fontWeight: 'bold', textAlign: 'center', color: (transactionToPrint.transactionType === 'وارد' || transactionToPrint.transactionType === 'افتتاحي' || (transactionToPrint.transactionType === 'تحويل' && transactionToPrint.transferType === 'in') || (transactionToPrint.transactionType === 'تسوية' && (transactionToPrint.transferType === 'in' || transactionToPrint.quantity >= 0))) ? '#15803d' : '#b91c1c' }}>{(transactionToPrint.transactionType === 'وارد' || transactionToPrint.transactionType === 'افتتاحي' || (transactionToPrint.transactionType === 'تحويل' && transactionToPrint.transferType === 'in') || (transactionToPrint.transactionType === 'تسوية' && (transactionToPrint.transferType === 'in' || transactionToPrint.quantity >= 0))) ? '+' : '-'}{transactionToPrint.quantity}</td>
                    <td style={{ border: '1px solid #000', padding: '10px', textAlign: 'center' }}>
                      {transactionToPrint.unit || 'وحدة'}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Box>

            <Typography variant="subtitle2" sx={{ fontWeight: '900', color: '#000', mb: 1, textDecoration: 'underline' }}>أثر ودورة توازن الأرصدة التراكمية وتوزيع المستودعات:</Typography>
            <Box sx={{ mb: 4 }}>
              {(() => {
                const targetMat = materials.find(m => m.id === transactionToPrint.itemId);
                const storehouseName = transactionToPrint.storehouse || 'المخزن الرئيسي';
                const isAll = selectedStorehouse === 'all' || storehouseName === 'جميع المستودعات';

                if (!isAll) {
                  return (
                    <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #000', direction: 'rtl', textAlign: 'center' }}>
                      <tbody>
                        <tr style={{ backgroundColor: '#fafafa' }}>
                          <td style={{ border: '1px solid #000', padding: '8px', fontWeight: 'bold', width: '50%' }}>
                            الرصيد الدفتري المتوفر بالمستودع ({storehouseName}) قبل الحركة:
                          </td>
                          <td style={{ border: '1px solid #000', padding: '8px', width: '50%' }}>
                            {transactionToPrint.displayStockBefore ?? transactionToPrint.stockBefore} {transactionToPrint.unit || 'وحدة'}
                          </td>
                        </tr>
                        <tr style={{ backgroundColor: '#f1fdf4' }}>
                          <td style={{ border: '1px solid #000', padding: '8px', fontWeight: 'bold', color: '#000' }}>
                            الرصيد الميداني المتوفر بالمستودع ({storehouseName}) بعد الحركة:
                          </td>
                          <td style={{ border: '1px solid #000', padding: '8px', fontWeight: 'bold', color: '#000' }}>
                            {transactionToPrint.displayStockAfter ?? transactionToPrint.stockAfter} {transactionToPrint.unit || 'وحدة'}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  );
                }

                const history = getHistoricalWarehouseStocksDetailed(
                  transactions,
                  transactionToPrint.itemId,
                  transactionToPrint.id,
                  targetMat,
                  settings.storehouses
                );

                const storehousesWithStock = Object.keys(history.before).filter(wh =>
                  (history.before[wh] || 0) > 0 || (history.after[wh] || 0) > 0 || wh === storehouseName
                );
                const activeList = storehousesWithStock.length > 0 ? storehousesWithStock : (settings.storehouses.length > 0 ? settings.storehouses : ['المخزن الرئيسي']);

                return (
                  <table style={{ width: '100%', borderCollapse: 'collapse', border: '2px solid #000', direction: 'rtl', textAlign: 'center' }}>
                    <thead style={{ backgroundColor: '#f1f5f9' }}>
                      <tr>
                        <th style={{ border: '1px solid #000', padding: '8px', fontWeight: 'bold' }}>المستودع</th>
                        <th style={{ border: '1px solid #000', padding: '8px', fontWeight: 'bold' }}>الكمية قبل الحركة</th>
                        <th style={{ border: '1px solid #000', padding: '8px', fontWeight: 'bold' }}>الكمية بعد الحركة</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeList.map(wh => (
                        <tr key={wh} style={{ backgroundColor: '#ffffff' }}>
                          <td style={{ border: '1px solid #000', padding: '8px', fontWeight: 'bold', color: '#334155' }}>
                            {wh}
                          </td>
                          <td style={{ border: '1px solid #000', padding: '8px' }}>
                            {history.before[wh] ?? 0} {transactionToPrint.unit || 'وحدة'}
                          </td>
                          <td style={{ border: '1px solid #000', padding: '8px' }}>
                            {history.after[wh] ?? 0} {transactionToPrint.unit || 'وحدة'}
                          </td>
                        </tr>
                      ))}
                      <tr style={{ backgroundColor: '#e0f2fe', fontWeight: 'bold' }}>
                        <td style={{ border: '1px solid #000', padding: '8px', color: '#0369a1' }}>
                          جميع المستودعات (الإجمالي)
                        </td>
                        <td style={{ border: '1px solid #000', padding: '8px', color: '#0369a1' }}>
                          {transactionToPrint.displayStockBefore ?? history.totalBefore} {transactionToPrint.unit || 'وحدة'}
                        </td>
                        <td style={{ border: '1px solid #000', padding: '8px', color: '#0369a1' }}>
                          {transactionToPrint.displayStockAfter ?? history.totalAfter} {transactionToPrint.unit || 'وحدة'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                );
              })()}
            </Box>

            <Box sx={{ mb: 5 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#000', mb: 1 }}>ملاحظات وتوجيهات عملية الصرف أو التوريد المعتمدة:</Typography>
              <Box style={{ border: '1px solid #000', padding: '12px', minHeight: '80px', borderRadius: '4px' }}>
                <Typography variant="body2" sx={{ color: '#000' }}>
                  {transactionToPrint.notes || 'سند رسمي معتمد وموقع إلكترونياً، لا يوجد ملاحظات إرشادية إضافية.'}
                </Typography>
              </Box>
            </Box>

            {(() => {
              const rawAttachment = transactionToPrint.attachment;
              let hasAttachment = rawAttachment;
              if (rawAttachment?.startsWith('opening_ref:')) {
                  const key = rawAttachment.replace('opening_ref:', '');
                  hasAttachment = settings.openingStockAttachments?.[key];
              }
              
              if (!hasAttachment) return null;
              
              return (
                <Box sx={{ mb: 4, pageBreakInside: 'avoid' }}>
                  <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#000', mb: 1 }}>مستند الاستلام أو التسليم المرفق:</Typography>
                  <Box style={{ border: '2px solid #000', padding: '10px', textAlign: 'center', backgroundColor: '#fff' }}>
                    <img 
                      src={hasAttachment} 
                      alt="سند الاستلام أو التسليم المرفق" 
                      style={{ maxHeight: '250px', maxWidth: '100%', objectFit: 'contain' }}
                    />
                  </Box>
                </Box>
              );
            })()}

            {/* Official Signatures Section Obeying Settings */}
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2, mt: 5, pt: 2, textAlign: 'center', pageBreakInside: 'avoid' }}>
              <Box style={{ visibility: settings.showStorekeeperSignature !== false ? 'visible' : 'hidden' }}>
                <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#000' }}>{settings.storekeeperRole || 'أمين المخزن'}</Typography>
                <Typography variant="body2" sx={{ color: '#000', my: 1, fontWeight: 'bold' }}>{settings.storekeeperName || ''}</Typography>
                <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mt: 3, fontSize: '13px' }}>التوقيع: <span style={{color: '#cbd5e1'}}>............................</span></Typography>
              </Box>
              <Box style={{ visibility: settings.showSystemManagerSignature !== false ? 'visible' : 'hidden' }}>
                <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#000' }}>{settings.systemManagerRole || 'مدير النظام'}</Typography>
                <Typography variant="body2" sx={{ color: '#000', my: 1, fontWeight: 'bold' }}>{settings.systemManagerName || ''}</Typography>
                <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mt: 3, fontSize: '13px' }}>التوقيع: <span style={{color: '#cbd5e1'}}>............................</span></Typography>
              </Box>
              <Box style={{ visibility: settings.showHealthDirectorSignature !== false ? 'visible' : 'hidden' }}>
                <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#000' }}>{settings.healthDirectorRole || 'مدير صحة البيئة'}</Typography>
                <Typography variant="body2" sx={{ color: '#000', my: 1, fontWeight: 'bold' }}>{settings.healthDirectorName || ''}</Typography>
                <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mt: 3, fontSize: '13px' }}>التوقيع: <span style={{color: '#cbd5e1'}}>............................</span></Typography>
              </Box>
            </Box>



            <Box sx={{ textAlign: 'center', mt: 4, pt: 3, borderTop: '1px dashed #000' }}>
              <Typography sx={{ fontFamily: 'monospace', letterSpacing: '4px', color: '#000', fontSize: '14px', mb: 1 }}>
                ||||| | |||| || ||| | ||| |||| | | | {transactionToPrint.transactionNumber || transactionToPrint.id}
              </Typography>
              <Typography sx={{ fontFamily: 'monospace', color: '#000', fontSize: '11px', fontWeight: 'bold' }}>
                سند رسمي مشفر ومؤرشف إلكترونياً - رقم {transactionToPrint.transactionNumber || transactionToPrint.id}
              </Typography>
            </Box>
          </Box>
        </Box>
      )}

      {/* Attachment View Dialog */}
      <Dialog
        open={openAttachmentDialog}
        onClose={() => setOpenAttachmentDialog(false)}
        maxWidth="md"
        fullWidth
        sx={{ '& .MuiDialog-paper': { direction: 'rtl' } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: '"Cairo", sans-serif' }}>
          <span>معاينة مستند الحركة / كرت الاستلام والتسليم</span>
        </DialogTitle>
        <DialogContent sx={{ pb: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', bgcolor: '#f8fafc' }}>
          {viewingAttachment ? (
            <Box 
              component="img" 
              src={viewingAttachment} 
              alt="مستند الحركة المرفق" 
              sx={{ 
                maxWidth: '100%', 
                maxHeight: '70vh', 
                objectFit: 'contain', 
                borderRadius: '8px', 
                boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
                bgcolor: '#fff'
              }}
            />
          ) : (
            <Typography variant="body2" sx={{ color: '#64748b', fontStyle: 'italic', fontFamily: '"Cairo", sans-serif' }}>
              لا يوجد مستند مرفق لهذه الحركة.
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'flex-start', gap: 2 }}>
          <Button
            variant="contained"
            onClick={() => setOpenAttachmentDialog(false)}
            sx={{ bgcolor: '#0284c7', px: 3, py: 1, fontWeight: 'bold', borderRadius: '10px', fontFamily: '"Cairo", sans-serif', '&:hover': { bgcolor: '#0369a1' } }}
          >
            إغلاق المعاينة
          </Button>
          {viewingAttachment && (
            <Button
              variant="outlined"
              onClick={() => {
                const link = document.createElement('a');
                link.href = viewingAttachment;
                link.download = `attachment-${Date.now()}.jpg`;
                link.click();
              }}
              sx={{ color: '#475569', borderColor: '#cbd5e1', px: 3, py: 1, fontWeight: 'bold', borderRadius: '10px', fontFamily: '"Cairo", sans-serif' }}
            >
              تحميل الملف 💾
            </Button>
          )}
        </DialogActions>
      </Dialog>

          </Box>
  );
}
