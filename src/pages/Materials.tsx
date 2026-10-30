import { useState, useEffect } from 'react';
import { presentResultMessage, safeUserMessage } from '../services/safeUserMessage';
import NotificationToast from '../components/NotificationToast';
import EmptyTableState from '../components/EmptyTableState';
import { 
  Box, Typography, Button, TextField, MenuItem, Paper, Table, TableBody, 
  TableCell, TableContainer, TableHead, TableRow, TablePagination,
  IconButton, Dialog, DialogTitle, DialogContent, DialogActions, Tooltip, Chip, Grid, Divider, Alert,
  Checkbox
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import AssessmentIcon from '@mui/icons-material/Assessment';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import SubdirectoryArrowLeftIcon from '@mui/icons-material/SubdirectoryArrowLeft';
import FilterAltOffIcon from '@mui/icons-material/FilterAltOff';
import { useForm, SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as zod from 'zod';
import { dataService } from '../services/dataService';
import { Material, InventoryTransaction } from '../types';
import { buildMaterialWarehouseView, MaterialViewRow } from '../utils/inventoryLogic';
import { useStorehouse } from '../context/StorehouseContext';

import { exportToPDF } from '../utils/printHtml';
import { exportToExcel } from '../utils/exportExcel';
import { requireStableStringPart } from '../utils/printHtml';
import { renderOption } from '../utils/emoji';


interface StocktakeRow {
  rowKey: string;
  materialId: string;
  code: string;
  name: string;
  unit: string;
  storehouse: string;
  systemStock: number;
}

// Zod Validation Schema matching exactly the 7 requested fields with strict positive quantity and non-reversed date checks
const materialSchema = zod.object({
  category: zod.string().min(1, { message: 'يرجى اختيار تصنيف صالح' }),
  code: zod.string().optional(),
  name: zod.string().min(3, { message: 'الاسم يجب أن يكون 3 حروف على الأقل' }),
  initialStock: zod.coerce.number({ message: 'الرصيد الابتدائي يجب أن يكون رقماً' }),
  minimumStock: zod.coerce.number({ message: 'الحد الأدنى يجب أن يكون رقماً' }).min(0, { message: 'الحد الأدنى يجب أن يكون صفر أو أكثر' }),
  storageLocation: zod.string().min(1, { message: 'يرجى تحديد المستودع' }),
  unit: zod.string().min(1, { message: 'يرجى تحديد وحدة القياس' }),
  notes: zod.string().optional(),
  productionDate: zod.string().optional(),
  expiryDate: zod.string().optional(),
  hazardLevel: zod.enum(['منخفض', 'متوسط', 'مرتفع', '']).optional(),
  manufacturer: zod.string().optional(),
  isEditMode: zod.boolean().optional(),
}).refine((data) => {
  // If not in edit mode, initial stock must be greater than or equal to 0 (no negative values)
  if (!data.isEditMode && data.initialStock < 0) {
    return false;
  }
  return true;
}, {
  message: 'الرصيد الابتدائي يجب أن يكون صفراً أو أكبر (لا يُسمح بالقيم السالبة)',
  path: ['initialStock'],
}).refine((data) => {
  if (data.productionDate && data.expiryDate) {
    const prod = new Date(data.productionDate);
    const exp = new Date(data.expiryDate);
    return exp >= prod;
  }
  return true;
}, {
  message: 'تاريخ انتهاء الصلاحية لا يمكن أن يكون قبل تاريخ الإنتاج (التواريخ معكوسة)',
  path: ['expiryDate'],
});

type MaterialFormValues = zod.infer<typeof materialSchema>;

export default function Materials() {

  const getDisplayStorageLocation = (item: any) => {
    return item.storageLocation || 'المخزن الرئيسي';
  };
  const { selectedStorehouse } = useStorehouse();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [settings, setSettings] = useState(dataService.getSettings());
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [stockStatusFilter, setStockStatusFilter] = useState('all');

  
  // Bulk selection states
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [exportingPDF, setExportingPDF] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  
  // Table Sorting and Pagination state
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [orderBy] = useState<keyof Material>('code');
  const [order] = useState<'asc' | 'desc'>('asc');

  const handleClearFilters = () => {
    setSearchQuery('');
    setCategoryFilter('all');
    setStockStatusFilter('all');
    setPage(0);
  };

  // Dialogs state
  const [openFormDialog, setOpenFormDialog] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedMaterial, setSelectedMaterial] = useState<MaterialViewRow | null>(null);
  const [, setIsNewSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState('');
  const [saveNewSupplier, setSaveNewSupplier] = useState(false);
  const [openDeleteDialog, setOpenDeleteDialog] = useState(false);
  const [openBulkDeleteDialog, setOpenBulkDeleteDialog] = useState(false);
  const [materialToDelete, setMaterialToDelete] = useState<MaterialViewRow | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [openDetailsDialog, setOpenDetailsDialog] = useState(false);
  const [detailsMaterial, setDetailsMaterial] = useState<MaterialViewRow | null>(null);

  // Stocktake states
  const [openStocktakeDialog, setOpenStocktakeDialog] = useState(false);
  const [stocktakeList, setStocktakeList] = useState<StocktakeRow[]>([]);
  const [physicalCounts, setPhysicalCounts] = useState<Record<string, string>>({});
  const [stocktakeNotes, setStocktakeNotes] = useState('');

  const handleOpenStocktakeDialog = () => {
    const rows: StocktakeRow[] = [];
    const initialCounts: Record<string, string> = {};

    materials.forEach((m) => {
      if (selectedStorehouse !== 'all') {
        const store = selectedStorehouse;
        const whStock = m.warehouseStocks && typeof m.warehouseStocks[store] === 'number'
          ? m.warehouseStocks[store]
          : (m.storageLocation === store ? m.currentStock : 0);


        const rowKey = `${m.id}__${store}`;
        rows.push({
          rowKey,
          materialId: m.id,
          code: m.code,
          name: m.name,
          unit: m.unit || 'وحدة',
          storehouse: store,
          systemStock: whStock,
        });
        initialCounts[rowKey] = String(whStock);
      } else {
        const activeWhs = settings.storehouses || [];
        const whStocks = m.warehouseStocks || {};
        const whKeys = Object.keys(whStocks);

        if (whKeys.length > 0) {
          activeWhs.forEach((wh) => {
            if (whStocks[wh] !== undefined || m.storageLocation === wh) {
              const qty = whStocks[wh] ?? (m.storageLocation === wh ? m.currentStock : 0);
              if (qty > 0 || m.storageLocation === wh) {
                const rowKey = `${m.id}__${wh}`;
                rows.push({
                  rowKey,
                  materialId: m.id,
                  code: m.code,
                  name: m.name,
                  unit: m.unit || 'وحدة',
                  storehouse: wh,
                  systemStock: qty,
                });
                initialCounts[rowKey] = String(qty);
              }
            }
          });
        } else {
          const store = m.storageLocation || 'المخزن الرئيسي';
          const rowKey = `${m.id}__${store}`;
          rows.push({
            rowKey,
            materialId: m.id,
            code: m.code,
            name: m.name,
            unit: m.unit || 'وحدة',
            storehouse: store,
            systemStock: m.currentStock,
          });
          initialCounts[rowKey] = String(m.currentStock);
        }
      }
    });

    setStocktakeList(rows);
    setPhysicalCounts(initialCounts);
    setStocktakeNotes('');
    setOpenStocktakeDialog(true);
  };

  const handlePhysicalCountChange = (rowKey: string, value: string) => {
    setPhysicalCounts((prev) => ({
      ...prev,
      [rowKey]: value,
    }));
  };

  const handleSaveStocktake = async () => {
    // P10-POL-1: materials_stocktake = UX eligibility only; cloud effects need transactions_create (Rules).
    if (!dataService.hasPermission('materials_stocktake')) {
      setErrorMessage('ليس لديك أهلية واجهة الجرد السنوي (materials_stocktake). هذه صلاحية واجهة فقط وليست سلطة سحابية.');
      return;
    }
    if (!dataService.hasPermission('transactions_create')) {
      setErrorMessage('تسوية الجرد تتطلب صلاحية تسجيل الحركات (transactions_create) على الخادم. materials_stocktake لا تمنح سلطة سحابية مستقلة.');
      return;
    }

    let reconciledCount = 0;
    let errorCount = 0;
    
    setErrorMessage(null);
    
    for (const row of stocktakeList) {
      const enteredVal = physicalCounts[row.rowKey];
      if (enteredVal === undefined) continue;
      
      const physicalCount = parseFloat(enteredVal);
      if (isNaN(physicalCount) || physicalCount < 0) {
        setErrorMessage(`القيمة المدخلة للصنف "${row.name}" في موقع (${row.storehouse}) غير صالحة. يجب أن تكون رقماً أكبر من أو يساوي صفر.`);
        return;
      }
      
      const systemStock = row.systemStock;
      const diff = physicalCount - systemStock;
      
      if (diff !== 0) {
        const reconTx: InventoryTransaction = {
          id: `tr-recon-${Date.now()}-${row.materialId}-${Math.random().toString(36).substring(2, 6)}`,
          date: new Date().toISOString().split('T')[0],
          itemType: 'مادة',
          itemCategory: '',
          itemId: row.materialId,
          itemCode: row.code,
          itemName: row.name,
          transactionType: diff > 0 ? 'وارد' : 'صادر',
          quantity: Math.abs(diff),
          unit: row.unit,
          storehouse: row.storehouse,
          stockBefore: 0,
          stockAfter: 0,
          executedBy: dataService.getCurrentUser().fullName,
          supplierOrReceiver: 'لجنة الجرد السنوي الفعلي (تسوية مطابقة)',
          notes: `تسوية جرد سنوية تلقائية لتعديل الرصيد الدفتري ليتطابق مع الفعلي في موقع ${row.storehouse}. الفارق: ${diff > 0 ? '+' : ''}${diff}. ${stocktakeNotes ? `ملاحظة إضافية: ${stocktakeNotes}` : ''}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        
        const res = await dataService.saveTransaction(reconTx);
        if (res.success) {
          reconciledCount++;
        } else {
          errorCount++;
        }
      }
    }
    
    if (errorCount > 0) {
      setErrorMessage(`تمت تسوية بعض الحركات بنجاح، ولكن فشلت ${errorCount} تسويات بسبب عجز الرصيد.`);
    } else if (reconciledCount > 0) {
      setSuccessMessage(`تم بنجاح تسوية الجرد السنوي لـ (${reconciledCount}) حركة مخزنية وتعديل مطابقة أرصدتها بالكامل بالدفاتر والمستودعات.`);
      setOpenStocktakeDialog(false);
      loadMaterials();
    } else {
      setSuccessMessage('لم يتم إجراء أي تعديلات لعدم وجود أي فروقات بين الجرد الفعلي وأرصدة النظام الدفترية الحالية.');
      setOpenStocktakeDialog(false);
    }
  };

  // Form setup
  const { register, handleSubmit, reset, setValue, watch, formState: { errors } } = useForm<MaterialFormValues>({
    resolver: zodResolver(materialSchema) as any,
    defaultValues: {
      category: '',
      code: '',
      name: '',
      initialStock: 0,
      minimumStock: 10,
      storageLocation: '',
      unit: '',
      notes: '',
      manufacturer: 'جهة غير محددة',
      isEditMode: false,
    }
  });

  const watchCategory = watch('category');
  const watchManufacturer = watch('manufacturer');
  const watchInitialStock = watch('initialStock');

  // Load data on start and on updates
  useEffect(() => {
    const load = () => {
      loadMaterials();
      setSettings(dataService.getSettings());
    };
    load();
    return dataService.subscribe(load);
  }, []);

  // Update generated item code automatically when selected category changes
  useEffect(() => {
    if (watchCategory && !selectedMaterial) {
      const generated = dataService.generateItemCode(watchCategory);
      setValue('code', generated);
    }
  }, [watchCategory, selectedMaterial, setValue]);

  const loadMaterials = () => {
    setMaterials(dataService.getMaterials());
  };

  useEffect(() => {
    setSelectedMaterialIds([]);
  }, [selectedStorehouse]);

  const handleOpenAddDialog = () => {
    setSelectedMaterial(null);
    const defaultCat = settings.categories[0]?.name || '';
    reset({
      category: defaultCat,
      code: defaultCat ? dataService.generateItemCode(defaultCat) : '',
      name: '',
      initialStock: 0, // Default to a valid positive value of 0 for convenience
      minimumStock: 0,
      storageLocation: selectedStorehouse !== 'all' ? selectedStorehouse : '',
      unit: settings.units?.[0] || 'قطعة',
      notes: '',
      productionDate: '',
      expiryDate: '',
      hazardLevel: '',
      manufacturer: 'جهة غير محددة',
      isEditMode: false,
    });
    setIsNewSupplier(false);
    setNewSupplierName('');
    setSaveNewSupplier(false);
    setOpenFormDialog(true);
  };

  const handleOpenEditDialog = (item: Material) => {
    setSelectedMaterial(item);
    reset({
      category: item.category,
      code: item.code,
      name: item.name,
      initialStock: 0, // Disabled on edit, shown as read-only or hidden
      minimumStock: item.minimumStock,
      storageLocation: item.storageLocation,
      unit: item.unit || settings.units?.[0] || 'قطعة',
      notes: item.notes || '',
      productionDate: item.productionDate || '',
      expiryDate: item.expiryDate || '',
      hazardLevel: item.hazardLevel || '',
      manufacturer: item.manufacturer || 'جهة غير محددة',
      isEditMode: true,
    });
    setIsNewSupplier(false);
    setNewSupplierName('');
    setSaveNewSupplier(false);
    setOpenFormDialog(true);
  };

  const handleOpenDetailsDialog = (item: any) => {
    const originalItem = materials.find(m => m.id === (item._originalId || item.id)) || item;
    // We should pass the split item so the details dialog shows the stock of this specific storehouse?
    // Wait! The user clicked on a row representing a specific storehouse.
    // Let's attach the original ID so that transaction queries work!
    setDetailsMaterial({...originalItem, currentStock: item.currentStock, storageLocation: item.storageLocation, _originalId: item._originalId});
    setOpenDetailsDialog(true);
  };

    const onSubmitForm: SubmitHandler<MaterialFormValues> = async (data) => {
    setIsSubmitting(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      let finalManufacturer = data.manufacturer || 'جهة غير محددة';

      if (data.manufacturer === 'new_supplier...') {
        const trimmedName = newSupplierName.trim().replace(/\s+/g, ' ');
        if (!trimmedName) {
           setErrorMessage('يرجى إدخال اسم المورد الجديد');
           setIsSubmitting(false);
           return;
        }

        const existingPartner = (settings.partners || []).find(p => p.name === trimmedName && p.type === 'مورد');
        if (existingPartner) {
           finalManufacturer = existingPartner.name;
        } else {
           finalManufacturer = trimmedName;
           if (saveNewSupplier) {
             const newPartner: import('../types').PartnerEntity = {
               id: `pt-${Date.now()}`,
               name: trimmedName,
               type: 'مورد',
               notes: 'تمت الإضافة من بطاقة الصنف',
             };
             const updatedSettings = {
               ...settings,
               partners: [...(settings.partners || []), newPartner]
             };
             await dataService.saveSettings(updatedSettings);
             setSettings(updatedSettings);
           }
        }
      }

      let code = selectedMaterial ? selectedMaterial.code : (data.code || dataService.generateItemCode(data.category));
      const isNew = !selectedMaterial;
      const itemId = selectedMaterial ? (selectedMaterial._originalId || selectedMaterial.id) : `mat-${Date.now()}`;
      const itemUnit = data.unit;
      
      let success = false;
      let payload: any = null;
      let retries = 0;
      
      while (!success && retries < 3) {
        payload = {
          id: itemId,
          code,
          name: data.name,
          category: data.category,
          unit: itemUnit,
          minimumStock: data.minimumStock,
          initialStock: isNew ? data.initialStock : (selectedMaterial?.initialStock || 0),
          currentStock: selectedMaterial ? (materials.find(m=>m.id === (selectedMaterial._originalId || selectedMaterial.id))?.currentStock || selectedMaterial.currentStock) : data.initialStock,
          warehouseStocks: selectedMaterial ? materials.find(m=>m.id === (selectedMaterial._originalId || selectedMaterial.id))?.warehouseStocks : undefined,
          storageLocation: data.storageLocation,
          notes: data.notes || '',
          productionDate: data.productionDate,
          expiryDate: data.expiryDate,
          hazardLevel: data.hazardLevel || '',
          manufacturer: finalManufacturer,
          createdAt: selectedMaterial ? selectedMaterial.createdAt : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          type: data.category,
        };

        try {
          if (isNew && data.initialStock > 0) {
            const initTx: import('../types').InventoryTransaction = {
              id: `tr-init-${itemId}`,
              date: new Date().toISOString().split('T')[0],
              itemType: (data.category?.includes('مبيد') || data.category?.includes('مبيدات')) ? 'مبيد' : 'مادة',
              itemCategory: data.category,
              itemId,
              itemCode: code,
              itemName: data.name,
              transactionType: 'افتتاحي',
              transferType: 'in',
              quantity: data.initialStock,
              unit: itemUnit,
              storehouse: data.storageLocation,
              stockBefore: 0,
              stockAfter: data.initialStock,
              executedBy: dataService.getCurrentUser().fullName || 'النظام',
              supplierOrReceiver: 'رصيد مخزني أولي (رصيد افتتاحي)',
              notes: 'تأسيس رصيد الصنف التلقائي عند التسجيل الأول للصنف في بطاقة البيانات',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await dataService.saveMaterialWithOpeningStock(payload as Material, initTx);
          } else {
            await dataService.saveMaterial(payload as Material);
          }
          success = true;
        } catch (err: any) {
          if (err.message === 'UNIQUE_CODE_COLLISION' && isNew) {
             code = dataService.generateItemCode(data.category);
             retries++;
          } else {
             throw err;
          }
        }
      }
      
      if (!success) {
         throw new Error('فشل توليد كود فريد بعد عدة محاولات، يرجى المحاولة مرة أخرى.');
      }

      setSuccessMessage(selectedMaterial ? 'تم تحديث بيانات الصنف بنجاح' : 'تم حفظ الصنف بنجاح، ويمكنك الآن إضافة صنف آخر أو إغلاق النافذة');
      
      if (selectedMaterial) {
        setOpenFormDialog(false);
      } else {
        setValue('name', '');
        setValue('code', dataService.generateItemCode(data.category));
        setValue('initialStock', 0);
        setValue('notes', '');
      }
      
      loadMaterials();
      
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err: any) {
      setErrorMessage(safeUserMessage(err, 'generic', { allowAppText: true, fallback: 'حدث خطأ أثناء حفظ الصنف' }));
    } finally {
      setIsSubmitting(false);
    }
  };

const handleOpenDeleteDialog = (item: Material) => {
    setMaterialToDelete(item);
    setOpenDeleteDialog(true);
  };

  const confirmDeleteMaterial = async () => {
    if (!materialToDelete) return;
    const actualId = materialToDelete._originalId || materialToDelete.id;
    const res = await dataService.deleteMaterial(actualId);
    setOpenDeleteDialog(false);
    if (res.success) {
      setSuccessMessage(res.message);
      setSelectedMaterialIds(prev => prev.filter(id => id !== materialToDelete.id));
      loadMaterials();
      setTimeout(() => setSuccessMessage(null), 4000);
    } else {
      setErrorMessage(presentResultMessage(res.message));
      setTimeout(() => setErrorMessage(null), 6000);
    }
  };

  const handleBulkExportPDF = async () => {
    try {
      setExportingPDF(true);
      const selectedItems = filteredMaterials.filter(m => selectedMaterialIds.includes(m.id));
      
      const titleHeader = 'كشف جرد الأصناف المنتقاة والمحددة مسبقاً';
      const filename = `كشف_الأصناف_المحددة_${new Date().toISOString().split('T')[0]}.pdf`;
      const headers = ['كود الصنف', 'اسم ومواصفات الصنف', 'التصنيف', 'الوحدة', 'الحد الأدنى الأمان', 'الرصيد الفعلي الحالي', 'مستودع التخزين والترتيب'];
      
      const rows = selectedItems.map(item => [
        item.code,
        item.name,
        item.category,
        item.unit,
        String(item.minimumStock),
        String(item.currentStock),
        getDisplayStorageLocation(item)
      ]);

      const alignments: ('right' | 'center' | 'left')[] = ['right', 'right', 'center', 'center', 'center', 'center', 'right'];


      const recordIds = selectedItems.map((item: any) => {
        const originalId = requireStableStringPart(item._originalId, 'originalId');
        if (typeof item.isSubRow !== 'boolean') throw new Error('isSubRow is not boolean');
        if (item.isSubRow) {
          const wh = requireStableStringPart(item.storageLocation, 'storageLocation');
          return JSON.stringify(['bulk_materials', originalId, 'warehouse', wh]);
        } else {
          return JSON.stringify(['bulk_materials', originalId, 'parent']);
        }
      });

      await exportToPDF({
        title: titleHeader,
        organizationName: settings.organizationName || 'المستودع البلدي العام',
        departmentName: settings.departmentName || 'قسم الصحة والبيئة ومكافحة الأوبئة',
        filename,
        orientation: 'portrait',
        metaFields: [
          { label: 'نوع التصدير:', value: 'تصدير جماعي مخصص لأصناف منتقاة' },
          { label: 'عدد العناصر المصدرة:', value: `${selectedItems.length} صنف مخزني` }
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

      setSuccessMessage(`تم تصدير الأصناف المحددة بنجاح إلى ملف PDF 📄`);
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch {

      setErrorMessage('حدث خطأ أثناء تصدير الأصناف إلى PDF');
      setTimeout(() => setErrorMessage(null), 5000);
    } finally {
      setExportingPDF(false);
    }
  };

  const handleBulkExportExcel = async () => {
    try {
      setExportingExcel(true);
      const selectedItems = filteredMaterials.filter(m => selectedMaterialIds.includes(m.id));
      
      const titleHeader = 'كشف جرد الأصناف المنتقاة والمحددة مسبقاً';
      const filename = `كشف_الأصناف_المحددة_${new Date().toISOString().split('T')[0]}.xlsx`;
      const headers = ['كود الصنف', 'اسم ومواصفات الصنف', 'التصنيف', 'الوحدة', 'الحد الأدنى الأمان', 'الرصيد الفعلي الحالي', 'مستودع التخزين والترتيب'];
      
      const rows = selectedItems.map(item => [
        item.code,
        item.name,
        item.category,
        item.unit,
        String(item.minimumStock),
        String(item.currentStock),
        getDisplayStorageLocation(item)
      ]);

      await exportToExcel({
        title: titleHeader,
        organizationName: settings.organizationName || 'المستودع البلدي العام',
        departmentName: settings.departmentName || 'قسم الصحة والبيئة ومكافحة الأوبئة',
        filename,
        metaFields: [
          { label: 'نوع التصدير:', value: 'تصدير جماعي مخصص لأصناف منتقاة' },
          { label: 'عدد العناصر المصدرة:', value: `${selectedItems.length} صنف مخزني` }
        ],
        headers,
        rows,
        signatures: [
          { role: settings.storekeeperRole || 'أمين المخزن', name: settings.storekeeperName || '', show: settings.showStorekeeperSignature !== false },
          { role: settings.systemManagerRole || 'مدير النظام', name: settings.systemManagerName || '', show: settings.showSystemManagerSignature !== false },
          { role: settings.healthDirectorRole || 'مدير صحة البيئة', name: settings.healthDirectorName || '', show: settings.showHealthDirectorSignature !== false }
        ]
      });

      setSuccessMessage(`تم تصدير الأصناف المحددة بنجاح إلى ملف Excel 🟢`);
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch {

      setErrorMessage('حدث خطأ أثناء تصدير الأصناف إلى Excel');
      setTimeout(() => setErrorMessage(null), 5000);
    } finally {
      setExportingExcel(false);
    }
  };

  const handleBulkDelete = () => {
    if (selectedMaterialIds.length === 0) {
      setErrorMessage('يرجى تحديد صنف واحد على الأقل لإجراء عملية الحذف الجماعي');
      setTimeout(() => setErrorMessage(null), 5000);
      return;
    }
    setOpenBulkDeleteDialog(true);
  };

  const confirmBulkDeleteMaterial = async () => {
    setOpenBulkDeleteDialog(false);
    let successCount = 0;
    let failMessages: string[] = [];

    const idsToDelete = Array.from(new Set(
      selectedMaterialIds.map(id => {
        const selected = filteredMaterials.find(m => m.id === id);
        return selected ? (selected._originalId || id) : id;
      })
    ));
    for (const id of idsToDelete) {
      const res = await dataService.deleteMaterial(id, true);
      if (res.success) {
        successCount++;
      } else {
        failMessages.push(presentResultMessage(res.message));
      }
    }

    if (successCount > 0) {
      setSuccessMessage(`تم حذف عدد ${successCount} أصناف بنجاح!`);
      setSelectedMaterialIds([]);
      loadMaterials();
      setTimeout(() => setSuccessMessage(null), 5000);
    }

    if (failMessages.length > 0) {
      setErrorMessage(`تعذر حذف بعض الأصناف: ${failMessages.join(', ')}`);
      setTimeout(() => setErrorMessage(null), 7000);
    }
  };

  // Sorting handlers
  
  // Search logic - supports pure numbers search seamlessly on item codes
  const filteredMaterials = buildMaterialWarehouseView(materials, selectedStorehouse, settings.storehouses).filter((item) => {
    const rawSearch = searchQuery.trim().toLowerCase();
    const itemDigits = item.code.replace(/\D/g, '');

    const matchesSearch = !rawSearch ? true : (
      item.name.toLowerCase().includes(rawSearch) ||
      item.code.toLowerCase().includes(rawSearch) ||
      (/^\d+$/.test(rawSearch) && itemDigits.includes(rawSearch)) ||
      (item.storageLocation && item.storageLocation.toLowerCase().includes(rawSearch))
    );

    const matchesCategory = categoryFilter === 'all' || item.category === categoryFilter;
    const matchesStorehouse = selectedStorehouse === 'all' || item.storageLocation === selectedStorehouse;

    let matchesStock = true;
    if (stockStatusFilter === 'critical') {
      matchesStock = item.currentStock <= item.minimumStock;
    } else if (stockStatusFilter === 'normal') {
      matchesStock = item.currentStock > item.minimumStock;
    }

    return matchesSearch && matchesCategory && matchesStock && matchesStorehouse;
  });


  const handleExpandAll = () => {
    const newExpanded: Record<string, boolean> = {};
    filteredMaterials.forEach(m => {
      if (m.hasSubRows) {
        newExpanded[m.id] = true;
      }
    });
    setExpandedRows(newExpanded);
  };

  const handleCollapseAll = () => {
    setExpandedRows({});
  };

  const sortedMaterials = [...filteredMaterials].sort((a, b) => {
    if (orderBy === 'code') {
      const numA = parseInt(a.code.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.code.replace(/\D/g, ''), 10) || 0;
      if (numA !== numB) {
        return order === 'asc' ? numA - numB : numB - numA;
      }
      return order === 'asc' ? a.code.localeCompare(b.code) : b.code.localeCompare(a.code);
    }

    let aValue = a[orderBy];
    let bValue = b[orderBy];

    if (typeof aValue === 'string') {
      aValue = aValue.toLowerCase();
      bValue = (bValue as string).toLowerCase();
    }

    if (aValue < bValue) {
      return order === 'asc' ? -1 : 1;
    }
    if (aValue > bValue) {
      return order === 'asc' ? 1 : -1;
    }
    return 0;
  });

  const visibleMaterials = sortedMaterials.filter(item => {
    if (item.isSubRow && item.parentId) {
      return expandedRows[item.parentId];
    }
    return true;
  });

  const paginatedMaterials = visibleMaterials.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage
  );

  return (
    <Box sx={{ p: 1, direction: 'rtl' }}>
      {/* Page Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 4, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#1e293b' }}>
            المستودع وإدارة أصناف المخزون
          </Typography>
          <Typography variant="body2" sx={{ color: '#64748b', mt: 0.5 }}>
            إدخال وفحص جميع أصناف المخازن من لوازم ومبيدات وآلات مع كود توليد آلي متناسق
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
          {dataService.hasPermission('materials_stocktake') && (
            <Button
              id="perform-physical-stocktake"
              variant="outlined"
              startIcon={<AssessmentIcon sx={{ ml: 1, mr: -0.5 }} />}
              onClick={handleOpenStocktakeDialog}
              sx={{ 
                borderColor: '#0f766e', 
                color: '#0f766e',
                borderRadius: '12px', 
                px: 3, 
                py: 1.2,
                fontWeight: 'bold',
                '&:hover': { bgcolor: 'rgba(15, 118, 110, 0.08)', borderColor: '#0d5f58' }
              }}
            >
              إجراء الجرد الفعلي السنوي والتسوية
            </Button>
          )}
          {dataService.hasPermission('materials_create') && (
            <Button
              variant="contained"
              startIcon={<AddIcon sx={{ ml: 1, mr: -0.5 }} />}
              onClick={handleOpenAddDialog}
              sx={{ 
                bgcolor: '#007ab7', 
                borderRadius: '12px', 
                px: 3, 
                py: 1.2,
                fontWeight: 'bold',
                boxShadow: '0 4px 12px rgba(0, 122, 183, 0.2)',
                '&:hover': { bgcolor: '#006293' }
              }}
            >
              بطاقة صنف جديد
            </Button>
          )}
        </Box>
      </Box>

      {/* Alert toast banners */}
      <NotificationToast open={!!successMessage} message={successMessage} severity="success" onClose={() => setSuccessMessage('')} />
      <NotificationToast open={!!errorMessage} message={errorMessage} severity="error" onClose={() => setErrorMessage('')} />

      {/* Search and Filters panel */}
      <Paper sx={{ p: 2.5, mb: 3 }}>
        <Grid container spacing={2} sx={{ alignItems: 'center' }}>
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

          <Grid size={{ xs: 12, md: 3 }}>
            <TextField
              fullWidth
              placeholder="ابحث بالاسم، الكود (بما فيه أرقام فقط)..."
              size="small"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: <SearchIcon sx={{ color: '#94a3b8', ml: 1 }} />,
                  style: { borderRadius: '10px' }
                }
              }}
            />
          </Grid>
          <Grid size={{ xs: 12, sm: 6, md: 2 }}>
            <TextField
              select
              fullWidth
              size="small"
              label="التصنيف"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              slotProps={{ input: { style: { borderRadius: '10px' } } }}
            >
              <MenuItem value="all">{renderOption("كل التصنيفات العامة")}</MenuItem>
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
              label="حالة المخزن"
              value={stockStatusFilter}
              onChange={(e) => setStockStatusFilter(e.target.value)}
              slotProps={{ input: { style: { borderRadius: '10px' } } }}
            >
              <MenuItem value="all">{renderOption("الكل (الأرصدة والمستنفذة)")}</MenuItem>
              <MenuItem value="normal">{renderOption("متوفر بالمستودعات")}</MenuItem>
              <MenuItem value="critical">{renderOption("مستنفذ / تحت حد الأمان")}</MenuItem>
            </TextField>
          </Grid>
                    <Grid size={{ xs: 12, md: 3 }} sx={{ display: 'flex', gap: 1.5, alignSelf: 'center', justifyContent: 'flex-end' }}>
            <Tooltip title="تفريغ كافة فلاتر البحث وإعادتها للافتراضي">
              <Button
                variant="outlined"
                color="secondary"
                onClick={handleClearFilters}
                disabled={!searchQuery && categoryFilter === 'all' && stockStatusFilter === 'all'}
                startIcon={<FilterAltOffIcon sx={{ ml: 1, mr: -0.5 }} />}
                sx={{ borderRadius: '10px', px: 2, fontFamily: '"Cairo", sans-serif', width: '100%' }}
              >
                مسح الفلاتر
              </Button>
            </Tooltip>
          </Grid>
          <Grid size={12}>
            <Divider sx={{ my: 1 }} />
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#64748b', fontFamily: '"Cairo", sans-serif', textAlign: 'end', mt: 1 }}>
              الأصناف المطابقة: {filteredMaterials.filter(m => !m.isSubRow).length}
            </Typography>
          </Grid>
        </Grid>
      </Paper>

      {/* Bulk actions banner */}
      {selectedMaterialIds.length > 0 && (
        <Paper
          id="bulk-actions-materials-bar"
          sx={{
            p: 2,
            mb: 2,
            borderRadius: '12px',
            bgcolor: '#eff6ff',
            border: '1px solid #bfdbfe',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            boxShadow: '0 2px 8px rgba(37, 99, 235, 0.08)'
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body1" sx={{ color: '#1e3a8a', fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>
              تم تحديد ({selectedMaterialIds.length}) من الأصناف
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <Button
              id="bulk-export-materials-pdf"
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
              id="bulk-export-materials-excel"
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
            {dataService.hasPermission('materials_delete') && (
              <Button
                id="bulk-delete-materials"
                variant="contained"
                size="small"
                onClick={handleBulkDelete}
                disabled={selectedMaterialIds.length === 0}
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
                حذف الأصناف المحددة 🗑️
              </Button>
            )}
          </Box>
        </Paper>
      )}

      {/* Expand/Collapse All and Stats Bar */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, px: 0.5, flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {filteredMaterials.some(m => m.hasSubRows) && (
            <>
              <Button
                id="expand-all-materials"
                size="small"
                variant="outlined"
                startIcon={<UnfoldMoreIcon sx={{ ml: 0.5, mr: -0.5 }} />}
                onClick={handleExpandAll}
                sx={{ 
                  borderColor: '#0f766e', 
                  color: '#0f766e', 
                  borderRadius: '8px', 
                  fontWeight: 'bold', 
                  fontSize: '0.8rem',
                  '&:hover': { bgcolor: '#f0fdf4', borderColor: '#0d5f58' }
                }}
              >
                توسيع الكل
              </Button>
              <Button
                id="collapse-all-materials"
                size="small"
                variant="outlined"
                startIcon={<UnfoldLessIcon sx={{ ml: 0.5, mr: -0.5 }} />}
                onClick={handleCollapseAll}
                sx={{ 
                  borderColor: '#cbd5e1', 
                  color: '#64748b', 
                  borderRadius: '8px', 
                  fontWeight: 'bold', 
                  fontSize: '0.8rem',
                  '&:hover': { bgcolor: '#f8fafc', borderColor: '#94a3b8' }
                }}
              >
                طي الكل
              </Button>
            </>
          )}
        </Box>
        <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#64748b', fontFamily: '"Cairo", sans-serif' }}>
          عدد السجلات المعروضة: {visibleMaterials.length}
        </Typography>
      </Box>

      <TableContainer component={Paper} sx={{ }}>
        <Table sx={{ minWidth: 650 }}>
          <TableHead>
            <TableRow sx={{ bgcolor: '#f8fafc' }}>
              <TableCell padding="checkbox">
                <Checkbox
                  id="select-all-materials"
                  indeterminate={selectedMaterialIds.length > 0 && selectedMaterialIds.length < filteredMaterials.length}
                  checked={filteredMaterials.length > 0 && selectedMaterialIds.length === filteredMaterials.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedMaterialIds(filteredMaterials.filter(m => !m.isSubRow).map(m => m.id));
                    } else {
                      setSelectedMaterialIds([]);
                    }
                  }}
                />
              </TableCell>
              <TableCell sx={{ fontWeight: 'bold', color: '#475569' }}>كود الصنف</TableCell>
              <TableCell sx={{ fontWeight: 'bold', color: '#475569' }}>اسم الصنف</TableCell>
              <TableCell sx={{ fontWeight: 'bold', color: '#475569' }}>التصنيف</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', color: '#475569' }}>الوحدة الافتراضية</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', color: '#475569' }}>حد الأمان</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', color: '#475569' }}>الرصيد المتاح</TableCell>
              <TableCell sx={{ fontWeight: 'bold', color: '#475569' }}>مستودع التخزين</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', color: '#475569' }}>حالة المخزن</TableCell>
              <TableCell align="center" sx={{ fontWeight: 'bold', color: '#475569', position: 'sticky', right: 0, zIndex: 2, bgcolor: 'inherit', boxShadow: '2px 0 5px -2px rgba(0,0,0,0.1)', borderLeft: '1px solid #e2e8f0' }}>الإجراءات</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {paginatedMaterials.length > 0 ? (
              paginatedMaterials.map((item, idx) => {
                const isCritical = item.currentStock <= item.minimumStock;
                return (
                  <TableRow 
                    key={`mat-row-${item.id}-${idx}`}
                    sx={{ 
                      bgcolor: item.isSubRow ? '#f8fafc' : (isCritical ? '#fef2f2' : '#ffffff'),
                      '&:hover': { bgcolor: item.isSubRow ? '#f1f5f9' : '#f8fafc' },
                      transition: 'background-color 0.15s ease',
                      borderBottom: item.isSubRow ? '1px dashed #cbd5e1' : '1px solid #e2e8f0'
                    }}
                  >
                    <TableCell padding="checkbox">
                      {!item.isSubRow ? (
                        <Checkbox
                          id={`select-material-${item.id}`}
                          checked={selectedMaterialIds.includes(item.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedMaterialIds(prev => [...prev, item.id]);
                            } else {
                              setSelectedMaterialIds(prev => prev.filter(id => id !== item.id));
                            }
                          }}
                        />
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        {/* Dedicated 28px width icon container for alignment */}
                        <Box sx={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {item.hasSubRows ? (
                            <IconButton 
                              size="small" 
                              onClick={(e) => { e.stopPropagation(); setExpandedRows(prev => ({...prev, [item.id]: !prev[item.id]})); }}
                              sx={{ 
                                p: 0.3, 
                                bgcolor: expandedRows[item.id] ? '#e0f2fe' : '#f1f5f9', 
                                color: '#0284c7',
                                '&:hover': { bgcolor: '#bae6fd' } 
                              }}
                            >
                              {expandedRows[item.id] ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
                            </IconButton>
                          ) : item.isSubRow ? (
                            <SubdirectoryArrowLeftIcon sx={{ fontSize: 16, color: '#0284c7', transform: 'scaleX(-1)' }} />
                          ) : null}
                        </Box>
                        <Typography 
                          component="span" 
                          sx={{ 
                            fontFamily: 'monospace', 
                            fontWeight: item.isSubRow ? 600 : 700, 
                            fontSize: item.isSubRow ? '0.8rem' : '0.875rem',
                            color: item.isSubRow ? '#475569' : '#007ab7'
                          }}
                        >
                          {item.code}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography 
                          sx={{ 
                            fontWeight: item.isSubRow ? 600 : 700, 
                            fontSize: item.isSubRow ? '0.825rem' : '0.9rem',
                            color: item.isSubRow ? '#334155' : '#1e293b'
                          }}
                        >
                          {item.name}
                        </Typography>
                        {item.isSubRow && (
                          <Chip 
                            label="مفرع حسب المستودع" 
                            size="small" 
                            sx={{ 
                              fontSize: '10px', 
                              height: '18px', 
                              bgcolor: '#e0f2fe', 
                              color: '#0369a1', 
                              fontWeight: 'bold',
                              fontFamily: '"Cairo", sans-serif' 
                            }} 
                          />
                        )}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Chip 
                        label={item.category} 
                        size="small" 
                        sx={{ 
                          bgcolor: item.isSubRow ? '#f1f5f9' : '#e2e8f0', 
                          color: item.isSubRow ? '#64748b' : '#334155', 
                          fontWeight: 600,
                          fontSize: item.isSubRow ? '11px' : '12px'
                        }} 
                      />
                    </TableCell>
                    <TableCell align="center" sx={{ fontSize: item.isSubRow ? '0.8rem' : '0.875rem', color: item.isSubRow ? '#64748b' : 'inherit' }}>
                      {item.unit}
                    </TableCell>
                    <TableCell align="center" sx={{ fontSize: item.isSubRow ? '0.8rem' : '0.875rem', color: '#64748b' }}>
                      {item.minimumStock}
                    </TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold', fontSize: item.isSubRow ? '0.875rem' : '1rem', color: isCritical ? '#ef4444' : '#059669' }}>
                      {item.currentStock}
                    </TableCell>
                    <TableCell>
                      <Typography sx={{ fontSize: item.isSubRow ? '0.8rem' : '0.85rem', color: item.isSubRow ? '#0284c7' : '#64748b', fontWeight: item.isSubRow ? 600 : 400 }}>
                        {getDisplayStorageLocation(item)}
                      </Typography>
                    </TableCell>
                    <TableCell align="center">
                      {isCritical ? (
                        <Chip label="مستنفذ / منخفض" color="error" size="small" sx={{ fontWeight: 'bold', fontSize: item.isSubRow ? '10px' : '11px' }} />
                      ) : (
                        <Chip label="متوفر" color="success" variant="outlined" size="small" sx={{ fontWeight: 'bold', fontSize: item.isSubRow ? '10px' : '11px' }} />
                      )}
                    </TableCell>
                    <TableCell align="center" sx={{ position: 'sticky', right: 0, zIndex: 1, bgcolor: 'inherit', boxShadow: '2px 0 5px -2px rgba(0,0,0,0.1)', borderLeft: '1px solid #e2e8f0' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1 }}>
                        <Tooltip title="عرض التفاصيل الكاملة">
                          <IconButton size="small" color="info" onClick={() => handleOpenDetailsDialog(item)}>
                            <VisibilityIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        {!item.isSubRow && dataService.hasPermission('materials_edit') && (
                          <Tooltip title="تعديل بيانات الصنف">
                            <IconButton size="small" color="primary" onClick={() => handleOpenEditDialog(item)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                        {!item.isSubRow && dataService.hasPermission('materials_delete') && (
                          <Tooltip title="حذف نهائي">
                            <IconButton size="small" color="error" onClick={() => handleOpenDeleteDialog(item)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Box>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <EmptyTableState colSpan={10} message="لا توجد أصناف تطابق تصفية البحث الحالية." minHeight={150} />
            )}
          </TableBody>
        </Table>
        <TablePagination
          rowsPerPageOptions={[5, 10, 25]}
          component="div"
          count={visibleMaterials.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(_, newPage) => setPage(newPage)}
          onRowsPerPageChange={(e) => {
            setRowsPerPage(parseInt(e.target.value, 10));
            setPage(0);
          }}
          labelRowsPerPage="عدد الصفوف:"
          labelDisplayedRows={({ from, to, count }) => `${from}-${to} من ${count}`}
        />
      </TableContainer>

      {/* CRUD dialog to add/edit material */}
      <Dialog 
        open={openFormDialog} 
        onClose={() => setOpenFormDialog(false)} 
        maxWidth="md" 
        fullWidth
        slotProps={{ paper: { sx: { py: 1, direction: 'rtl' } } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#1e293b' }}>
          {selectedMaterial ? `تعديل الصنف الحالي: ${selectedMaterial.name}` : 'تسجيل بطاقة صنف جديدة'}
        </DialogTitle>
        <form onSubmit={handleSubmit(onSubmitForm)}>
          <DialogContent>
            <Grid container spacing={3}>
              {/* 1. Category select */}
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  select
                  fullWidth
                  label="تصنيف الصنف"
                  {...register('category')}
                  value={watchCategory || ''}
                  error={!!errors.category}
                  helperText={errors.category?.message}
                  defaultValue=""
                >
                  {settings.categories.map((cat) => (
                    <MenuItem key={cat.name} value={cat.name}>{renderOption(cat.name, "category")}</MenuItem>
                  ))}
                </TextField>
              </Grid>

              {/* 2. Readonly Autogenerated Code */}
              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  label="كود الصنف الآلي (توليد تلقائي حسب التصنيف)"
                  {...register('code')}
                  slotProps={{ input: { readOnly: true } }}
                  sx={{ 
                    bgcolor: '#f8fafc',
                    '& .MuiInputBase-root': {
                      pointerEvents: 'none',
                      color: '#64748b'
                    },
                    '& .MuiOutlinedInput-notchedOutline': {
                      borderColor: '#e2e8f0 !important'
                    }
                  }}
                  helperText="يتم حسابه تلقائياً بناءً على الحروف والمدى المدخل بالتصنيف في الإعدادات"
                />
              </Grid>

              {/* 3. Name */}
              <Grid size={12}>
                <TextField
                  fullWidth
                  label="اسم الصنف بالكامل"
                  placeholder="مثال: دلتامثرين 2.5% مستحلب مركز"
                  {...register('name')}
                  error={!!errors.name}
                  helperText={errors.name?.message}
                />
              </Grid>

              {/* 4. Initial Stock */}
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  fullWidth
                  type="number"
                  label="الرصيد الإبتدائي الافتتاحي بالمستودع"
                  placeholder="مثال: 100"
                  disabled={!!selectedMaterial}
                  {...register('initialStock')}
                  onFocus={(e) => e.target.select()}
                  error={!!errors.initialStock}
                  helperText={selectedMaterial ? "الرصيد الابتدائي مسجل مسبقاً" : errors.initialStock?.message || "سيقوم النظام بتوريد رصيد بداية أوتوماتيكي"}
                />
              </Grid>

            {watchInitialStock > 0 && (
              <Grid size={12}>
                <Box sx={{ p: 2, bgcolor: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '10px', width: '100%' }}>
                  <Typography variant="body2" sx={{ color: '#0284c7', fontWeight: 'bold', mb: 0.5 }}>
                    بيان الرصيد الافتتاحي
                  </Typography>
                  <Typography variant="body1" sx={{ color: '#0369a1' }}>
                    رصيد مخزني أولي (رصيد افتتاحي)
                  </Typography>
                  <Typography variant="caption" sx={{ color: '#0ea5e9', display: 'block', mt: 0.5 }}>
                    يتم اعتماد هذا البيان تلقائياً عند وجود رصيد افتتاحي
                  </Typography>
                </Box>
              </Grid>
            )}

              {/* 5. Minimum Stock */}
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  fullWidth
                  type="number"
                  label="حد الأمان الأدنى"
                  placeholder="مثال: 10"
                  {...register('minimumStock', { valueAsNumber: true })}
                  onFocus={(e) => e.target.select()}
                  error={!!errors.minimumStock}
                  helperText={errors.minimumStock?.message || "كمية التنبيه للاستنفاد"}
                />
              </Grid>

              {/* 5.1 Unit Of Measurement */}
              <Grid size={{ xs: 12, sm: 4 }}>
                <TextField
                  select
                  fullWidth
                  label="وحدة القياس"
                  {...register('unit')}
                  value={watch('unit') || ''}
                  error={!!errors.unit}
                  helperText={errors.unit?.message || 'اختر وحدة القياس'}
                  defaultValue=""
                >
                  {(settings.units || ['لتر', 'كجم', 'قطعة', 'علبة', 'جالون']).map((u) => (
                    <MenuItem key={u} value={u}>{renderOption(u, "unit")}</MenuItem>
                  ))}
                </TextField>
              </Grid>

              {/* 6. Storage Location / Warehouse */}
              <Grid size={12}>
                <TextField
                  select
                  fullWidth
                  label="مستودع وموقع التخزين الرئيسي"
                  {...register('storageLocation')}
                  value={watch('storageLocation') || ''}
                  error={!!errors.storageLocation}
                  helperText={errors.storageLocation?.message || 'اختر المخزن المسؤول عن حفظ الصنف'}
                  defaultValue=""
                >
                  {(settings.storehouses || []).map((store) => (
                    <MenuItem key={store} value={store}>{renderOption(store, "storehouse")}</MenuItem>
                  ))}
                </TextField>
              </Grid>

              {/* Optional Fields */}
              <Grid size={12}>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: '#64748b', mb: 1, mt: 1 }}>بيانات الجودة والسلامة (اختياري)</Typography>
              </Grid>

              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  type="date"
                  label="تاريخ الإنتاج"
                  slotProps={{ inputLabel: { shrink: true } }}
                  {...register('productionDate')}
                  sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
                />
              </Grid>

              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  fullWidth
                  type="date"
                  label="تاريخ الإنتهاء"
                  slotProps={{ inputLabel: { shrink: true } }}
                  {...register('expiryDate')}
                  sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
                />
              </Grid>

              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  select
                  fullWidth
                  label="الشركة الصانعة / المورد"
                  {...register('manufacturer')}
                  value={watchManufacturer || 'جهة غير محددة'}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'new_supplier...') {
                      setValue('manufacturer', 'new_supplier...');
                      setIsNewSupplier(true);
                    } else {
                      setValue('manufacturer', val);
                      setIsNewSupplier(false);
                      setNewSupplierName('');
                      setSaveNewSupplier(false);
                    }
                  }}
                  sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
                >
                  <MenuItem value="جهة غير محددة">{renderOption("جهة غير محددة", "partner")}</MenuItem>
                  {(settings.partners || []).filter(p => p.type === 'مورد').map((partner) => (
                    <MenuItem key={partner.id} value={partner.name}>{renderOption(partner.name, "partner")}</MenuItem>
                  ))}
                  <MenuItem value="new_supplier...">{renderOption("مورد جديد...")}</MenuItem>
                </TextField>

                {watchManufacturer === 'new_supplier...' && (
                  <Box sx={{ mt: 2, p: 2, bgcolor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                    <TextField
                      fullWidth
                      label="اسم المورد الجديد"
                      value={newSupplierName}
                      onChange={(e) => setNewSupplierName(e.target.value)}
                      size="small"
                    />
                    <Box sx={{ display: 'flex', alignItems: 'center', mt: 1 }}>
                      <input 
                        type="checkbox" 
                        id="saveSupplier"
                        checked={saveNewSupplier}
                        onChange={(e) => setSaveNewSupplier(e.target.checked)}
                        style={{ marginLeft: '8px' }}
                      />
                      <label htmlFor="saveSupplier" style={{ fontSize: '14px', color: '#64748b', cursor: 'pointer' }}>حفظ هذا المورد في الإعدادات</label>
                    </Box>
                  </Box>
                )}
              </Grid>

              <Grid size={{ xs: 12, sm: 6 }}>
                <TextField
                  select
                  fullWidth
                  label="درجة الخطورة"
                  {...register('hazardLevel')}
                  value={watch('hazardLevel') || ''}
                  defaultValue=""
                  sx={{ '& .MuiOutlinedInput-root': { borderRadius: '10px' } }}
                >
                  <MenuItem value="">{renderOption("غير محدد")}</MenuItem>
                                                      <MenuItem value="منخفض">{renderOption("منخفض")}</MenuItem>
                  <MenuItem value="متوسط">{renderOption("متوسط")}</MenuItem>
                  <MenuItem value="مرتفع">{renderOption("مرتفع")}</MenuItem>
                </TextField>
              </Grid>

              {/* 7. Notes */}
              <Grid size={12}>
                <TextField
                  fullWidth
                  multiline
                  rows={3}
                  label="ملاحظات تفصيلية بطاقة صنف"
                  placeholder="اكتب أي مواصفات فنية إضافية، تعليمات سلامة مخزنية، أو ملاحظات أخرى..."
                  {...register('notes')}
                />
              </Grid>
            </Grid>
          </DialogContent>
          <DialogActions sx={{ p: 3, justifyContent: 'flex-start', gap: 2 }}>
            <Button
              type="submit"
              variant="contained"
              disabled={isSubmitting}
              sx={{ bgcolor: '#007ab7', px: 4, py: 1.1, fontWeight: 'bold', borderRadius: '10px', '&:hover': { bgcolor: '#006293' } }}
            >
              {isSubmitting ? 'جاري الحفظ...' : (selectedMaterial ? 'تحديث' : 'إضافة')}
            </Button>
            <Button 
              variant="outlined" 
              onClick={() => setOpenFormDialog(false)}
              sx={{ color: '#475569', borderColor: '#cbd5e1', px: 3, py: 1.1, fontWeight: 'bold', borderRadius: '10px', '&:hover': { borderColor: '#94a3b8' } }}
            >
              إغلاق
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog 
        open={openDeleteDialog} 
        onClose={() => setOpenDeleteDialog(false)}
        slotProps={{ paper: { sx: { p: 1, direction: 'rtl' } } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#ef4444' }}>تحذير سلامة مخزنية!</DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ color: '#1e293b', mb: 2 }}>
            هل أنت متأكد تماماً من رغبتك في حذف الصنف: <strong>{materialToDelete?.name}</strong> من السجلات نهائياً؟
          </Typography>
          <Typography variant="body2" sx={{ color: '#ef4444', bgcolor: '#fef2f2', p: 1.5, borderRadius: '8px', border: '1px solid #fee2e2' }}>
            تنبيه: لا يمكن حذف الصنف في حال تواجد له أي حركات مخزنية تاريخية 'وارد' أو 'صادر' حفاظاً على صحة الموازنات المحاسبية العامة ومراقبة الفقد.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 3, justifyContent: 'flex-start', gap: 2 }}>
          <Button 
            variant="contained" 
            color="error" 
            onClick={confirmDeleteMaterial}
            sx={{ fontWeight: 'bold', px: 3, borderRadius: '10px' }}
          >
            تأكيد الحذف النهائي
          </Button>
          <Button 
            variant="outlined" 
            onClick={() => setOpenDeleteDialog(false)}
            sx={{ color: '#475569', borderColor: '#cbd5e1', px: 3, borderRadius: '10px' }}
          >
            إلغاء التراجع
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <Dialog 
        open={openBulkDeleteDialog} 
        onClose={() => setOpenBulkDeleteDialog(false)}
        slotProps={{ paper: { sx: { p: 1, direction: 'rtl' } } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#ef4444' }}>تحذير حذف جماعي!</DialogTitle>
        <DialogContent>
          <Typography variant="body1" sx={{ color: '#1e293b', mb: 2 }}>
            هل أنت متأكد من حذف <strong>{selectedMaterialIds.length}</strong> من الأصناف المحددة نهائياً؟
          </Typography>
          <Typography variant="body2" sx={{ color: '#ef4444', bgcolor: '#fef2f2', p: 1.5, borderRadius: '8px', border: '1px solid #fee2e2' }}>
            تنبيه: سيتم أيضاً حذف كافة الحركات المخزنية المسجلة على هذه الأصناف تلقائياً وبشكل كامل. لا يمكن التراجع عن هذه الخطوة نهائياً!
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 3, justifyContent: 'flex-start', gap: 2 }}>
          <Button 
            variant="contained" 
            color="error" 
            onClick={confirmBulkDeleteMaterial}
            sx={{ fontWeight: 'bold', px: 3, borderRadius: '10px' }}
          >
            نعم، احذف الأصناف المحددة وحركاتها
          </Button>
          <Button 
            variant="outlined" 
            onClick={() => setOpenBulkDeleteDialog(false)}
            sx={{ color: '#475569', borderColor: '#cbd5e1', px: 3, borderRadius: '10px' }}
          >
            إلغاء
          </Button>
        </DialogActions>
      </Dialog>

      {/* Material/Item Details Dialog */}
      <Dialog 
        open={openDetailsDialog} 
        onClose={() => setOpenDetailsDialog(false)}
        maxWidth="sm"
        fullWidth
        slotProps={{ paper: { sx: { p: 1, direction: 'rtl' } } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>
          بطاقة تفاصيل الصنف الفنية
        </DialogTitle>
        <DialogContent sx={{ mt: 2 }}>
          {detailsMaterial && (
            <Grid container spacing={2}>
              <Grid size={6}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>كود التخصيص</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#007ab7', fontFamily: 'monospace' }}>{detailsMaterial.code}</Typography>
              </Grid>
              <Grid size={6}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>اسم الصنف</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold' }}>{detailsMaterial.name}</Typography>
              </Grid>
              <Grid size={6}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>التصنيف والجهة</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold' }}>{detailsMaterial.category}</Typography>
              </Grid>
              <Grid size={6}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>وحدة المعاملات المخزنية</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold' }}>{detailsMaterial.unit}</Typography>
              </Grid>
              <Grid size={6}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>الرصيد المتاح حالياً</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#059669', fontSize: '1.2rem' }}>{detailsMaterial.currentStock}</Typography>
              </Grid>
              <Grid size={6}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>حد السلامة المخزنية</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'bold' }}>{detailsMaterial.minimumStock}</Typography>
              </Grid>
              <Grid size={12}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>موقع التخزين والمستودع</Typography>
                <Typography variant="body1" sx={{ fontWeight: 'medium' }}>{getDisplayStorageLocation(detailsMaterial)}</Typography>
              </Grid>
              <Grid size={12}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>تعليمات سلامة وملاحظات إدارية</Typography>
                <Typography variant="body1" sx={{ bgcolor: '#f8fafc', p: 1.5, borderRadius: '8px', minHeight: '60px' }}>
                  {detailsMaterial.notes || 'لا يوجد ملاحظات مسجلة على هذا الصنف.'}
                </Typography>
              </Grid>

              {/* Optional Fields Readonly */}
              {(detailsMaterial.productionDate || detailsMaterial.expiryDate || detailsMaterial.manufacturer || detailsMaterial.hazardLevel) && (
                <>
                  <Grid size={12}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: '#64748b', mb: 1, mt: 1, borderTop: '1px solid #e2e8f0', pt: 2 }}>بيانات الجودة والسلامة:</Typography>
                  </Grid>
                  {detailsMaterial.productionDate && (
                    <Grid size={6}>
                      <Typography variant="caption" sx={{ color: '#64748b' }}>تاريخ الإنتاج</Typography>
                      <Typography variant="body1" sx={{ fontWeight: 'medium' }}>{detailsMaterial.productionDate}</Typography>
                    </Grid>
                  )}
                  {detailsMaterial.expiryDate && (
                    <Grid size={6}>
                      <Typography variant="caption" sx={{ color: '#64748b' }}>تاريخ الإنتهاء</Typography>
                      <Typography variant="body1" sx={{ fontWeight: 'medium' }}>{detailsMaterial.expiryDate}</Typography>
                    </Grid>
                  )}
                  {detailsMaterial.manufacturer && (
                    <Grid size={6}>
                      <Typography variant="caption" sx={{ color: '#64748b' }}>الشركة الصانعة الموردة</Typography>
                      <Typography variant="body1" sx={{ fontWeight: 'medium' }}>{detailsMaterial.manufacturer}</Typography>
                    </Grid>
                  )}
                  {detailsMaterial.hazardLevel && (
                    <Grid size={6}>
                      <Typography variant="caption" sx={{ color: '#64748b' }}>تصنيف خطورة الصنف</Typography>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Box sx={{ 
                          width: 12, height: 12, borderRadius: '50%', 
                          bgcolor: detailsMaterial.hazardLevel === 'منخفض' ? '#22c55e' : (detailsMaterial.hazardLevel === 'متوسط' ? '#f97316' : '#ef4444') 
                        }} />
                        <Typography variant="body1" sx={{ fontWeight: 'bold', color: detailsMaterial.hazardLevel === 'منخفض' ? '#15803d' : (detailsMaterial.hazardLevel === 'متوسط' ? '#c2410c' : '#b91c1c') }}>
                          {detailsMaterial.hazardLevel} الخطورة
                        </Typography>
                      </Box>
                    </Grid>
                  )}
                </>
              )}
            </Grid>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2.5 }}>
          <Button 
            variant="contained" 
            onClick={() => setOpenDetailsDialog(false)}
            sx={{ bgcolor: '#475569', borderRadius: '10px', px: 3, '&:hover': { bgcolor: '#334155' } }}
          >
            إغلاق نافذة العرض
          </Button>
        </DialogActions>
      </Dialog>

      {/* Physical Stocktake & Reconciliation Dialog */}
      <Dialog 
        open={openStocktakeDialog} 
        onClose={() => setOpenStocktakeDialog(false)}
        maxWidth="lg"
        fullWidth
        slotProps={{ paper: { sx: { p: 1, direction: 'rtl' } } }}
      >
        <DialogTitle sx={{ fontWeight: 'bold', color: '#0f766e', borderBottom: '1px solid #f1f5f9' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#0f766e', fontFamily: '"Cairo", sans-serif' }}>
              تسجيل الجرد الفعلي السنوي وتعديل مطابقة أرصدة المستودعات
            </Typography>
            <Chip 
              label={selectedStorehouse !== 'all' ? `مستودع المراجعة: ${selectedStorehouse}` : 'مراجعة جميع المستودعات تفصيلياً'} 
              color="primary" 
              variant="outlined"
              size="small"
              sx={{ fontWeight: 'bold' }}
            />

          </Box>
        </DialogTitle>
        <DialogContent sx={{ mt: 2, maxHeight: '60vh', overflowY: 'auto' }}>
          <Alert severity="info" sx={{ mb: 2, fontFamily: '"Cairo", sans-serif' }}>
            أهلية الواجهة: materials_stocktake. التأثير السحابي يتطلب transactions_create وفق قواعد Firestore — materials_stocktake ليست سلطة سحابية مستقلة (P10-POL-1).
          </Alert>
          {!dataService.hasPermission('transactions_create') && (
            <Alert severity="warning" sx={{ mb: 2, fontFamily: '"Cairo", sans-serif' }}>
              حسابك لا يملك transactions_create؛ لن تُقبل تسويات الجرد على الخادم حتى تُمنح هذه الصلاحية.
            </Alert>
          )}
          <Typography variant="body2" sx={{ color: '#475569', mb: 3 }}>
            تتيح لك هذه الواجهة مطابقة كميات النظام الدفترية مع الكميات المقاسة فعلياً على أرض الواقع في المستودعات وتصحيحها بضغطة زر. يقوم النظام آلياً بتسجيل حركات تسوية جرد وارد/صادر بالفرق لكل صنف في مستودعه المحدد.
          </Typography>

          <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: '12px', mb: 3 }}>
            <Table size="small">
              <TableHead>
            <TableRow sx={{ bgcolor: '#f8fafc' }}>
                  <TableCell sx={{ fontWeight: 'bold', color: '#475569', py: 1.5 }}>كود الصنف</TableCell>
                  <TableCell sx={{ fontWeight: 'bold', color: '#475569' }}>اسم الصنف</TableCell>
                  <TableCell sx={{ fontWeight: 'bold', color: '#0284c7' }}>المستودع المستهدف</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 'bold', color: '#475569' }}>الرصيد الدفتري الحالي</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 'bold', color: '#475569', width: '180px' }}>الرصيد الفعلي المقاس 📥</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 'bold', color: '#475569', width: '140px' }}>الفارق / التسوية</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {stocktakeList.map((row, idx) => {
                  const physicalVal = physicalCounts[row.rowKey] ?? '';
                  const physicalNum = parseFloat(physicalVal) || 0;
                  const systemStock = row.systemStock;
                  const diff = physicalVal === '' ? 0 : (physicalNum - systemStock);

                  return (
                    <TableRow key={`stocktake-${row.rowKey}-${idx}`} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: '#64748b' }}><span dir="ltr">{row.code}</span></TableCell>
                      <TableCell sx={{ fontWeight: 'bold', color: '#1e293b' }}>{row.name}</TableCell>
                      <TableCell sx={{ color: '#0284c7', fontWeight: 'bold', fontSize: '0.85rem' }}>{row.storehouse}</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 'bold', color: '#334155' }}>
                        {systemStock} {row.unit}
                      </TableCell>
                      <TableCell align="center">
                        <TextField
                          type="number"
                          size="small"
                          fullWidth
                          value={physicalVal}
                          onChange={(e) => handlePhysicalCountChange(row.rowKey, e.target.value)}
                          onFocus={(e) => e.target.select()}
                          slotProps={{
                            input: {
                              style: { borderRadius: '8px', textAlign: 'center', fontWeight: 'bold' }
                            }
                          }}
                          placeholder="الكمية الفعلية"
                        />
                      </TableCell>
                      <TableCell align="center">
                        {physicalVal === '' || diff === 0 ? (
                          <Chip label="مطابق" size="small" sx={{ bgcolor: '#f1f5f9', color: '#475569', fontWeight: 'bold' }} />
                        ) : diff > 0 ? (
                          <Chip label={`زيادة (+${diff})`} size="small" sx={{ bgcolor: '#dcfce7', color: '#15803d', fontWeight: 'bold' }} />
                        ) : (
                          <Chip label={`عجز (${diff})`} size="small" sx={{ bgcolor: '#fee2e2', color: '#b91c1c', fontWeight: 'bold' }} />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>

          <TextField
            fullWidth
            label="ملاحظات عامة حول محضر الجرد السنوي والتسوية"
            multiline
            rows={2}
            value={stocktakeNotes}
            onChange={(e) => setStocktakeNotes(e.target.value)}
            placeholder="مثال: تم الجرد الفعلي السنوي بواسطة اللجنة المشكلة برئاسة أمين المخزن وعضوية الرقابة الداخلية للربع الأخير..."
            slotProps={{
              input: { style: { borderRadius: '10px' } }
            }}
          />
        </DialogContent>
        <DialogActions sx={{ p: 3, justifyContent: 'flex-start', gap: 2 }}>
          <Button 
            variant="contained" 
            onClick={handleSaveStocktake}
            sx={{ bgcolor: '#0f766e', fontWeight: 'bold', px: 4, borderRadius: '10px', '&:hover': { bgcolor: '#0d5f58' } }}
          >
            اعتماد وتسجيل تسوية الجرد السنوي
          </Button>
          <Button 
            variant="outlined" 
            onClick={() => setOpenStocktakeDialog(false)}
            sx={{ color: '#475569', borderColor: '#cbd5e1', px: 3, borderRadius: '10px' }}
          >
            إلغاء التراجع
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
