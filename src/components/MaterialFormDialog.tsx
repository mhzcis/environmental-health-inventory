import { useEffect, useState } from 'react';
import { safeUserMessage } from '../services/safeUserMessage';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Box, Typography, Grid
} from '@mui/material';

import { useForm, SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as zod from 'zod';
import { Material, InventoryTransaction } from '../types';
import { dataService } from '../services/dataService';
import { useStorehouse } from '../context/StorehouseContext';
import { renderOption } from '../utils/emoji';


export const materialSchema = zod.object({
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

export type MaterialFormValues = zod.infer<typeof materialSchema>;

interface MaterialFormDialogProps {
  open: boolean;
  onClose: () => void;
  selectedMaterial: (Material & { _originalId?: string }) | null;
  onSuccess: (message: string, newMaterial?: Material) => void;
  onError: (message: string) => void;
}

export default function MaterialFormDialog({ open, onClose, selectedMaterial, onSuccess, onError }: MaterialFormDialogProps) {
  const { selectedStorehouse } = useStorehouse();
  const [settings, setSettings] = useState(dataService.getSettings());
  const [materials, setMaterials] = useState<Material[]>([]);
  const [newSupplierName, setNewSupplierName] = useState('');
  const [saveNewSupplier, setSaveNewSupplier] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  useEffect(() => {
    if (open) {
      setSettings(dataService.getSettings());
      setMaterials(dataService.getMaterials());
    }
  }, [open]);

  const { register, handleSubmit, formState: { errors }, reset, watch, setValue, trigger, setFocus } = useForm<MaterialFormValues>({
    resolver: zodResolver(materialSchema) as any,
    defaultValues: {
      category: '',
      code: '',
      name: '',
      initialStock: 0,
      minimumStock: 0,
      storageLocation: '',
      unit: '',
      notes: '',
      productionDate: '',
      expiryDate: '',
      hazardLevel: '',
      manufacturer: 'جهة غير محددة',
      isEditMode: false,
    },
  });

  const watchCategory = watch('category');
  const watchManufacturer = watch('manufacturer');
  const watchInitialStock = watch('initialStock');

  useEffect(() => {
    if (open && !selectedMaterial && selectedStorehouse !== 'all') {
      setValue('storageLocation', selectedStorehouse);
    }
  }, [open, selectedMaterial, selectedStorehouse, setValue]);

  useEffect(() => {
    if (selectedMaterial) {
      reset({
        category: selectedMaterial.category,
        code: selectedMaterial.code,
        name: selectedMaterial.name,
        initialStock: selectedMaterial.initialStock,
        minimumStock: selectedMaterial.minimumStock,
        storageLocation: selectedMaterial.storageLocation,
        unit: selectedMaterial.unit,
        notes: selectedMaterial.notes || '',
        productionDate: selectedMaterial.productionDate || '',
        expiryDate: selectedMaterial.expiryDate || '',
        hazardLevel: (selectedMaterial.hazardLevel as any) || '',
        manufacturer: selectedMaterial.manufacturer || 'جهة غير محددة',
        isEditMode: true,
      });
    } else {
      reset({
        category: '',
        code: '',
        name: '',
        initialStock: 0,
        minimumStock: 0,
        storageLocation: '',
        unit: '',
        notes: '',
        productionDate: '',
        expiryDate: '',
        hazardLevel: '',
        manufacturer: 'جهة غير محددة',
        isEditMode: false,
      });
      setNewSupplierName('');
      setSaveNewSupplier(false);
    }
  }, [selectedMaterial, open, reset]);

  useEffect(() => {
    if (watchCategory && !selectedMaterial) {
      const catSettings = settings.categories.find(c => c.name === watchCategory);
      if (catSettings && !watch('code')) {
        setValue('code', dataService.generateItemCode(watchCategory));
        trigger('code');
      }
    }
  }, [watchCategory, selectedMaterial, settings, setValue, trigger, watch]);

  const onSubmitForm: SubmitHandler<MaterialFormValues> = async (data) => {
    setIsSubmitting(true);
    try {
      // Simulate small async delay for safety and UI feedback
      await new Promise(resolve => setTimeout(resolve, 300));
      
      let finalManufacturer = data.manufacturer;

      if (data.manufacturer === 'new_supplier...') {
        const trimmedName = newSupplierName.trim().replace(/\s+/g, ' ');
        if (!trimmedName) {
           onError('يرجى إدخال اسم المورد الجديد');
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
      let payload: Material = null as any;
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
            const initTx: InventoryTransaction = {
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
              executedBy: dataService.getCurrentUser().fullName,
              supplierOrReceiver: 'رصيد مخزني أولي (رصيد افتتاحي)',
              notes: 'تأسيس رصيد الصنف التلقائي عند التسجيل الأول للصنف في بطاقة البيانات',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            await dataService.saveMaterialWithOpeningStock(payload, initTx);
          } else {
            await dataService.saveMaterial(payload);
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

      onSuccess(selectedMaterial ? 'تم تحديث بيانات الصنف بنجاح' : 'تم حفظ الصنف بنجاح، ويمكنك الآن إضافة صنف آخر أو إغلاق النافذة', payload);

      if (selectedMaterial) {
        onClose();
      } else {
        setValue('name', '');
        setValue('code', dataService.generateItemCode(data.category));
        setValue('initialStock', 0);
        setValue('notes', '');
        setValue('manufacturer', 'جهة غير محددة');
        setNewSupplierName('');
        setSaveNewSupplier(false);
        setTimeout(() => setFocus('name'), 50);
      }
    } catch (err: any) {
      onError(safeUserMessage(err, 'generic', { allowAppText: true, fallback: 'حدث خطأ أثناء حفظ الصنف' }));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog 
      open={open} 
      onClose={onClose} 
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
            <Grid size={{ xs: 12, sm: 4 }}>
              <TextField
                fullWidth
                type="number"
                label="الرصيد الإبتدائي الافتتاحي بالمستودع"
                placeholder="مثال: 100"
                disabled={!!selectedMaterial}
                {...register('initialStock')}
                error={!!errors.initialStock}
                helperText={selectedMaterial ? "الرصيد الابتدائي مسجل مسبقاً" : errors.initialStock?.message || "سيقوم النظام بتوريد رصيد بداية أوتوماتيكي"}
                onFocus={(e) => e.target.select()}
              />
            </Grid>
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
            {watchInitialStock > 0 && (
              <Grid size={12}>
                <Box sx={{ p: 2, bgcolor: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '10px' }}>
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
            <Grid size={12}>
              <TextField
                select
                fullWidth
                label="مستودع وموقع التخزين الرئيسي"
                disabled={!selectedMaterial && selectedStorehouse !== 'all'}
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
                  } else {
                    setValue('manufacturer', val);
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
            color="primary"
            disabled={isSubmitting}
            sx={{ px: 4, py: 1.5, borderRadius: '10px', fontWeight: 'bold' }}
          >
            {isSubmitting ? 'جاري الحفظ...' : (selectedMaterial ? 'حفظ التعديلات' : 'إضافة الصنف للمخزون')}
          </Button>
          <Button 
            onClick={onClose} 
            variant="outlined" 
            sx={{ px: 3, py: 1.5, borderRadius: '10px', color: '#64748b', borderColor: '#e2e8f0', '&:hover': { borderColor: '#cbd5e1', bgcolor: '#f8fafc' } }}
          >
            إلغاء
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
