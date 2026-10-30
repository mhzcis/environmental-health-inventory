import { requireStableStringPart } from '../utils/printHtml';
import { safeErrorDetail, safeUserMessage } from '../services/safeUserMessage';
import { exportToPDF } from '../utils/printHtml';
import { Fragment, useState, useEffect, useMemo } from 'react';
import NotificationToast from '../components/NotificationToast';
import { 
  Box, Typography, Paper, Grid, MenuItem, Button, Table, TableBody, 
  TableCell, TableContainer, TableHead, TableRow, TablePagination, TextField, 
  Divider, Card, Chip, IconButton, Tooltip,
  Dialog, DialogTitle, DialogContent
} from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import PrintIcon from '@mui/icons-material/Print';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import AnalyticsIcon from '@mui/icons-material/Analytics';
import BusinessIcon from '@mui/icons-material/Business';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';

import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { dataService } from '../services/dataService';
import { buildMaterialWarehouseView, buildOpeningStockReportView, buildTransactionLedger } from '../utils/inventoryLogic';
import { useStorehouse } from '../context/StorehouseContext';
import { InventoryTransaction } from '../types';
import { renderOption } from '../utils/emoji';
import { PRODUCT_LIMITS } from '../utils/productSchema';
import { openingAttachmentMatrixKey } from '../utils/settingsNormalization';


type ReportType = 'inventory' | 'low_stock' | 'expiry_warning' | 'transactions' | 'category_summary' | 'opening_stock' | 'generator_log';

export default function Reports() {
  const { selectedStorehouse } = useStorehouse();
  const getDisplayStorageLocation = (item: any) => {
    if (item.isSubRow) {
      return item.storageLocation || 'المخزن الرئيسي';
    }
    if (item.hasSubRows || item.storageLocation === 'جميع المستودعات') {
      return 'أكثر من مستودع';
    }
    if (selectedStorehouse !== 'all') {
      return item.storageLocation || selectedStorehouse;
    }
    if (item.storageLocation && item.storageLocation !== 'جميع المستودعات') {
      return item.storageLocation;
    }
    if (item.warehouseStocks) {
      const activeStorehouses = Object.entries(item.warehouseStocks)
        .filter(([_, stock]) => (stock as number) > 0)
        .map(([loc, _]) => loc);
      if (activeStorehouses.length > 1) return 'أكثر من مستودع';
      if (activeStorehouses.length === 1) return activeStorehouses[0];
    }
    return item.storageLocation || 'المخزن الرئيسي';
  };


  const formatDateTime = (t: any) => {
    if (t.createdAt) {
      try {
        const d = new Date(t.createdAt);
        if (!isNaN(d.getTime())) {
          return d.toLocaleDateString('ar-EG') + ' ' + d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        }
      } catch(e) {}
    }
    return t.date || '';
  };
  const [reportType, setReportType] = useState<ReportType>('inventory');
  const [materials, setMaterials] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [generatorLogs, setGeneratorLogs] = useState<any[]>([]);
  const [settings, setSettings] = useState(dataService.getSettings());

  // Filters State
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [itemIdFilter, setItemIdFilter] = useState('all');
  const [transactionTypeFilter, setTransactionTypeFilter] = useState('all');

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [partnerFilter, setPartnerFilter] = useState('all');

  // Compute unique partner/entity names dynamically from both registered settings and active transactions
  const uniquePartners = useMemo(() => {
    const list = new Set<string>();
    (settings.partners || []).forEach(p => {
      if (p.name) list.add(p.name);
    });
    transactions.forEach(t => {
      if (t.supplierOrReceiver) list.add(t.supplierOrReceiver);
    });
    return Array.from(list).sort();
  }, [settings.partners, transactions]);

  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(15);
  const [density, setDensity] = useState<'compact' | 'comfortable' | 'spacious'>('comfortable');
  const [successMessage, _setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, _setErrorMessage] = useState<string | null>(null);
  const [openAttachmentDialog, setOpenAttachmentDialog] = useState(false);
  const [viewingAttachment, setViewingAttachment] = useState<string | null>(null);
  const [setupCategories, setSetupCategories] = useState<string[]>([]);
  
  useEffect(() => {
    if (settings?.categories?.length > 0 && setupCategories.length === 0) {
      setSetupCategories([settings.categories[0].name]);
    }
  }, [settings, setupCategories]);
  
  // Arabic Text Repair states
          
  const setSuccessMessage = (msg: string | null) => {
    _setSuccessMessage(msg);
    if (msg) {
      _setErrorMessage(null);
    }
  };

  const setErrorMessage = (msg: string | null) => {
    _setErrorMessage(msg);
    if (msg) {
      _setSuccessMessage(null);
    }
  };

  useEffect(() => {
    const load = () => {
      loadData();
    };
    load();
    return dataService.subscribe(load);
  }, []);

  const loadData = () => {
    setMaterials(dataService.getMaterials());
    setTransactions(dataService.getTransactions());
    setGeneratorLogs(dataService.getGeneratorLogs());
    setSettings(dataService.getSettings());
  };

  const handleResetFilters = () => {
    setCategoryFilter('all');
    setItemIdFilter('all');
    setTransactionTypeFilter('all');

    setDateFrom('');
    setDateTo('');
    setPartnerFilter('all');
    setPage(0);
    setSuccessMessage('تم إعادة ضبط فلاتر البحث بنجاح');
  };

  // Create or use one warehouse-scoped computed dataset as the source of truth for both the summary cards and the inventory table.
  const baseView = useMemo(() => {
    return buildMaterialWarehouseView(materials, selectedStorehouse, settings.storehouses);
  }, [materials, selectedStorehouse, settings.storehouses]);

  const warehouseScopedInventory = useMemo(() => {
    return baseView.filter(m => !m.isSubRow);
  }, [baseView]);

  // Get filtered data array based on chosen report type and sub-filters
  const getFilteredData = () => {
    const thresholdDays = settings.expiryWarningThresholdDays || 30;
    

    switch (reportType) {
      case 'inventory': {
        // Filter subRows and non-matching filters
        return baseView.filter(item => {
          if (item.isSubRow && selectedStorehouse === 'all') return true; // Keep subrows if 'all' for print detail
          if (!item.isSubRow && selectedStorehouse === 'all') return true; // Keep parent if 'all'
          if (selectedStorehouse !== 'all' && item.isSubRow) return false;
          
          if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
          if (itemIdFilter !== 'all' && item._originalId !== itemIdFilter) return false;
          
          return true;
        });
      }

      case 'low_stock': {
        const matchesBaseFilters = (item: any) =>
          (categoryFilter === 'all' || item.category === categoryFilter) &&
          (itemIdFilter === 'all' || item._originalId === itemIdFilter);
        if (selectedStorehouse !== 'all') {
          return baseView.filter((item) => matchesBaseFilters(item) && item.currentStock <= item.minimumStock);
        }
        const lowStockGroupIds = new Set(
          baseView
            .filter((item) => matchesBaseFilters(item) && item.currentStock <= item.minimumStock)
            .map((item) => item._originalId || item.id)
        );
        return baseView.filter((item) => matchesBaseFilters(item) && lowStockGroupIds.has(item._originalId || item.id));
      }

      case 'expiry_warning': {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const matchesBaseFilters = (item: any) =>
          (categoryFilter === 'all' || item.category === categoryFilter) &&
          (itemIdFilter === 'all' || item._originalId === itemIdFilter);
        const qualifies = (item: any) => {
          if (!item.expiryDate) return false;
          const exp = new Date(item.expiryDate);
          const diffDays = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          return diffDays <= thresholdDays && item.currentStock > 0;
        };
        if (selectedStorehouse !== 'all') {
          return baseView.filter((item) => matchesBaseFilters(item) && qualifies(item));
        }
        const expiryGroupIds = new Set(
          baseView
            .filter((item) => matchesBaseFilters(item) && !item.isSubRow && qualifies(item))
            .map((item) => item._originalId || item.id)
        );
        return baseView.filter((item) => matchesBaseFilters(item) && expiryGroupIds.has(item._originalId || item.id));
      }

      case 'opening_stock': {
        const openingView = buildOpeningStockReportView(materials, selectedStorehouse, settings.storehouses);
        return openingView.filter(item => {
          if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
          if (itemIdFilter !== 'all' && item._originalId !== itemIdFilter) return false;
          return true;
        });
      }
      
      case 'transactions': {
        const ledger = buildTransactionLedger(transactions, selectedStorehouse, settings.storehouses, materials);
        return ledger.filter(t => {
          let matches = true;
          if (transactionTypeFilter !== 'all' && t.transactionType !== transactionTypeFilter) matches = false;
          if (itemIdFilter !== 'all' && t.itemId !== itemIdFilter) matches = false;
          if (dateFrom && t.date < dateFrom) matches = false;
          if (dateTo && t.date > dateTo) matches = false;
          if (partnerFilter !== 'all' && t.supplierOrReceiver !== partnerFilter) matches = false;
          // Central scope already enforced by buildTransactionLedger.

          const matchedItem = materials.find(m => m.id === t.itemId || m.code === t.itemCode);
          if (matchedItem) {
            if (categoryFilter !== 'all' && matchedItem.category !== categoryFilter) matches = false;
          } else {
            if (categoryFilter !== 'all') matches = false;
          }
          return matches;
        });
      }

      case 'category_summary': {
        const summaryMap: Record<string, any> = {};
        
        baseView.forEach(item => {
          // In 'all', baseView returns parent row (Total) + sub rows. We must not double count!
          // We should only count the parent row, OR we should aggregate subrows.
          // Since category summary is grouped by storehouse, if selectedStorehouse === 'all', 
          // we use the subrows for specific storehouse breakdowns. If it has no subrows, we use the parent row.
          if (selectedStorehouse === 'all' && !item.isSubRow && baseView.some(x => x.parentId === item._originalId)) {
             return; // Skip parent if it has subrows to avoid double count.
          }
          
          const cat = item.category || 'غير محدد';
          const loc = item.storageLocation;
          if (!loc) return; // P5 fail-closed: never attribute an unscoped item to a synthetic warehouse.
          const key = JSON.stringify([cat, loc]);
          
          if (!summaryMap[key]) {
             summaryMap[key] = {
                id: key,
                category: cat,
                storageLocation: loc,
                totalItems: 0,
                totalQty: 0,
                lowStockCount: 0,
             };
          }
          summaryMap[key].totalItems += 1;
          summaryMap[key].totalQty += item.currentStock;
          if (item.currentStock <= item.minimumStock) {
             summaryMap[key].lowStockCount += 1;
          }
        });
        
        return Object.values(summaryMap).filter(s => {
          if (categoryFilter !== 'all' && s.category !== categoryFilter) return false;
          if (selectedStorehouse !== 'all' && s.storageLocation !== selectedStorehouse) return false;
          return true;
        });
      }


      case 'generator_log': {
        return generatorLogs.filter(item => {
          if (dateFrom && item.date < dateFrom) return false;
          if (dateTo && item.date > dateTo) return false;
          if (partnerFilter !== 'all' && item.createdBy !== partnerFilter) return false;
          return true;
        });
      }

      default:
        return [];
    }
  };
  const currentReportDataUnsorted = getFilteredData();
  const currentReportData = [...currentReportDataUnsorted].sort((a: any, b: any) => {
    if (reportType === 'transactions') {
      const dateA = new Date(a.date || 0).getTime();
      const dateB = new Date(b.date || 0).getTime();
      if (dateB !== dateA) return dateB - dateA;
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return (b.id || '').localeCompare(a.id || '');
    } else if (reportType === 'category_summary') {
      return (a.category || '').localeCompare(b.category || '');
    } else if (reportType === 'generator_log') {
      return (b.date || '').localeCompare(a.date || '');
    } else {
      const codeA = a.code || '';
      const codeB = b.code || '';
      if (codeA !== codeB) return codeA.localeCompare(codeB);
      return (a.id || '').localeCompare(b.id || '');
    }
  });

  const getTransactionWarehouseDetails = (transaction: any) => {
    if (selectedStorehouse !== 'all') return [];
    return settings.storehouses
      .filter((warehouse) =>
        (transaction.displayWarehouseStockBefore?.[warehouse] || 0) !== 0 ||
        (transaction.displayWarehouseStockAfter?.[warehouse] || 0) !== 0 ||
        warehouse === transaction.storehouse
      )
      .map((warehouse) => ({
        warehouse,
        before: transaction.displayWarehouseStockBefore?.[warehouse] ?? 0,
        after: transaction.displayWarehouseStockAfter?.[warehouse] ?? 0,
      }));
  };

  const [exportingPDF, setExportingPDF] = useState(false);

  // Excel professional exporter generating an RTL, beautifully styled spreadsheet list using exceljs
  const handleExportExcel = async () => {
    try {
      const fontName = 'Segoe UI';
      const stampStr = new Date().toISOString().split('T')[0];
      let filename = 'report.xlsx';
      let titleHeader = 'المستند الفني للجرد والأرصدة';

      if (reportType === 'inventory') {
        filename = `تقرير_الجرد_الفعلي_الكامل_${stampStr}.xlsx`;
        titleHeader = 'تقرير الجرد الفعلي السنوي وسجل كرت الكميات المتوفرة';
      } else if (reportType === 'low_stock') {
        filename = `تقرير_المواد_تحت_حد_الأمان_${stampStr}.xlsx`;
        titleHeader = 'تقرير تنبيهات وإمداد كرت الأرصدة المتدنية بحد الأمان';
      } else if (reportType === 'expiry_warning') {
        filename = `تقرير_قرب_نفاد_صلاحية_الاصناف_${stampStr}.xlsx`;
        titleHeader = 'كشف صلاحية وفترات أمان الأصناف المتاحة';
      } else if (reportType === 'transactions') {
        filename = `دفتر_حركات_التوريد_والصرف_${stampStr}.xlsx`;
        titleHeader = 'مسودة حركة القيد المخزني لورود وصرف الأصناف';
      } else if (reportType === 'category_summary') {
        filename = `تقرير_ملخص_تصنيفات_ومستودعات_${stampStr}.xlsx`;
        titleHeader = 'تقرير ملخص مصفوفة التوزيع والأرصدة التراكمية الإجمالية';
      } else if (reportType === 'opening_stock') {
        filename = `سند_توثيق_الأرصدة_الافتتاحية_${stampStr}.xlsx`;
        titleHeader = 'سند توثيق الأرصدة الافتتاحية للمخزون التأسيسي';
      } else if (reportType === 'generator_log') {
        filename = `تقرير_سجل_تشغيل_المولد_${stampStr}.xlsx`;
        titleHeader = 'سجل قراءات وساعات تشغيل عداد المولد';
      }

      let headers: string[] = [];
      let rows: any[][] = [];

      if (reportType === 'inventory') {
        headers = ['كود الصنف', 'اسم ومطابقة الصنف بالكامل', 'التصنيف', 'وحدة المعاملات', 'الرصيد الفعلي الحالي', 'حد الأمان المعتمد', 'المستودع وموقع الحفظ'];
        rows = currentReportData.map((row: any) => [
          row.code,
          row.name,
          row.category,
          row.unit,
          Number(row.currentStock) || 0,
          Number(row.minimumStock) || 0,
          getDisplayStorageLocation(row)
        ]);
      } else if (reportType === 'low_stock') {
        headers = ['كود الصنف', 'اسم ومواصفات الصنف', 'التصنيف', 'وحدة القياس', 'الرصيد المتدني المتوفر', 'رصيد الأمان', 'حجم العجز الفعلي', 'الموقع والمخزن'];
        rows = currentReportData.map((row: any) => [
          row.code,
          row.name,
          row.category,
          row.unit,
          Number(row.currentStock) || 0,
          Number(row.minimumStock) || 0,
          Math.max(0, (Number(row.minimumStock) || 0) - (Number(row.currentStock) || 0)),
          getDisplayStorageLocation(row)
        ]);
      } else if (reportType === 'expiry_warning') {
        headers = ['كود الصنف', 'الاسم الفني التجاري', 'تاريخ الإنتاج', 'تاريخ الانتهاء', 'الأيام المتبقية', 'درجة الخطورة', 'الرصيد الحالي', 'مكان الحفظ'];
        rows = currentReportData.map((row: any) => {
          const exp = row.expiryDate ? new Date(row.expiryDate) : null;
          const today = new Date();
          today.setHours(0,0,0,0);
          const diffDays = exp ? Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : 0;
          return [
            row.code,
            row.name,
            row.productionDate || '-',
            row.expiryDate || '-',
            diffDays <= 0 ? `منتهى منذ ${Math.abs(diffDays)} يوم` : `متبقي ${diffDays} يوم`,
            row.hazardLevel || '-',
            Number(row.currentStock) || 0,
            row.storageLocation
          ];
        });
      } else if (reportType === 'transactions') {
        headers = ['التاريخ والوقت', 'المستودع', 'اسم الصنف', 'كود الصنف', 'نوع الحركة', 'الكمية', 'الرصيد قبله', 'الرصيد بعده', 'الجهة المستلمة / بلدية ومورد', 'الموظف المنفذ'];
        rows = currentReportData.flatMap((t: any) => {
          const parent = [
            formatDateTime(t),
            selectedStorehouse === 'all' ? 'جميع المستودعات (الإجمالي)' : (t.storehouse || ''),
            t.itemName,
            t.itemCode,
            t.transactionType,
            Number(t.quantity) || 0,
            Number(t.displayStockBefore ?? t.stockBefore) || 0,
            Number(t.displayStockAfter ?? t.stockAfter) || 0,
            t.supplierOrReceiver,
            t.executedBy
          ];
          const details = getTransactionWarehouseDetails(t).map((detail) => [
            '', `↳ ${detail.warehouse}`, `↳ تفصيل رصيد ${t.itemName}`, '', 'تفصيل',
            detail.warehouse === t.storehouse ? (Number(t.quantity) || 0) : '—',
            detail.before, detail.after, '', ''
          ]);
          return [parent, ...details];
        });
      } else if (reportType === 'category_summary') {
        headers = ['الفئة واستخداماتها', 'إشغال المستودع الحالي', 'عدد الأصناف الكلية المدرجة', 'مجموع كمية الرصيد', 'أصناف حرجة للغاية', 'متوسط رصيد الصنف الواحد'];
        rows = currentReportData.map((s: any) => [
          s.category,
          s.storageLocation,
          Number(s.totalItems) || 0,
          Number(s.totalQty) || 0,
          Number(s.lowStockCount) || 0,
          Number((s.totalQty / s.totalItems).toFixed(2)) || 0
        ]);
      } else if (reportType === 'opening_stock') {
        headers = ['كود الصنف', 'اسم ومواصفات المادة بالكامل', 'التصنيف', 'وحدة المعاملات', 'الرصيد الافتتاحي المعتمد', 'المستودع وموقع التخزين', 'تاريخ إقرار الرصيد', 'ملاحظات ومواصفات فنية'];
        rows = currentReportData.map((row: any) => {
          const openingQty = row.currentStock;
          const dateFormatted = row.createdAt ? new Date(row.createdAt).toLocaleDateString('ar-EG') : 'تأسيسي';
          return [
            row.isSubRow ? '' : row.code,
            row.isSubRow ? `    - ${row.name}` : row.name,
            row.category,
            row.unit,
            Number(openingQty) || 0,
            getDisplayStorageLocation(row),
            dateFormatted,
            row.notes || '-'
          ];
        });
      } else if (reportType === 'generator_log') {
        headers = ['التاريخ', 'اليوم', 'القراءة السابقة', 'القراءة الحالية', 'ساعات التشغيل', 'الملاحظات', 'المُدخل'];
        rows = currentReportData.map((g: any) => [
          g.date || '',
          g.dayName || '',
          Number(g.previousReading) || 0,
          Number(g.currentReading) || 0,
          Number(g.operatingHours) || 0,
          g.notes || '-',
          g.createdBy || ''
        ]);
      }

      // Initialize Workbook & sheet with proper RTL view options
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('المستند الفني للجرد والأرصدة', {
        views: [{ showGridLines: true, rightToLeft: true }]
      });

      // Format Sheet Header block beautifully and Arabized
      const orgLabel = settings.organizationName || 'الأونروا - وكالة الغوث';
      const depLabel = settings.departmentName || 'إدارة برنامج خدمات البيئة والمخازن';
      const timeLabel = `تاريخ إصدار التقرير: ${new Date().toLocaleDateString('ar-EG')}`;

      const row1 = worksheet.addRow([orgLabel, '', '', '', '', '', '']);
      row1.getCell(1).font = { name: fontName, size: 11, bold: true, color: { argb: '007AB7' } };
      
      const row2 = worksheet.addRow([depLabel, '', '', '', '', '', timeLabel]);
      row2.getCell(1).font = { name: fontName, size: 10, bold: true, color: { argb: '475569' } };
      row2.getCell(7).font = { name: fontName, size: 10, color: { argb: '475569' } };
      
      worksheet.mergeCells(1, 1, 1, 3);
      worksheet.mergeCells(2, 1, 2, 3);
      worksheet.mergeCells(2, 4, 2, 7);
      
      row1.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
      row2.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
      row2.getCell(4).alignment = { horizontal: 'left', vertical: 'middle' };

      worksheet.addRow([]); // Blank spacer

      // 2. Merged Title Row
      const titleRow = worksheet.addRow([titleHeader]);
      titleRow.height = 35;
      worksheet.mergeCells(4, 1, 4, headers.length);
      const titleCell = titleRow.getCell(1);
      titleCell.font = { name: fontName, size: 16, bold: true, color: { argb: '0F172A' } };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
      titleCell.fill = {
         type: 'pattern',
         pattern: 'solid',
         fgColor: { argb: 'F1F5F9' } // Light gray background
      };
      
      worksheet.addRow([]); // Blank spacer

      // 3. Header Row (Headers start at row 6)
      const headerRow = worksheet.addRow(headers);
      headerRow.height = 28;
      headerRow.eachCell((cell) => {
        cell.font = { name: fontName, size: 11, bold: true, color: { argb: 'FFFFFF' } };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: '007AB7' } // UNRWA Blue
        };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: '94A3B8' } },
          bottom: { style: 'medium', color: { argb: '00557F' } },
          left: { style: 'thin', color: { argb: '94A3B8' } },
          right: { style: 'thin', color: { argb: '94A3B8' } }
        };
      });

      // 4. Data Rows
      rows.forEach((rowData, index) => {
        const addedRow = worksheet.addRow(rowData);
        addedRow.height = 24;
        const isAlternate = index % 2 === 1;

        addedRow.eachCell((cell, colNumber) => {
          cell.font = { name: fontName, size: 10, color: { argb: '0F172A' } };
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          
          cell.border = {
            top: { style: 'thin', color: { argb: 'E2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'E2E8F0' } },
            left: { style: 'thin', color: { argb: 'E2E8F0' } },
            right: { style: 'thin', color: { argb: 'E2E8F0' } }
          };

          if (isAlternate) {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'F8FAFC' }
            };
          }

          // Specific layout cell styles
          if (reportType === 'inventory') {
            if (colNumber === 5) {
              const actual = Number(cell.value) || 0;
              const minVal = Number(addedRow.getCell(6).value) || 0;
              cell.font = { name: fontName, size: 10, bold: true };
              if (actual === 0) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '991B1B' } };
              } else if (actual <= minVal) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF3C7' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '92400E' } };
              } else {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0F2FE' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '00557F' } };
              }
            }
          } else if (reportType === 'low_stock') {
            if (colNumber === 7) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
              cell.font = { name: fontName, size: 10, bold: true, color: { argb: '991B1B' } };
            } else if (colNumber === 5) {
              cell.font = { name: fontName, size: 10, bold: true };
              const actual = Number(cell.value) || 0;
              if (actual === 0) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '991B1B' } };
              } else {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF3C7' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '92400E' } };
              }
            }
          } else if (reportType === 'expiry_warning') {
            if (colNumber === 5) {
              const textVal = String(cell.value);
              cell.font = { name: fontName, size: 10, bold: true };
              if (textVal.includes('منتهى')) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '991B1B' } };
              } else if (textVal.includes('متبقي')) {
                const daysNum = Number(textVal.match(/\d+/)?.[0] || '100');
                if (daysNum <= 90) {
                  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF3C7' } };
                  cell.font = { name: fontName, size: 10, bold: true, color: { argb: '92400E' } };
                } else {
                  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0F2FE' } };
                  cell.font = { name: fontName, size: 10, bold: true, color: { argb: '00557F' } };
                }
              }
            }
          } else if (reportType === 'transactions') {
            if (colNumber === 4) {
              const rawType = String(cell.value);
              cell.font = { name: fontName, size: 10, bold: true };
              if (rawType.includes('وارد')) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E0F2FE' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '00557F' } };
              } else {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '991B1B' } };
              }
            }
          } else if (reportType === 'category_summary') {
            if (colNumber === 5) {
              const count = Number(cell.value) || 0;
              if (count > 0) {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEF3C7' } };
                cell.font = { name: fontName, size: 10, bold: true, color: { argb: '92400E' } };
              }
            }
          }
        });
      });

      // 5. Automatic sizing of columns
      headers.forEach((h, colIdx) => {
        const column = worksheet.getColumn(colIdx + 1);
        let maxLen = h.length;
        
        for (let r = 6; r <= worksheet.rowCount; r++) {
          const val = worksheet.getRow(r).getCell(colIdx + 1).value;
          if (val !== undefined && val !== null) {
            const strLen = String(val).length;
            if (strLen > maxLen) {
              maxLen = strLen;
            }
          }
        }
        
        column.width = Math.max(maxLen + 4, 15);
      });

      // 6. Generate the Excel binary stream and trigger download
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveAs(blob, filename);

      setSuccessMessage(`تم تصدير ملف Excel منسق واحترافي بنجاح باسم: ${filename}`);
      
    } catch (err: any) {

    }
  };

  // Direct Arabic PDF Generation in browser with 100% reliable local file download
  const handleExportPDF = async () => {
    try {
      setExportingPDF(true);
      const stampStr = new Date().toISOString().split('T')[0];
      let filename = 'report.pdf';
      let titleHeader = 'المستند الفني للجرد والأرصدة';

      if (reportType === 'inventory') {
        filename = `تقرير_الجرد_الفعلي_الكامل_${stampStr}.pdf`;
        titleHeader = 'تقرير الجرد الفعلي السنوي وسجل كرت الكميات المتوفرة';
      } else if (reportType === 'low_stock') {
        filename = `تقرير_المواد_تحت_حد_الأمان_${stampStr}.pdf`;
        titleHeader = 'تقرير تنبيهات وإمداد كرت الأرصدة المتدنية بحد الأمان';
      } else if (reportType === 'expiry_warning') {
        filename = `تقرير_قرب_نفاد_صلاحية_الاصناف_${stampStr}.pdf`;
        titleHeader = 'كشف صلاحية وفترات أمان الأصناف المتاحة';
      } else if (reportType === 'transactions') {
        filename = `دفتر_حركات_التوريد_والصرف_${stampStr}.pdf`;
        titleHeader = 'مسودة حركة القيد المخزني لورود وصرف الأصناف';
      } else if (reportType === 'category_summary') {
        filename = `تقرير_ملخص_تصنيفات_ومستودعات_${stampStr}.pdf`;
        titleHeader = 'تقرير ملخص مصفوفة التوزيع والأرصدة التراكمية الإجمالية';
      } else if (reportType === 'opening_stock') {
        filename = `سند_توثيق_الأرصدة_الافتتاحية_${stampStr}.pdf`;
        titleHeader = 'سند توثيق الأرصدة الافتتاحية للمخزون التأسيسي';
      } else if (reportType === 'generator_log') {
        filename = `تقرير_سجل_تشغيل_المولد_${stampStr}.pdf`;
        titleHeader = 'سجل قراءات وساعات تشغيل عداد المولد';
      }

      // Build Table Data
      let headers: string[] = [];
      let rows: string[][] = [];
      let alignments: ('right' | 'center' | 'left')[] = [];

      if (reportType === 'inventory') {
        headers = ['كود الصنف', 'اسم الصنف', 'التصنيف', 'الوحدة', 'الرصيد الفعلي', 'حد الأمان', 'موقع التخزين'];
        alignments = ['center', 'center', 'center', 'center', 'center', 'center', 'center'];
        rows = currentReportData.map((row: any) => {
          const actual = Number(row.currentStock);
          const minVal = Number(row.minimumStock);
          let actualCell = String(row.currentStock);
          if (actual === 0) {
            actualCell = `<span style="display: inline-block; padding: 2px 8px; background-color: #fee2e2; color: #991b1b; font-weight: bold; border-radius: 4px;">0</span>`;
          } else if (actual <= minVal) {
            actualCell = `<span style="display: inline-block; padding: 2px 8px; background-color: #fef3c7; color: #92400e; font-weight: bold; border-radius: 4px;">${actual}</span>`;
          } else {
            actualCell = `<span style="display: inline-block; padding: 2px 8px; background-color: #e0f2fe; color: #007ab7; font-weight: bold; border-radius: 4px;">${actual}</span>`;
          }
          return [
            row.code || '',
            row.isSubRow ? `    - ${row.name || ''}` : (row.name || ''),
            row.category || '',
            row.unit || '',
            actualCell,
            String(row.minimumStock),
            getDisplayStorageLocation(row)
          ];
        });
      } else if (reportType === 'low_stock') {
        headers = ['كود الصنف', 'اسم الصنف', 'التصنيف', 'الوحدة', 'الرصيد', 'حد الأمان', 'العجز'];
        alignments = ['center', 'center', 'center', 'center', 'center', 'center', 'center'];
        rows = currentReportData.map((row: any) => {
          const actual = Number(row.currentStock);
          const deficit = Math.max(0, row.minimumStock - row.currentStock);
          const deficitCell = `<span style="display: inline-block; padding: 2px 8px; background-color: #fee2e2; color: #991b1b; font-weight: bold; border-radius: 4px;">${deficit}</span>`;
          
          let actualCell = String(row.currentStock);
          if (actual === 0) {
            actualCell = `<span style="color: #991b1b; font-weight: bold;">0</span>`;
          } else {
            actualCell = `<span style="color: #92400e; font-weight: bold;">${actual}</span>`;
          }
          return [
            row.code || '',
            row.name || '',
            row.category || '',
            row.unit || '',
            actualCell,
            String(row.minimumStock),
            deficitCell
          ];
        });
      } else if (reportType === 'expiry_warning') {
        headers = ['الكود', 'الاسم التجاري', 'تاريخ الانتهاء', 'الأيام المتبقية', 'درجة الخطورة', 'الرصيد', 'الموقع'];
        alignments = ['center', 'center', 'center', 'center', 'center', 'center', 'center'];
        rows = currentReportData.map((row: any) => {
          const exp = row.expiryDate ? new Date(row.expiryDate) : null;
          const today = new Date();
          today.setHours(0,0,0,0);
          const diffDays = exp ? Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : 0;
          const textDiff = diffDays <= 0 ? `منتهى منذ ${Math.abs(diffDays)} يوم` : `متبقي ${diffDays} يوم`;
          
          let diffCell = textDiff;
          if (diffDays <= 0) {
            diffCell = `<span style="display: inline-block; padding: 2px 8px; background-color: #fee2e2; color: #991b1b; font-weight: bold; border-radius: 4px;">${textDiff}</span>`;
          } else if (diffDays <= 90) {
            diffCell = `<span style="display: inline-block; padding: 2px 8px; background-color: #fef3c7; color: #92400e; font-weight: bold; border-radius: 4px;">${textDiff}</span>`;
          } else {
            diffCell = `<span style="display: inline-block; padding: 2px 8px; background-color: #e0f2fe; color: #007ab7; font-weight: bold; border-radius: 4px;">${textDiff}</span>`;
          }

          return [
            row.code || '',
            row.name || '',
            row.expiryDate || '',
            diffCell,
            row.hazardLevel || '',
            String(row.currentStock),
            getDisplayStorageLocation(row)
          ];
        });
      } else if (reportType === 'transactions') {
        headers = ['التاريخ والوقت', 'المستودع', 'اسم الصنف', 'كود', 'نوع الحركة', 'الكمية', 'الرصيد قبل', 'الرصيد بعد', 'الجهة', 'المنفذ'];
        alignments = ['center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center'];
        rows = currentReportData.flatMap((t: any) => {
          let badgeColor = { bg: '#e2e8f0', text: '#334155' };
          if (t.transactionType === 'افتتاحي') badgeColor = { bg: '#dcfce7', text: '#15803d' };
          else if (t.transactionType === 'وارد') badgeColor = { bg: '#e0f2fe', text: '#007ab7' };
          else if (t.transactionType === 'صادر') badgeColor = { bg: '#fee2e2', text: '#b91c1c' };
          else if (t.transactionType === 'مستهلك') badgeColor = { bg: '#fffbeb', text: '#b45309' };
          else if (t.transactionType === 'تحويل') badgeColor = { bg: '#f3e8ff', text: '#6b21a8' };
          else if (t.transactionType === 'تسوية') badgeColor = { bg: '#f1f5f9', text: '#475569' };
          const typeCell = `<span style="display: inline-block; padding: 2px 8px; background-color: ${badgeColor.bg}; color: ${badgeColor.text}; font-weight: bold; border-radius: 4px; font-size: 11px;">${t.transactionType || ''}</span>`;
          const parent = [
            formatDateTime(t),
            selectedStorehouse === 'all' ? 'جميع المستودعات (الإجمالي)' : (t.storehouse || ''),
            t.itemName || '', t.itemCode || '', typeCell, String(t.quantity),
            String(t.displayStockBefore ?? t.stockBefore), String(t.displayStockAfter ?? t.stockAfter),
            t.supplierOrReceiver || '', t.executedBy || ''
          ];
          const details = getTransactionWarehouseDetails(t).map((detail) => [
            '', `↳ ${detail.warehouse}`, `↳ تفصيل رصيد ${t.itemName}`, '', 'تفصيل',
            detail.warehouse === t.storehouse ? String(t.quantity) : '—',
            String(detail.before), String(detail.after), '', ''
          ]);
          return [parent, ...details];
        });
      } else if (reportType === 'category_summary') {
        headers = ['الفئة', 'المستودع', 'الأصناف الكلية', 'مجموع الرصيد', 'أصناف حرجة', 'متوسط رصيد الصنف'];
        alignments = ['center', 'center', 'center', 'center', 'center', 'center'];
        rows = currentReportData.map((s: any) => {
          const lowStockCount = Number(s.lowStockCount);
          let lowStockCell = String(s.lowStockCount);
          if (lowStockCount > 0) {
            lowStockCell = `<span style="display: inline-block; padding: 2px 8px; background-color: #fef3c7; color: #92400e; font-weight: bold; border-radius: 4px;">${s.lowStockCount}</span>`;
          }
          return [
            s.category || '',
            s.storageLocation || '',
            String(s.totalItems),
            String(s.totalQty),
            lowStockCell,
            String((s.totalQty / s.totalItems).toFixed(2))
          ];
        });
      } else if (reportType === 'opening_stock') {
        headers = ['كود الصنف', 'اسم ومواصفات المادة بالكامل', 'التصنيف', 'وحدة المعاملات', 'الرصيد الافتتاحي المعتمد', 'المستودع وموقع التخزين', 'تاريخ إقرار الرصيد', 'ملاحظات ومواصفات فنية'];
        alignments = ['center', 'center', 'center', 'center', 'center', 'center', 'center', 'center'];
        rows = currentReportData.map((row: any) => {
          const openingQty = row.currentStock;
          const dateFormatted = row.createdAt ? new Date(row.createdAt).toLocaleDateString('ar-EG') : 'تأسيسي';
          return [
            row.isSubRow ? '' : (row.code || ''),
            row.isSubRow ? `    - ${row.name}` : (row.name || ''),
            row.category || '',
            row.unit || '',
            String(openingQty),
            getDisplayStorageLocation(row),
            dateFormatted,
            row.notes || ''
          ];
        });
      } else if (reportType === 'generator_log') {
        headers = ['التاريخ', 'اليوم', 'القراءة السابقة', 'القراءة الحالية', 'ساعات التشغيل', 'الملاحظات', 'المُدخل'];
        alignments = ['center', 'center', 'center', 'center', 'center', 'center', 'center'];
        rows = currentReportData.map((g: any) => [
          g.date || '',
          g.dayName || '',
          String(g.previousReading ?? 0),
          String(g.currentReading ?? 0),
          `${g.operatingHours ?? 0} ساعة`,
          g.notes || '-',
          g.createdBy || ''
        ]);
      }


      let recordIds: string[] = [];
      if (reportType === 'inventory' || reportType === 'low_stock' || reportType === 'expiry_warning') {
        recordIds = currentReportData.map((row: any) => {
          const originalId = requireStableStringPart(row._originalId, 'originalId');
          if (typeof row.isSubRow !== 'boolean') throw new Error('isSubRow is not boolean');
          if (row.isSubRow) {
            const wh = requireStableStringPart(row.storageLocation, 'storageLocation');
            return JSON.stringify([reportType, originalId, 'warehouse', wh]);
          } else {
            return JSON.stringify([reportType, originalId, 'parent']);
          }
        });
      } else if (reportType === 'opening_stock') {
        recordIds = currentReportData.map((row: any) => {
          const originalId = requireStableStringPart(row._originalId, 'originalId');
          if (typeof row.isSubRow !== 'boolean') throw new Error('isSubRow is not boolean');
          if (row.isSubRow) {
            const wh = requireStableStringPart(row.storageLocation, 'storageLocation');
            return JSON.stringify(['opening_stock', originalId, 'warehouse', wh]);
          } else {
            return JSON.stringify(['opening_stock', originalId, 'parent']);
          }
        });
      } else if (reportType === 'transactions') {
        recordIds = currentReportData.flatMap((t: any) => {
          const txId = requireStableStringPart(t.id, 'txId');
          const parentId = JSON.stringify(['transaction_report', txId, 'all_or_selected']);
          const details = getTransactionWarehouseDetails(t).map((detail) =>
            JSON.stringify(['transaction_report', txId, 'warehouse', requireStableStringPart(detail.warehouse, 'warehouse')])
          );
          return [parentId, ...details];
        });
      } else if (reportType === 'category_summary') {
        recordIds = currentReportData.map((s: any) => {
          const cat = requireStableStringPart(s.category, 'category');
          const loc = requireStableStringPart(s.storageLocation, 'storageLocation');
          return JSON.stringify(['category_summary', cat, loc]);
        });
      } else if (reportType === 'generator_log') {
        recordIds = currentReportData.map((g: any) => {
          const id = requireStableStringPart(g.id, 'generatorLogId');
          return JSON.stringify(['generator_log_report', id]);
        });
      }

      await exportToPDF({
        title: titleHeader,
        organizationName: settings.organizationName || 'المستودع البلدي العام',
        departmentName: settings.departmentName || 'قسم الصحة والبيئة ومكافحة الأوبئة',
        filename,
        orientation: reportType === 'transactions' ? 'landscape' : 'portrait',
        metaFields: [
          { label: 'تصنيف التقرير وعائلته:', value: reportType === 'inventory' ? 'مسرد الجرد الفعلي العام للعهود' : reportType === 'low_stock' ? 'تنبيهات نقص المخزون الحرج' : reportType === 'expiry_warning' ? 'متابعة نفاذ الصلاحية وضمان الجودة' : reportType === 'transactions' ? 'دفتر اليومية وحركات الصرف والتوريد' : reportType === 'opening_stock' ? 'سند توثيق الأرصدة الافتتاحية للمخزون' : reportType === 'generator_log' ? 'سجل متابعة وقراءات عداد المولد' : 'مصفوفة ملخص الفئات والمستودعات' },
          { label: 'تعداد السجلات المدرجة:', value: `${currentReportData.length} سجل حركي دفتري` }
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
          { role: settings.systemManagerRole || 'مدير النظام', name: settings.systemManagerName || '', show: settings.showSystemManagerSignature !== false },
          { role: settings.healthDirectorRole || 'مدير صحة البيئة', name: settings.healthDirectorName || '', show: settings.showHealthDirectorSignature !== false }
        ]
      });

      setSuccessMessage(`تم توليد وتنزيل كشف التقرير الموحد بنجاح: ${filename} 📄`);
    } catch (e) { console.error("Export PDF error:", e);

      setErrorMessage('خطأ التصدير: ' + safeUserMessage(e, 'export', { allowAppText: true }));
    } finally {
      setExportingPDF(false);
    }
  };

  // Pagination bounds safety
  const paginatedData = reportType === 'category_summary' ? currentReportData : currentReportData.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage
  );

  const cellPadding = density === 'compact' ? { py: { xs: 0.6, sm: 0.8, md: 1 }, px: { xs: 0.8, sm: 1, md: 1.2 } } :
                      density === 'spacious' ? { py: { xs: 2.2, sm: 2.6, md: 3 }, px: { xs: 1.5, sm: 2, md: 2.5 } } :
                      { py: { xs: 1.2, sm: 1.5, md: 1.8 }, px: { xs: 1.2, sm: 1.5, md: 2 } }; // comfortable is default

  const fontSizeStyle = density === 'compact' ? { xs: '11px', sm: '12px', md: '13px' } :
                        density === 'spacious' ? { xs: '14px', sm: '15px', md: '16px' } :
                        { xs: '12px', sm: '13px', md: '14px' };

  // Stats Counters
  const getStats = () => {
    let totalItems = 0;
    let sumQtys = 0;
    let criticalItems = 0;

    warehouseScopedInventory.forEach(m => {
      totalItems++;
      sumQtys += m.currentStock;
      if (m.currentStock <= m.minimumStock) {
        criticalItems++;
      }
    });

    const itemsWithExpiry = warehouseScopedInventory.filter((m: any) => !!m.expiryDate) as any[];
    const now = new Date();
    now.setHours(0,0,0,0);
    const expiredCount = itemsWithExpiry.filter(p => {
      if (!p.expiryDate) return false;
      return new Date(p.expiryDate) <= now;
    }).length;

    return { totalItems, sumQtys, criticalItems, expiredCount };
  };

  const stat = getStats();

  return (
    <Box sx={{ p: { xs: 1, md: 3 }, direction: 'rtl', minHeight: '100vh', bgcolor: '#f8fafc' }}>
      
      {/* Page Title & Header Info */}
      <Box className="no-print-area" sx={{ mb: 4, pb: 2, borderBottom: '1px solid #e2e8f0', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: '800', color: '#0f172a', fontFamily: '"Cairo", sans-serif', display: 'flex', alignItems: 'center', gap: 1 }}>
            <AnalyticsIcon sx={{ color: '#007ab7', fontSize: '28px' }} />
            شاشة التقارير والمخرجات الرسمية المنظمة
          </Typography>
          <Typography variant="body2" sx={{ color: '#64748b', mt: 0.5, fontFamily: '"Cairo", sans-serif' }}>
            توليد كشوفات الأرصدة المخزنية المعتمدة بشكل فوري، وتحليل مستويات الأمان، وتتبع الحركات المخزنية مع ميزة الطباعة وتصدير Excel منسق.
          </Typography>
        </Box>
        
        {/* Rapid Stats Tiles for context */}
        <Box sx={{ display: 'flex', flexDirection: 'row', gap: 2, flexWrap: 'wrap' }}>
          <Card variant="outlined" sx={{ bgcolor: '#fff', borderRadius: '12px', borderColor: '#e2e8f0', minWidth: 120, p: 1, py: 1.5, textAlign: 'center' }}>
            <Typography variant="caption" sx={{ color: '#64748b', fontWeight: 'bold' }}>رصيد الأصناف الكلية</Typography>
            <Typography variant="h6" sx={{ fontWeight: '800', color: '#0f172a' }}>{stat.totalItems}</Typography>
          </Card>
          <Card variant="outlined" sx={{ bgcolor: '#fff', borderRadius: '12px', borderColor: '#e2e8f0', minWidth: 120, p: 1, py: 1.5, textAlign: 'center' }}>
            <Typography variant="caption" sx={{ color: '#64748b', fontWeight: 'bold' }}>الأرصدة المتوفرة</Typography>
            <Typography variant="h6" sx={{ fontWeight: '800', color: '#007ab7' }}>{stat.sumQtys}</Typography>
          </Card>
          <Card variant="outlined" sx={{ bgcolor: '#fff', borderRadius: '12px', borderColor: '#fee2e2', minWidth: 120, p: 1, py: 1.5, textAlign: 'center' }}>
            <Typography variant="caption" sx={{ color: '#ef4444', fontWeight: 'bold' }}>أصناف حرجة للتعاقد</Typography>
            <Typography variant="h6" sx={{ fontWeight: '800', color: '#ef4444' }}>{stat.criticalItems}</Typography>
          </Card>
          {stat.expiredCount > 0 && (
            <Card variant="outlined" sx={{ bgcolor: '#fff8f8', borderRadius: '12px', borderColor: '#fca5a5', minWidth: 120, p: 1, py: 1.5, textAlign: 'center' }}>
              <Typography variant="caption" sx={{ color: '#b91c1c', fontWeight: 'bold' }}>أصناف منتهية الصلاحية</Typography>
              <Typography variant="h6" sx={{ fontWeight: '800', color: '#b91c1c' }}>{stat.expiredCount}</Typography>
            </Card>
          )}
        </Box>
      </Box>

      {/* Control Panel Card containing Multi Filters */}
      <Paper className="no-print-area" sx={{ p: 3, mb: 4, transition: 'all 0.2s', }}>
        <Grid container spacing={3}>
          
          {/* Main selection of report type */}
          <Grid size={{ xs: 12, md: 5 }}>
            <TextField
              select
              fullWidth
              size="small"
              label="تحديد نوع التقرير الفني المراد توليده"
              value={reportType}
              onChange={(e) => {
                setReportType(e.target.value as ReportType);
                setPage(0);
              }}
              slotProps={{ input: { style: { borderRadius: '10px', fontWeight: '700', color: '#1e293b' } } }}
            >
              <MenuItem value="inventory">{renderOption("تقرير الجرد العام وجرد الأرصدة المتوفرة حالياً", "category")}</MenuItem>
              <MenuItem value="low_stock">{renderOption("تقرير إنفاد مخزون الأمان", "category")}</MenuItem>
              <MenuItem value="expiry_warning">{renderOption('تقرير كشف فترات الصلاحيات وحالة الأصناف المشروطة بالصلاحية', 'category')}</MenuItem>
              <MenuItem value="transactions">{renderOption("سجل حركات المستودع التفصيلي", "category")}</MenuItem>
              <MenuItem value="category_summary">{renderOption("تقرير الموازنة والملخص الشامل", "category")}</MenuItem>
              <MenuItem value="opening_stock">{renderOption("سند توثيق الأرصدة الافتتاحية", "category")}</MenuItem>
              <MenuItem value="generator_log">{renderOption("سجل تشغيل ومتابعة عداد المولد", "category")}</MenuItem>
            </TextField>
          </Grid>

          {/* Sub description info about the active report */}
          <Grid size={{ xs: 12, md: 7 }} sx={{ display: 'flex', alignItems: 'center' }}>
            <Box sx={{ bgcolor: '#f0f9ff', p: 1.5, px: 2, borderRadius: '8px', borderLeft: '4px solid #007ab7', width: '100%' }}>
              <Typography variant="caption" sx={{ color: '#0369a1', fontWeight: 'bold', fontFamily: '"Cairo", sans-serif', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <BusinessIcon sx={{ fontSize: '15px' }} />
                ملاحظة الإشراف الفني للتصفية:
              </Typography>
              <Typography variant="body2" sx={{ color: '#0e7490', fontSize: '11px', fontFamily: '"Cairo", sans-serif', mt: 0.2 }}>
                {reportType === 'inventory' && 'يعرض كامل قائمة الأصناف والكميات المتوفرة المخزنية حالياً في كافة مواقع ووحدات الحفظ المعتمدة.'}
                {reportType === 'low_stock' && 'يحصر فقط الأصناف التي استهلكت كمياتها وأصبحت تحت أو مساوية لحد الأمان الأدنى الموصى به لتغذية التوريدات.'}
                {reportType === 'expiry_warning' && 'مخصص لفحص تواريخ صلاحيات الأصناف لمطابقة فترات الأمان والتنبيه بقرب الانتهاء حسب ثوابت الإعدادات.'}
                {reportType === 'transactions' && 'يسحب حركات التوريد، الصرف، الاستهلاك، والتحويل المرتبطة بالأصناف والمصروفات بالتواريخ دقيقة الثانية.'}
                {reportType === 'category_summary' && 'يعرض تقريراً ملخصاً وإحصائياً يوضح توزيع وحالة المخزون الكلي لكل تصنيف داخل مستودعات التوزيع.'}
                {reportType === 'opening_stock' && 'وثيقة رسمية ومستند معتمد لحصر وتثبيت الأرصدة والكميات الافتتاحية المدخلة كبداية تشغيل النظام لبدء رصد المعاملات.'}
                {reportType === 'generator_log' && 'مخصص لمتابعة قراءات وساعات تشغيل المولد التراكمية وتأثير الحسابات الزمنيّة بمرونة الفلترة كاملة.'}
              </Typography>
            </Box>
          </Grid>

          <Grid size={12}>
            <Divider sx={{ borderStyle: 'dashed' }} />
          </Grid>

          {/* Advanced Multi-Filters Block */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              select
              fullWidth
              size="small"
              label="تصفية حسب الفئة / التصنيف"
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                setPage(0);
              }}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كل الفئات والتصنيفات")}</MenuItem>
              {settings.categories.map((cat) => (
                <MenuItem key={cat.name} value={cat.name}>{renderOption(cat.name, "category")}</MenuItem>
              ))}
            </TextField>
          </Grid>

          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              select
              fullWidth
              size="small"
              label="بحث وتحديد صنف معين"
              value={itemIdFilter}
              onChange={(e) => {
                setItemIdFilter(e.target.value);
                setPage(0);
              }}
              disabled={reportType === 'category_summary'}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كل الأصناف المدرجة بالمخازن")}</MenuItem>
              {materials.map((m) => (
                <MenuItem key={m.id} value={m.id}>{renderOption(`${m.name} (${m.code})`, "item")}</MenuItem>
              ))}
            </TextField>
          </Grid>

          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Box sx={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'space-between', 
              p: 0.8, 
              px: 1.5,
              bgcolor: '#f0f9ff', 
              border: '1px solid #bae6fd', 
              borderRadius: '10px',
              height: '40px',
              width: '100%'
            }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#0369a1', fontFamily: '"Cairo", sans-serif', whiteSpace: 'nowrap' }}>
                🏢 المستودع النشط:
              </Typography>
              <Chip
                label={selectedStorehouse === 'all' ? 'جميع المستودعات' : selectedStorehouse}
                size="small"
                sx={{ fontWeight: 'bold', fontFamily: '"Cairo", sans-serif', bgcolor: '#007ab7', color: '#ffffff', height: '26px' }}
              />
            </Box>
          </Grid>


          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              select
              fullWidth
              size="small"
              label="نوع الحركة (لتقرير العمليات)"
              value={transactionTypeFilter}
              onChange={(e) => {
                setTransactionTypeFilter(e.target.value);
                setPage(0);
              }}
              disabled={reportType !== 'transactions'}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كافة الحركات")}</MenuItem>
              <MenuItem value="وارد">{renderOption("وارد")}</MenuItem>
              <MenuItem value="صادر">{renderOption("صادر")}</MenuItem>
              <MenuItem value="مستهلك">{renderOption("مستهلك")}</MenuItem>
              <MenuItem value="تحويل">{renderOption("تحويل")}</MenuItem>
              <MenuItem value="تسوية">{renderOption("تسوية")}</MenuItem>
              <MenuItem value="افتتاحي">{renderOption("افتتاحي")}</MenuItem>
            </TextField>
          </Grid>

          {/* Date range filters & Partner Filter */}
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              fullWidth
              type="date"
              size="small"
              label="من تاريخ الحركة / التلقيم"
              slotProps={{ inputLabel: { shrink: true } }}
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(0);
              }}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              fullWidth
              type="date"
              size="small"
              label="إلى تاريخ الحركة / التلقيم"
              slotProps={{ inputLabel: { shrink: true } }}
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(0);
              }}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            />
          </Grid>

          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <TextField
              select
              fullWidth
              size="small"
              label="الجهة أو الشريك"
              value={partnerFilter}
              onChange={(e) => {
                setPartnerFilter(e.target.value);
                setPage(0);
              }}
              disabled={reportType !== 'transactions'}
              sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
            >
              <MenuItem value="all">{renderOption("كل الجهات والشركاء")}</MenuItem>
              {uniquePartners.map((p) => (
                <MenuItem key={p} value={p}>{renderOption(p, "partner")}</MenuItem>
              ))}
            </TextField>
          </Grid>

          <Grid size={{ xs: 12, md: 3 }} sx={{ display: 'flex', gap: 1.5, alignSelf: 'center', justifyContent: 'flex-end', mt: { xs: 2, md: 0 } }}>
            <Tooltip title="تفريغ كافة فلاتر البحث وإعادتها للافتراضي">
              <Button
                variant="outlined"
                color="secondary"
                onClick={handleResetFilters}
                startIcon={<FilterAltOffIcon sx={{ ml: 1, mr: -0.5 }} />}
                sx={{ borderRadius: '10px', px: 2, fontFamily: '"Cairo", sans-serif', width: '100%' }}
              >
                مسح الفلاتر
              </Button>
            </Tooltip>
          </Grid>

          <Grid size={12}>
            <Divider sx={{ my: 1 }} />
          </Grid>

          {/* Control Panel Action Commands */}
          <Grid size={12} sx={{ display: 'flex', gap: 2, justifyContent: 'flex-start', flexWrap: 'wrap' }}>
            {dataService.hasPermission('reports_export') && (
              <Button
                variant="contained"
                startIcon={<FileDownloadIcon sx={{ ml: 1, mr: -0.5 }} />}
                onClick={handleExportExcel}
                sx={{ bgcolor: '#10b981', color: 'white', fontWeight: 'bold', borderRadius: '10px', px: 3, py: 1.2, '&:hover': { bgcolor: '#059669' }, fontFamily: '"Cairo", sans-serif' }}
              >
                تصدير اكسل
              </Button>
            )}
            
            {dataService.hasPermission('reports_print') && (
              <Button
                variant="contained"
                disabled={exportingPDF}
                startIcon={<PrintIcon sx={{ ml: 1, mr: -0.5 }} />}
                onClick={handleExportPDF}
                sx={{ bgcolor: '#007ab7', color: 'white', fontWeight: 'bold', borderRadius: '10px', px: 3, py: 1.2, '&:hover': { bgcolor: '#006293' }, fontFamily: '"Cairo", sans-serif' }}
              >
                {exportingPDF ? 'جاري التوليد...' : 'طباعة pdf'}
              </Button>
            )}
          </Grid>
        </Grid>
      </Paper>

      {reportType === 'opening_stock' && (
        <Paper className="no-print-area" sx={{ p: 3, mb: 3, bgcolor: '#f8fafc' }}>
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1, color: '#0f172a', fontFamily: '"Cairo", sans-serif', display: 'flex', alignItems: 'center', gap: 1 }}>
              📎 سندات توثيق الأرصدة الافتتاحية المعتمدة (حسب التصنيف)
            </Typography>
            <Typography variant="body2" sx={{ color: '#64748b', fontSize: '0.82rem', fontFamily: '"Cairo", sans-serif', lineHeight: 1.6, mb: 3 }}>
              لتثبيت المستندات القانونية للأرصدة التأسيسية، يرجى رفع السند المعتمد والموقع كصورة لكل فئة وتصنيف بشكل منفصل. سيقوم النظام بربط الصورة تلقائياً بجميع حركات الأرصدة الافتتاحية التابعة للتصنيف المختار لسهولة الاستعراض والطباعة والتوثيق المالي والمخزني دون تكرار تخزين الملف.
            </Typography>
          </Box>

          <Grid container spacing={3} sx={{ mb: 3 }}>
            <Grid size={{ xs: 12, md: 5 }}>
              <TextField
                select
                fullWidth
                size="small"
                label="اختر التصنيف / الفئة لربط السند الموقع"
                value={setupCategories}
                onChange={(e) => setSetupCategories(typeof e.target.value === 'string' ? e.target.value.split(',') : (e.target.value as unknown as string[]))}
                slotProps={{ select: { multiple: true } }}
                sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
              >
                {settings.categories.map((cat) => (
                  <MenuItem key={cat.name} value={cat.name}>{renderOption(cat.name, "category")}</MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid size={{ xs: 12, md: 7 }} sx={{ display: 'flex', alignItems: 'center' }}>
                            {setupCategories.length > 0 ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', width: '100%' }}>
                    <Button
                      component="label"
                      variant="contained"
                      size="small"
                      startIcon={<CloudUploadIcon sx={{ ml: 1, mr: -0.5 }} />}
                      sx={{ bgcolor: '#007ab7', color: 'white', fontWeight: 'bold', borderRadius: '10px', px: 3, py: 1, '&:hover': { bgcolor: '#006293' }, fontFamily: '"Cairo", sans-serif' }}
                    >
                      رفع سند موحد لـ ({setupCategories.length}) تصنيفات
                      <input
                        type="file"
                        hidden
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          
                          if (file.size > 2 * 1024 * 1024) {
                            setErrorMessage('حجم الصورة كبير جداً، يرجى اختيار صورة أقل من 2 ميجابايت.');
                            return;
                          }
                          const reader = new FileReader();
                            reader.onload = (event) => {
                              const img = new Image();
                            img.onload = async () => {
                              const canvas = document.createElement('canvas');
                              let width = img.width;
                              let height = img.height;
                              const MAX_SIZE = 800; // max width/height
                              if (width > height) {
                                if (width > MAX_SIZE) {
                                  height *= MAX_SIZE / width;
                                  width = MAX_SIZE;
                                }
                              } else {
                                if (height > MAX_SIZE) {
                                  width *= MAX_SIZE / height;
                                  height = MAX_SIZE;
                                }
                              }
                              canvas.width = width;
                              canvas.height = height;
                              const ctx = canvas.getContext('2d');
                              if (ctx) {
                                ctx.fillStyle = '#ffffff';
                                ctx.fillRect(0, 0, width, height);
                                ctx.drawImage(img, 0, 0, width, height);
                                const compressedBase64 = canvas.toDataURL('image/jpeg', 0.6);
                                
                                const currentAttachments = settings.openingStockAttachments ? { ...settings.openingStockAttachments } : {};
                                const targetStorehouses = selectedStorehouse !== 'all' ? [selectedStorehouse] : (settings.storehouses.length > 0 ? settings.storehouses : ['المخزن الرئيسي']);
                                
                                setupCategories.forEach(cat => {
                                   targetStorehouses.forEach(wh => {
                                      const entity = (settings.storehouseEntities || [])
                                        .find(entry => entry.name === wh || entry.id === wh);
                                      const warehouseId = entity?.id || wh;
                                      try {
                                        const matrixKey = openingAttachmentMatrixKey(warehouseId, cat);
                                        currentAttachments[matrixKey] = compressedBase64;
                                      } catch (identityError) {
                                        throw new Error(
                                          `SETTINGS_OSA_KEY_NOT_IDENTITY_SAFE:${warehouseId}:${cat}:${safeErrorDetail(identityError)}`,
                                        );
                                      }
                                   });
                                });
                                
                                const updatedSettings = { ...settings, openingStockAttachments: currentAttachments };

                                const attachmentCount = Object.keys(currentAttachments).length;
                                if (attachmentCount > PRODUCT_LIMITS.openingStockAttachments) {
                                   setErrorMessage(`تجاوزت السندات الحد المعتمد (${PRODUCT_LIMITS.openingStockAttachments}). لم يُحفظ أو يُحذف أي سند.`);
                                   return;
                                }
                                const totalSize = new TextEncoder().encode(JSON.stringify(updatedSettings)).byteLength;
                                if (totalSize > PRODUCT_LIMITS.settingsDocumentBytes) {
                                   setErrorMessage(`تجاوزت الإعدادات حد ${PRODUCT_LIMITS.settingsDocumentBytes} بايت. يرجى حذف بعض السندات القديمة أولاً؛ لم يحدث اقتطاع صامت.`);
                                   return;
                                }
                                // settingsSchemaVersion 3: one osa_* (+ root key index) at a time
                                const previousKeys = new Set(Object.keys(settings.openingStockAttachments || {}));
                                for (const [attachmentKey, attachmentValue] of Object.entries(currentAttachments)) {
                                  if (previousKeys.has(attachmentKey)
                                    && settings.openingStockAttachments?.[attachmentKey] === attachmentValue) {
                                    continue;
                                  }
                                  await dataService.saveOpeningStockAttachment(attachmentKey, attachmentValue);
                                }
                                setSettings(dataService.getSettings());
                                
                                const allTransactions = dataService.getTransactions();
                                const materialsList = dataService.getMaterials();
                                let txUpdatedCount = 0;
                                const updatedTransactions = allTransactions.map(tx => {
                                   const txSupplier = tx.supplierOrReceiver || '';
                                   const txNotes = tx.notes || '';
                                   const isOpeningStock = txSupplier.includes('افتتاحي') || txSupplier.includes('إفتتاحي') || txSupplier.includes('أولي') || txNotes.includes('افتتاحي') || txNotes.includes('إفتتاحي') || txNotes.includes('تأسيس');
                                   if (isOpeningStock) {
                                       const txStorehouse = tx.storehouse || 'المخزن الرئيسي';
                                       const txCategory = tx.itemCategory || materialsList.find(m => m.id === tx.itemId)?.category || tx.itemType || '';
                                       if (targetStorehouses.includes(txStorehouse) && setupCategories.includes(txCategory)) {
                                           tx.attachment = `opening_ref:${txStorehouse}_${txCategory}`;
                                           txUpdatedCount++;
                                       }
                                   }
                                   return tx;
                                });
                                
                                if (txUpdatedCount > 0) {
                                   // Persist through the domain service; direct shared LocalStorage
                                   // writes would bypass P3 UID isolation and durability.
                                   await dataService.replaceTransactionsForAttachmentMigration(updatedTransactions);
                                }
                                
                                setSuccessMessage(`تم رفع السند بنجاح! تم ربط (${txUpdatedCount}) من السندات السابقة المنطبقة. (السندات اللاحقة ستحتاج إرفاقاً يدوياً).`);
                              }
                            };
                            img.src = event.target?.result as string;
                          };
                          reader.readAsDataURL(file);
                        }}
                      />
                    </Button>
                  </Box>
                </Box>
              ) : (
                <Typography variant="body2" sx={{ color: '#64748b', fontFamily: '"Cairo", sans-serif', fontStyle: 'italic' }}>
                  الرجاء اختيار تصنيف لرفع السند الخاص به.
                </Typography>
              )}
            </Grid>
          </Grid>
          <Divider sx={{ my: 2 }} />
          
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 1.5, color: '#475569', fontFamily: '"Cairo", sans-serif' }}>
            📋 مصفوفة الأرصدة الافتتاحية المعتمدة (المستودعات × الفئات):
          </Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
            <Table size="small">
              <TableHead sx={{ bgcolor: '#f8fafc' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>التصنيف / الفئة</TableCell>
                  {(settings.storehouses || []).map(wh => (
                     <TableCell key={wh} align="center" sx={{ fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>{wh}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {settings.categories.map(cat => (
                  <TableRow key={cat.name}>
                    <TableCell sx={{ fontFamily: '"Cairo", sans-serif' }}>{cat.name}</TableCell>
                    {(settings.storehouses || []).map(wh => {
                       const entity = (settings.storehouseEntities || [])
                         .find(entry => entry.name === wh || entry.id === wh);
                       const warehouseId = entity?.id || wh;
                       let attachmentData: string | undefined;
                       let key: string | null = null;
                       try {
                         key = openingAttachmentMatrixKey(warehouseId, cat);
                         attachmentData = settings.openingStockAttachments?.[key];
                       } catch {
                         attachmentData = undefined;
                       }
                       return (
                         <TableCell key={wh} align="center">
                           {attachmentData && key ? (
                             <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1 }}>
                                <IconButton size="small" onClick={() => {
                                   setViewingAttachment(attachmentData);
                                   setOpenAttachmentDialog(true);
                                }}>
                                  <VisibilityIcon fontSize="small" sx={{ color: '#16a34a' }} />
                                </IconButton>
                                <IconButton size="small" color="error" onClick={async () => {
                                   await dataService.saveOpeningStockAttachment(key, null);
                                   setSettings(dataService.getSettings());
                                   setSuccessMessage('تم حذف سند توثيق الرصيد الافتتاحي بنجاح.');
                                }}>
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                             </Box>
                           ) : (
                             <Typography variant="caption" sx={{ color: '#94a3b8' }}>-</Typography>
                           )}
                         </TableCell>
                       );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      {/* View Attachment Dialog */}
      <Dialog 
        open={openAttachmentDialog} 
        onClose={() => setOpenAttachmentDialog(false)}
        maxWidth="md"
        fullWidth
        id="opening-stock-attachment-view-dialog"
      >
        <DialogTitle sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>معاينة سند توثيق الرصيد الافتتاحي المرفق</span>
          <IconButton onClick={() => setOpenAttachmentDialog(false)} size="small">
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, p: 3 }}>
          {viewingAttachment ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: '100%' }}>
              <img 
                src={viewingAttachment} 
                alt="سند توثيق الرصيد الافتتاحي المرفق" 
                style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                referrerPolicy="no-referrer"
              />
              <Button 
                variant="outlined" 
                startIcon={<DownloadIcon />}
                onClick={() => {
                  const link = document.createElement('a');
                  link.href = viewingAttachment;
                  link.download = `opening-stock-document-${Date.now()}.jpg`;
                  link.click();
                }}
                sx={{ fontFamily: '"Cairo", sans-serif' }}
              >
                تحميل السند المرفق
              </Button>
            </Box>
          ) : (
            <Typography sx={{ py: 3, textAlign: 'center', color: '#64748b', fontFamily: '"Cairo", sans-serif' }}>
              لا يوجد مستند مرفق.
            </Typography>
          )}
        </DialogContent>
      </Dialog>

      <NotificationToast open={!!successMessage} message={successMessage} severity="success" onClose={() => setSuccessMessage('')} />

      <NotificationToast open={!!errorMessage} message={errorMessage} severity="error" onClose={() => setErrorMessage('')} />

      {/* Printable Report Zone */}
      <Paper id="printable-reportZone" className="printable-report-sheet" sx={{ p: { xs: 2, sm: 5 }, bgcolor: '#fff', boxShadow: 'none' }}>
        
        {/* Printable Official Header */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', pb: 2, borderBottom: '3px double #0f172a', mb: 3 }}>
          <Box>
            <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#000', fontSize: '1.25rem', fontFamily: '"Cairo", sans-serif' }}>
              {settings.organizationName}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#334155', mt: 0.5, fontFamily: '"Cairo", sans-serif' }}>
              {settings.departmentName}
            </Typography>
          </Box>
          
          <Box sx={{ textAlign: 'end', minWidth: '150px' }}>
            <Typography variant="body2" sx={{ color: '#000', fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>
              تاريخ الطباعة: {new Date().toLocaleDateString('ar-EG')}
            </Typography>
            <Typography variant="body2" sx={{ color: '#000', mt: 0.5, fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>
              الوقت: {new Date().toLocaleTimeString('ar-EG')}
            </Typography>
          </Box>
        </Box>

        {/* Dynamic Header Titles based on select report */}
        <Box sx={{ textAlign: 'center', mb: 4, px: 2 }}>
          <Typography variant="h5" sx={{ fontWeight: '800', color: '#0f172a', fontFamily: '"Cairo", sans-serif', textDecoration: 'underline', textUnderlineOffset: '6px' }}>
            {reportType === 'inventory' && 'تقرير الجرد الفعلي السنوي وسجل كرت الكميات المتوفرة'}
            {reportType === 'low_stock' && 'تقرير تنبيهات وإمداد كرت الأرصدة المتدنية بحد الأمان'}
            {reportType === 'expiry_warning' && 'كشف صلاحية وفترات أمان الأصناف المتاحة'}
            {reportType === 'transactions' && 'مسودة حركة القيد المخزني لورود وصرف الأصناف'}
            {reportType === 'category_summary' && 'تقرير ملخص مصفوفة التوزيع والأرصدة التراكمية الإجمالية'}
            {reportType === 'opening_stock' && 'سند توثيق وإقرار الأرصدة الافتتاحية للمخزون التأسيسي'}
            {reportType === 'generator_log' && 'سجل قراءات وساعات تشغيل عداد المولد'}
          </Typography>
          <Typography variant="body2" sx={{ color: '#334155', mt: 1.5, maxWidth: '700px', mx: 'auto', lineHeight: 1.6, fontSize: '13px', fontFamily: '"Cairo", sans-serif' }}>
            {reportType === 'inventory' && 'يوضح هذا السجل كميات الأصناف والمواد المطابقة كلياً للجرد الميداني والموزعة جغرافيًا حسب أماكن التخزين والصيانة الحالية.'}
            {reportType === 'low_stock' && 'حصر فني مخصص بالتوريدات المتأخرة أو العاجلة التي تراجعت وتناقصت كمياتها دون حد الأمان المطلوب لأعمال صحة البيئة.'}
            {reportType === 'expiry_warning' && `مستند لمتابعة فترات الحماية وصلاحية الأصناف الحساسة لتقليل الهدر والتلفيات المباشرة حسب حد الإشعار المعتمد (${settings.expiryWarningThresholdDays} يوم).`}
            {reportType === 'transactions' && 'حصر توثيقي للعمليات الوردية والصرف اليومي الميداني للبلديات والمتعهدين مع بيان الرصيد اللوجستي بعد كل تلقيم تلقائي.'}
            {reportType === 'category_summary' && 'تحليل تراكمي إجمالي لحجم تداول الأصناف حسب الفئة الرئيسية ومستودع الحفظ لتقديم أرقام موازنة فورية لصناع القرار.'}
            {reportType === 'opening_stock' && 'مستند إقرار وحصر لكافة المواد والكميات الافتتاحية المتوفرة مسبقاً بالمخازن كبداية تشغيل للنظام، يتم التوقيع عليه لبدء رصد المعاملات.'}
            {reportType === 'generator_log' && 'مستند رسمي يوضح الترتيب الزمني لقراءات العداد السابقة والحالية وساعات التشغيل اليومية التراكمية مع الفلترة والتحليل.'}
          </Typography>
          
          {/* Active search filter statement indicators */}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1.5, mt: 2, flexWrap: 'wrap' }} className="no-print-area">
            {categoryFilter !== 'all' && <Chip label={`الفئة: ${categoryFilter}`} size="small" variant="outlined" sx={{ fontWeight: 'bold' }} />}
            {itemIdFilter !== 'all' && <Chip label={`صنف معين`} size="small" variant="outlined" sx={{ fontWeight: 'bold' }} />}
            {selectedStorehouse !== 'all' && <Chip label={`مستودع: ${selectedStorehouse}`} size="small" variant="outlined" sx={{ fontWeight: 'bold' }} />}
            {transactionTypeFilter !== 'all' && <Chip label={`الحركة: ${transactionTypeFilter}`} size="small" variant="outlined" sx={{ fontWeight: 'bold' }} />}
            {(dateFrom || dateTo) && <Chip label={`تاريخ مخصص`} size="small" variant="outlined" sx={{ fontWeight: 'bold' }} />}
            {partnerFilter !== 'all' && <Chip label={`الجهة/الشريك: ${partnerFilter}`} size="small" variant="outlined" sx={{ fontWeight: 'bold' }} />}
          </Box>
        </Box>

        {/* Spacing density and results summary toolbar */}
        <Box className="no-print-area" sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, justifyContent: 'space-between', alignItems: { xs: 'stretch', sm: 'center' }, gap: 2, bgcolor: '#fff', p: 1.5, px: 2, borderRadius: '12px', mb: 2, mt: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: '#007ab7' }} />
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#334155', fontFamily: '"Cairo", sans-serif', fontSize: '13px' }}>
              تبيان المعاينة: <span style={{ color: '#007ab7' }}>{paginatedData.length}</span> من أصل <span style={{ color: '#007ab7' }}>{currentReportData.length}</span> سجل مطابق للبحث
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ fontWeight: '600', color: '#64748b', fontFamily: '"Cairo", sans-serif', fontSize: '12px' }}>
              مسافة وتباعد الأسطر:
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, bgcolor: '#f1f5f9', p: 0.5, borderRadius: '10px' }}>
              <Button
                size="small"
                onClick={() => setDensity('compact')}
                sx={{
                  fontFamily: '"Cairo", sans-serif',
                  fontSize: '11px',
                  fontWeight: density === 'compact' ? 'bold' : 'normal',
                  color: density === 'compact' ? '#007ab7' : '#64748b',
                  bgcolor: density === 'compact' ? '#fff' : 'transparent',
                  boxShadow: density === 'compact' ? '0 1px 3px rgba(0,0,0,0.05)' : 'none',
                  borderRadius: '8px',
                  '&:hover': { bgcolor: density === 'compact' ? '#fff' : 'rgba(0,0,0,0.02)' },
                  px: 1.5,
                  py: 0.5,
                  minWidth: 'auto'
                }}
              >
                مكثفة (ميداني)
              </Button>
              <Button
                size="small"
                onClick={() => setDensity('comfortable')}
                sx={{
                  fontFamily: '"Cairo", sans-serif',
                  fontSize: '11px',
                  fontWeight: density === 'comfortable' ? 'bold' : 'normal',
                  color: density === 'comfortable' ? '#007ab7' : '#64748b',
                  bgcolor: density === 'comfortable' ? '#fff' : 'transparent',
                  boxShadow: density === 'comfortable' ? '0 1px 3px rgba(0,0,0,0.05)' : 'none',
                  borderRadius: '8px',
                  '&:hover': { bgcolor: density === 'comfortable' ? '#fff' : 'rgba(0,0,0,0.02)' },
                  px: 1.5,
                  py: 0.5,
                  minWidth: 'auto'
                }}
              >
                متوازنة
              </Button>
              <Button
                size="small"
                onClick={() => setDensity('spacious')}
                sx={{
                  fontFamily: '"Cairo", sans-serif',
                  fontSize: '11px',
                  fontWeight: density === 'spacious' ? 'bold' : 'normal',
                  color: density === 'spacious' ? '#007ab7' : '#64748b',
                  bgcolor: density === 'spacious' ? '#fff' : 'transparent',
                  boxShadow: density === 'spacious' ? '0 1px 3px rgba(0,0,0,0.05)' : 'none',
                  borderRadius: '8px',
                  '&:hover': { bgcolor: density === 'spacious' ? '#fff' : 'rgba(0,0,0,0.02)' },
                  px: 1.5,
                  py: 0.5,
                  minWidth: 'auto'
                }}
              >
                مريحة واسعة
              </Button>
            </Box>
          </Box>
        </Box>

        {/* Live Preview Elements based on selection */}
        <TableContainer sx={{ borderRadius: '12px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', }}>
          <Table sx={{ minWidth: 650 }}>
            <TableHead sx={{ bgcolor: '#f1f5f9' }}>
              {reportType === 'inventory' && (
                <TableRow>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>كود المقارنة</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>اسم ومطابقة الصنف بالكامل</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>التصنيف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>وحدة المعاملات</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الرصيد الفعلي الحالي</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>حد الأمان المعتمد</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>المستودع وموقع الحفظ</TableCell>
                </TableRow>
              )}

              {reportType === 'low_stock' && (
                <TableRow>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>كود الصنف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>اسم ومواصفات الصنف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>التصنيف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>وحدة القياس</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الرصيد المتدني المتوفر</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>رصيد الأمان</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#ef4444', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>حجم العجز الفعلي</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الموقع والمخزن</TableCell>
                </TableRow>
              )}

              {reportType === 'expiry_warning' && (
                <TableRow>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>كود الصنف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الاسم الفني التجاري للمادة/الصنف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>تاريخ الإنتاج</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>تاريخ الانتهاء</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الأيام المتبقية لجاهزية الاستخدام</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>درجة الخطورة</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الرصيد الحالي</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>مكان الحفظ</TableCell>
                </TableRow>
              )}

              {reportType === 'transactions' && (
                <TableRow>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>التاريخ والوقت</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>المستودع</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>اسم الصنف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>كود الصنف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>نوع الحركة</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الكمية</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الرصيد قبله</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الرصيد بعده</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الجهة المستلمة / بلدية ومورد</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الموظف المنفذ</TableCell>
                </TableRow>
              )}

              {reportType === 'category_summary' && (
                <TableRow>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الفئة واستخداماتها</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>إشغال المستودع الحالي</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>عدد الأصناف الكلية المدرجة</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>مجموع كمية الرصيد</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#ef4444', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>أصناف حرجة للغاية</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>متوسط رصيد الصنف الواحد</TableCell>
                </TableRow>
              )}

              {reportType === 'opening_stock' && (
                <TableRow>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>كود الصنف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>اسم ومواصفات المادة بالكامل</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>التصنيف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>وحدة المعاملات</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الرصيد الافتتاحي المعتمد</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>المستودع وموقع التخزين</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>تاريخ إقرار الرصيد</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>ملاحظات ومواصفات فنية</TableCell>
                </TableRow>
              )}

              {reportType === 'generator_log' && (
                <TableRow>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>التاريخ</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>اليوم</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>القراءة السابقة</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>القراءة الحالية</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#0284c7', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>ساعات التشغيل</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>الملاحظات</TableCell>
                  <TableCell align="center" sx={{ fontWeight: '900', color: '#1e293b', fontFamily: '"Cairo", sans-serif', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>المُدخل</TableCell>
                </TableRow>
              )}
            </TableHead>
            <TableBody>
              {paginatedData.length > 0 ? (
                paginatedData.map((row: any, idx) => {
                  if (reportType === 'inventory') {
                    const isLow = row.currentStock <= row.minimumStock;
                    return (
                      <TableRow key={`${row.id}-${idx}`} sx={{ '&:nth-of-type(even)': { bgcolor: '#f8fafc' }, '&:hover': { bgcolor: '#f1f5f9' }, transition: 'background-color 0.15s ease' }}>
                        <TableCell align="center" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: row.isSubRow ? '#64748b' : '#007ab7', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                           {row.isSubRow ? '' : row.code}
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: row.isSubRow ? 'normal' : 'bold', color: row.isSubRow ? '#64748b' : 'inherit', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                           {row.isSubRow ? `    - ${row.name}` : row.name}
                        </TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.category}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.unit}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: '900', color: isLow ? '#ef4444' : '#10b981', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {row.currentStock} {isLow ? '⚠️' : '✓'}
                        </TableCell>
                        <TableCell align="center" sx={{ color: '#475569', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.minimumStock}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{getDisplayStorageLocation(row)}</TableCell>
                      </TableRow>
                    );
                  }

                  if (reportType === 'low_stock') {
                    const deficit = Math.max(0, row.minimumStock - row.currentStock);
                    return (
                      <TableRow key={`${row.id}-${idx}`} sx={{ '&:nth-of-type(even)': { bgcolor: '#fff5f5' }, '&:hover': { bgcolor: '#fee2e2' }, transition: 'background-color 0.15s ease' }}>
                        <TableCell align="center" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: '#ef4444', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.code}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', color: '#ef4444', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.name}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.category}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.unit}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: '900', color: '#b91c1c', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.currentStock}</TableCell>
                        <TableCell align="center" sx={{ color: '#475569', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.minimumStock}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: '900', color: '#ef4444', bgcolor: '#fef2f2', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {deficit}
                        </TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{getDisplayStorageLocation(row)}</TableCell>
                      </TableRow>
                    );
                  }

                  if (reportType === 'expiry_warning') {
                    const exp = row.expiryDate ? new Date(row.expiryDate) : null;
                    const today = new Date();
                    today.setHours(0,0,0,0);
                    const diffDays = exp ? Math.ceil((exp.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : 0;
                    const isExpired = diffDays <= 0;
                    
                    return (
                      <TableRow key={`${row.id}-${idx}`} sx={{ '&:nth-of-type(even)': { bgcolor: isExpired ? '#fef2f2' : '#fffbeb' }, '&:hover': { bgcolor: isExpired ? '#fee2e2' : '#fef3c7' }, transition: 'background-color 0.15s ease' }}>
                        <TableCell align="center" sx={{ fontFamily: 'monospace', fontWeight: 'bold', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.code}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.name}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.productionDate || '--'}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', color: isExpired ? '#b91c1c' : '#d97706', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {row.expiryDate || '--'}
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', color: isExpired ? '#ef4444' : '#1e293b', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {isExpired ? (
                            <Chip label={`منتهى الصلاحية`} size="small" sx={{ bgcolor: '#fee2e2', color: '#991b1b', fontWeight: 'bold', height: '22px', fontSize: '11px' }} />
                          ) : (
                            <Chip label={`باقي وظيفي ${diffDays} يوم`} size="small" sx={{ bgcolor: '#fef3c7', color: '#92400e', fontWeight: 'bold', height: '22px', fontSize: '11px' }} />
                          )}
                        </TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          <Chip 
                            label={row.hazardLevel || 'منخفض'} 
                            size="small" 
                            variant="outlined" 
                            color={row.hazardLevel === 'مرتفع' ? 'error' : row.hazardLevel === 'متوسط' ? 'warning' : 'success'} 
                            sx={{ fontWeight: 'bold', height: '20px', fontSize: '10px' }}
                          />
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: '800', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.currentStock}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{getDisplayStorageLocation(row)}</TableCell>
                      </TableRow>
                    );
                  }

                  if (reportType === 'transactions') {
                    const isInbound = row.transactionType === 'وارد' || row.transactionType === 'افتتاحي' || (row.transactionType === 'تحويل' && row.transferType === 'in') || (row.transactionType === 'تسوية' && (row.transferType === 'in' || row.quantity >= 0));
                    
                    let chipBg = '#e0f2fe';
                    let chipColor = '#007ab7';
                    if (row.transactionType === 'افتتاحي') {
                      chipBg = '#dcfce7';
                      chipColor = '#15803d';
                    } else if (row.transactionType === 'صادر') {
                      chipBg = '#fee2e2';
                      chipColor = '#b91c1c';
                    } else if (row.transactionType === 'مستهلك') {
                      chipBg = '#fffbeb';
                      chipColor = '#b45309';
                    } else if (row.transactionType === 'تحويل') {
                      chipBg = '#f3e8ff';
                      chipColor = '#6b21a8';
                    } else if (row.transactionType === 'تسوية') {
                      chipBg = '#f1f5f9';
                      chipColor = '#475569';
                    }
                    
                    return (
                      <Fragment key={`${row.id}-${idx}`}>
                      <TableRow sx={{ '&:nth-of-type(even)': { bgcolor: '#f8fafc' }, '&:hover': { bgcolor: '#f1f5f9' }, transition: 'background-color 0.15s ease' }}>
                        <TableCell align="center" sx={{ fontFamily: 'monospace', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{formatDateTime(row)}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {selectedStorehouse === 'all' ? 'جميع المستودعات (الإجمالي)' : (row.storehouse || '')}
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.itemName}</TableCell>
                        <TableCell align="center" sx={{ fontFamily: 'monospace', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.itemCode}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          <Chip 
                            label={row.transactionType} 
                            size="small"
                            sx={{ 
                              bgcolor: chipBg, 
                              color: chipColor, 
                              fontWeight: 'bold',
                              height: '22px',
                              fontSize: '11px'
                            }} 
                          />
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', color: isInbound ? '#15803d' : '#ef4444', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {isInbound ? '+' : '-'}{row.quantity}
                        </TableCell>
                        <TableCell align="center" sx={{ color: '#64748b', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.displayStockBefore ?? row.stockBefore}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', color: '#0f172a', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.displayStockAfter ?? row.stockAfter}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.supplierOrReceiver || 'مخزن غير محدد'}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.executedBy}</TableCell>
                      </TableRow>
                      {getTransactionWarehouseDetails(row).map((detail) => (
                        <TableRow key={`${row.id}-warehouse-${detail.warehouse}`} sx={{ bgcolor: '#f8fafc' }}>
                          <TableCell />
                          <TableCell align="center" sx={{ color: '#0284c7', fontWeight: 'bold', py: cellPadding.py }}>↳ {detail.warehouse}</TableCell>
                          <TableCell align="center" sx={{ color: '#64748b', py: cellPadding.py }}>↳ تفصيل رصيد {row.itemName}</TableCell>
                          <TableCell />
                          <TableCell align="center">تفصيل</TableCell>
                          <TableCell align="center">{detail.warehouse === row.storehouse ? row.quantity : '—'}</TableCell>
                          <TableCell align="center" sx={{ color: '#64748b' }}>{detail.before}</TableCell>
                          <TableCell align="center" sx={{ fontWeight: 'bold' }}>{detail.after}</TableCell>
                          <TableCell colSpan={2} />
                        </TableRow>
                      ))}
                      </Fragment>
                    );
                  }

                  if (reportType === 'category_summary') {
                    const avg = row.totalItems > 0 ? (row.totalQty / row.totalItems).toFixed(1) : '0';
                    return (
                      <TableRow key={`${row.id}-${idx}`} sx={{ '&:nth-of-type(even)': { bgcolor: '#f8fafc' }, '&:hover': { bgcolor: '#f1f5f9' }, transition: 'background-color 0.15s ease' }}>
                        <TableCell align="center" sx={{ fontWeight: 'bold', color: '#0f172a', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.category}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.storageLocation}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.totalItems}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: '800', color: '#007ab7', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.totalQty}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', color: row.lowStockCount > 0 ? '#ef4444' : '#10b981', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {row.lowStockCount} {row.lowStockCount > 0 ? '⚠️' : '✓'}
                        </TableCell>
                        <TableCell align="center" sx={{ color: '#475569', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{avg}</TableCell>
                      </TableRow>
                    );
                  }

                  if (reportType === 'opening_stock') {
                    const openingQty = row.currentStock;
                    const dateFormatted = row.createdAt ? new Date(row.createdAt).toLocaleDateString('ar-EG') : 'تأسيسي';
                    return (
                      <TableRow key={`${row.id}-${idx}`} sx={{ bgcolor: row.isSubRow ? '#f8fafc' : 'inherit', '&:hover': { bgcolor: '#f1f5f9' }, transition: 'background-color 0.15s ease' }}>
                        <TableCell align="center" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: row.isSubRow ? '#64748b' : '#007ab7', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {row.isSubRow ? '' : row.code}
                        </TableCell>
                        <TableCell align="center" sx={{ fontWeight: row.isSubRow ? 'normal' : 'bold', color: row.isSubRow ? '#64748b' : 'inherit', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>
                          {row.isSubRow ? `    - ${row.name}` : row.name}
                        </TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.category}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.unit}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: '900', color: row.isSubRow ? '#0284c7' : '#0f172a', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{openingQty}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{getDisplayStorageLocation(row)}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{dateFormatted}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.notes || '--'}</TableCell>
                      </TableRow>
                    );
                  }

                  if (reportType === 'generator_log') {
                    return (
                      <TableRow key={`${row.id}-${idx}`} sx={{ '&:nth-of-type(even)': { bgcolor: '#f8fafc' }, '&:hover': { bgcolor: '#f1f5f9' }, transition: 'background-color 0.15s ease' }}>
                        <TableCell align="center" sx={{ fontWeight: 'bold', color: '#0284c7', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.date}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.dayName}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.previousReading}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 'bold', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.currentReading}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: '900', color: '#059669', py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.operatingHours} ساعة</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.notes || '-'}</TableCell>
                        <TableCell align="center" sx={{ py: cellPadding.py, px: cellPadding.px, fontSize: fontSizeStyle }}>{row.createdBy}</TableCell>
                      </TableRow>
                    );
                  }

                  return null;
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={11} align="center" sx={{ py: 6, fontStyle: 'italic', color: '#64748b', fontFamily: '"Cairo", sans-serif' }}>
                    لم يعثر على سجلات تطابق قواعد التصفية بالفترة الزمنية المحددة.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          
          {reportType !== 'category_summary' && (
            <TablePagination
              rowsPerPageOptions={[5, 15, 30, 200]}
              component="div"
              count={currentReportData.length}
              rowsPerPage={rowsPerPage}
              page={page}
              onPageChange={(_, newPage) => setPage(newPage)}
              onRowsPerPageChange={(e) => {
                setRowsPerPage(parseInt(e.target.value, 10));
                setPage(0);
              }}
              labelRowsPerPage="صفوف الصفحة:"
              labelDisplayedRows={({ from, to, count }) => `${from}-${to} من ${count}`}
              className="no-print-area"
              sx={{ borderTop: '1px solid #e2e8f0' }}
            />
          )}
        </TableContainer>
      </Paper>
    </Box>
  );
}
