import { renderOption } from "../utils/emoji";

import { presentResultMessage, safeUserMessage } from '../services/safeUserMessage';
import { useState, useEffect, useMemo } from 'react';
import { 
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, 
  MenuItem, Box, Typography, Autocomplete, Card, CardContent, CircularProgress,
  FormControlLabel, Checkbox, IconButton, Tooltip, Chip
} from '@mui/material';

import AddCircleIcon from '@mui/icons-material/AddCircle';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as zod from 'zod';
import { dataService } from '../services/dataService';
import { InventoryTransaction, Material } from '../types';
import MaterialFormDialog from './MaterialFormDialog';

// Use same schema logic
const transactionSchema = zod.object({
  itemSelection: zod.object({
    id: zod.string(),
    code: zod.string(),
    name: zod.string(),
    type: zod.string(),
    unit: zod.string(),
    currentStock: zod.number(),
    category: zod.string().optional(),
  }),
  transactionType: zod.enum(['وارد', 'صادر', 'مستهلك', 'تحويل', 'تسوية', 'افتتاحي']),
  quantity: zod.number().positive({ message: 'الكمية يجب أن تكون أكبر من صفر' }),
  storehouse: zod.string().min(1, { message: 'يجب تحديد المستودع' }),
  destStorehouse: zod.string().optional(),
  supplierOrReceiver: zod.string().optional(),
  date: zod.string().min(1, { message: 'تاريخ الحركة مطلوب' }),
  notes: zod.string().optional(),
}).refine(data => {
  if (data.transactionType === 'تحويل' && !data.destStorehouse) return false;
  return true;
}, { message: 'يجب تحديد مستودع الوجهة للتحويل', path: ['destStorehouse'] }).refine(data => {
  if (data.transactionType === 'تحويل' && data.destStorehouse === data.storehouse) return false;
  return true;
}, { message: 'لا يمكن التحويل لنفس المستودع', path: ['destStorehouse'] }).refine(data => {
  if (data.transactionType === 'مستهلك' && !data.supplierOrReceiver?.trim()) return false;
  return true;
}, { message: 'جهة الاستهلاك مطلوبة', path: ['supplierOrReceiver'] });

type TransactionFormValues = zod.infer<typeof transactionSchema>;

interface CreateTransactionModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  globalStorehouseScope: string;
}


function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const MAX_HEIGHT = 800;
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
        } else {
          if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(event.target?.result as string); return; }
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        resolve(dataUrl);
      };
      img.onerror = (err) => reject(err);
    };
    reader.onerror = (err) => reject(err);
  });
}

export default function CreateTransactionModal({ open, onClose, onSuccess, onError, globalStorehouseScope }: CreateTransactionModalProps) {
  const [settings, setSettings] = useState(dataService.getSettings());
  const [materials, setMaterials] = useState<Material[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Custom Supplier/Receiver
  const [savePartnerEntity, setSavePartnerEntity] = useState(false);
  const [customPartnerEntityName, setCustomPartnerEntityName] = useState('');

  // New Item modal
  const [openItemModal, setOpenItemModal] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [attachmentSize, setAttachmentSize] = useState<string | null>(null);

  const { register, handleSubmit, control, watch, reset, setValue, formState: { errors } } = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionSchema),
    defaultValues: {
      transactionType: 'وارد',
      quantity: 0,
      supplierOrReceiver: '',
      date: new Date().toISOString().split('T')[0],
      storehouse: '',
      destStorehouse: '',
      notes: '',
      itemSelection: null as any,
    }
  });

  const watchTxType = watch('transactionType');
  const watchItem = watch('itemSelection');
  const watchStorehouse = watch('storehouse');
  const watchDestStorehouse = watch('destStorehouse');
  const watchQty = watch('quantity');
  const watchSupplier = watch('supplierOrReceiver');

  useEffect(() => {
    if (open) {
      setSettings(dataService.getSettings());
      setMaterials(dataService.getMaterials());
      // Reset form but keep default date
      reset({
        itemSelection: null as any,
        transactionType: 'وارد',
        quantity: 0,
        storehouse: globalStorehouseScope !== 'all' ? globalStorehouseScope : '',
        destStorehouse: '',
        supplierOrReceiver: '',
        date: new Date().toISOString().split('T')[0],
        notes: '',
      });
      setSavePartnerEntity(false);
      setCustomPartnerEntityName('');
      setSelectedImage(null);
    }
  }, [open, globalStorehouseScope, reset]);

  // Handle transaction type change
  useEffect(() => {
    // Set auto text based on type
    if (watchTxType === 'مستهلك') setValue('supplierOrReceiver', 'استهلاك مخزني داخلي');
    else if (watchTxType === 'افتتاحي') setValue('supplierOrReceiver', 'رصيد مخزني أولي (رصيد افتتاحي)');
    else if (watchTxType === 'تسوية') setValue('supplierOrReceiver', 'تسوية مخزنية');
    else if (watchTxType === 'تحويل') setValue('supplierOrReceiver', ''); // Wait, transfer generates two docs
    else {
      // In or Out: if the previous text was an auto-text, clear it
      if (['استهلاك مخزني داخلي', 'رصيد مخزني أولي (رصيد افتتاحي)', 'تسوية مخزنية'].includes(watchSupplier || '')) {
        setValue('supplierOrReceiver', '');
      }
    }
    
    // Reset custom partner state on type change
    setSavePartnerEntity(false);
    setCustomPartnerEntityName('');
    
    // Clear item if it becomes invalid (e.g., changing from In to Out, and item has 0 stock)
    if (watchItem && ['صادر', 'مستهلك', 'تحويل'].includes(watchTxType)) {
      const stock = dataService.getItemStockByStorehouse(watchItem.id, watchStorehouse || 'all');
      if (stock <= 0) {
        setValue('itemSelection', null as any);
      }
    }
  }, [watchTxType]);

  // Auto-fill supplier when item or txType changes in "Inbound" transaction
  useEffect(() => {
    if (watchItem && watchTxType === 'وارد') {
      const selectedMat = materials.find(m => m.id === watchItem.id);
      if (selectedMat && selectedMat.manufacturer && selectedMat.manufacturer !== 'جهة غير محددة') {
        const availableOptions = settings.partners.filter(p => p.type === 'مورد').map(p => p.name);
        if (availableOptions.includes(selectedMat.manufacturer)) {
          setValue('supplierOrReceiver', selectedMat.manufacturer);
          setCustomPartnerEntityName('');
          setSavePartnerEntity(false);
        } else {
          setValue('supplierOrReceiver', 'OTHER');
          setCustomPartnerEntityName(selectedMat.manufacturer);
          setSavePartnerEntity(false);
        }
      } else {
        setValue('supplierOrReceiver', '');
        setCustomPartnerEntityName('');
        setSavePartnerEntity(false);
      }
    }
  }, [watchItem, watchTxType, materials, settings.partners, setValue]);

  // Derived state for available items
  const availableItems = useMemo(() => {
    return materials.map(m => ({ 
      id: m.id, code: m.code, name: m.name, type: m.category, category: m.category, unit: m.unit, currentStock: m.currentStock 
    })).filter(m => {
      if (['صادر', 'مستهلك', 'تحويل'].includes(watchTxType) || (watchTxType === 'تسوية' && watchQty < 0)) {
        // Must have stock > 0 in the currently selected scope
        const stock = dataService.getItemStockByStorehouse(m.id, globalStorehouseScope);
        return stock > 0;
      }
      return true; // For In/Opening/Adjustment(up), all items are valid
    });
  }, [materials, watchTxType, globalStorehouseScope, watchQty]);

  // Derived state for available storehouses
  const sourceStorehouses = useMemo(() => {
    let stores = settings.storehouses;
    if (globalStorehouseScope !== 'all') {
      stores = stores.filter(s => s === globalStorehouseScope);
    }
    
    if (!watchItem) return stores;
    
    if (['صادر', 'مستهلك', 'تحويل'].includes(watchTxType) || (watchTxType === 'تسوية' && watchQty < 0)) {
      return stores.filter(s => dataService.getItemStockByStorehouse(watchItem.id, s) > 0);
    }
    return stores;
  }, [settings.storehouses, watchItem, watchTxType, watchQty, globalStorehouseScope]);

  const targetStorehouses = useMemo(() => {
    if (watchTxType === 'تحويل') {
      return settings.storehouses.filter(s => s !== watchStorehouse);
    }
    return settings.storehouses;
  }, [settings.storehouses, watchTxType, watchStorehouse]);

  // Validate storehouse on change
  useEffect(() => {
    if (watchStorehouse && !sourceStorehouses.includes(watchStorehouse)) {
      setValue('storehouse', '');
    }
    if (watchDestStorehouse && !targetStorehouses.includes(watchDestStorehouse)) {
      setValue('destStorehouse', '');
    }
  }, [sourceStorehouses, targetStorehouses, watchStorehouse, watchDestStorehouse]);

  // Live Simulation
  const liveStockSim = useMemo(() => {
    if (!watchItem || !watchStorehouse) return null;
    const targetMat = materials.find(m => m.id === watchItem.id);
    if (!targetMat) return null;

    const currentStock = dataService.getItemStockByStorehouse(watchItem.id, watchStorehouse);
    const qty = Number(watchQty) || 0;
    
    let simulatedAfter = currentStock;
    if (watchTxType === 'وارد' || watchTxType === 'افتتاحي' || (watchTxType === 'تسوية' && qty >= 0)) {
      simulatedAfter += qty;
    } else if (watchTxType === 'صادر' || watchTxType === 'مستهلك' || watchTxType === 'تحويل' || (watchTxType === 'تسوية' && qty < 0)) {
      simulatedAfter -= Math.abs(qty);
    }

    let globalStock: number | null = null;
    let simulatedGlobalAfter: number | null = null;
    let allStorehousesDetails: any[] = [];

    if (globalStorehouseScope === 'all') {
      globalStock = dataService.getItemStockByStorehouse(watchItem.id, 'all');
      simulatedGlobalAfter = globalStock;
      if (watchTxType === 'وارد' || watchTxType === 'افتتاحي' || (watchTxType === 'تسوية' && qty >= 0)) {
        simulatedGlobalAfter += qty;
      } else if (watchTxType === 'صادر' || watchTxType === 'مستهلك' || (watchTxType === 'تسوية' && qty < 0)) {
        simulatedGlobalAfter -= Math.abs(qty);
      }
      
      // Calculate individual storehouses
      settings.storehouses.forEach(sh => {
        let shCurrent = dataService.getItemStockByStorehouse(watchItem.id, sh);
        let shSimulated = shCurrent;
        let diff = 0;
        
        if (sh === watchStorehouse) {
           if (watchTxType === 'وارد' || watchTxType === 'افتتاحي' || (watchTxType === 'تسوية' && qty >= 0)) {
             diff = qty;
           } else if (watchTxType === 'صادر' || watchTxType === 'مستهلك' || watchTxType === 'تحويل' || (watchTxType === 'تسوية' && qty < 0)) {
             diff = -Math.abs(qty);
           }
        } else if (watchTxType === 'تحويل' && sh === watchDestStorehouse) {
           diff = qty;
        }
        
        shSimulated += diff;
        
        // Show if current stock > 0 OR diff !== 0 (involved in the transaction)
        if (shCurrent > 0 || diff !== 0) {
          allStorehousesDetails.push({
            name: sh,
            current: shCurrent,
            diff,
            simulated: shSimulated
          });
        }
      });
    }

    return {
      current: currentStock,
      simulated: simulatedAfter,
      unit: watchItem.unit,
      isNegative: simulatedAfter < 0,
      storehouseName: watchStorehouse,
      globalStock,
      simulatedGlobalAfter,
      allStorehousesDetails
    };
  }, [watchItem, watchStorehouse, watchQty, watchTxType, materials, globalStorehouseScope, settings.storehouses, watchDestStorehouse]);

  const onSubmitForm = async (data: TransactionFormValues) => {
    if (liveStockSim?.isNegative) return; // Prevent submission if negative

    try {
      setIsSubmitting(true);
      await new Promise(resolve => setTimeout(resolve, 300));
      
      let finalSupplierOrReceiver = data.supplierOrReceiver;

      // Handle custom partner save
      if (['وارد', 'صادر'].includes(data.transactionType) && data.supplierOrReceiver === 'OTHER') {
        finalSupplierOrReceiver = customPartnerEntityName.trim();
        if (!finalSupplierOrReceiver) {
          throw new Error('يرجى إدخال اسم المورد/الجهة الجديدة');
        }
        if (savePartnerEntity) {
          const type = data.transactionType === 'وارد' ? 'مورد' : 'جهة مستلمة';
          const exists = settings.partners.some(p => p.name === finalSupplierOrReceiver && p.type === type);
          if (!exists) {
            const updatedSettings = { ...settings, partners: [...settings.partners, { id: Date.now().toString(), name: finalSupplierOrReceiver, type: type as any }] };
            await dataService.saveSettings(updatedSettings);
            setSettings(updatedSettings);
          }
        }
      }

      if (data.transactionType === 'تحويل') {
         const res = await dataService.saveTransfer(
           data.itemSelection.id,
           data.quantity,
           data.storehouse,
           data.destStorehouse || '',
           dataService.getCurrentUser().fullName,
           data.notes || '',
           data.date
         );
         if (res.success) {
           onSuccess(res.message);
           onClose();
         } else {
           onError(presentResultMessage(res.message));
         }
      } else {
         const payload: InventoryTransaction = {
           id: `tr-${Date.now()}`,
           date: data.date,
           itemType: data.itemSelection.type,
           itemId: data.itemSelection.id,
           itemCode: data.itemSelection.code,
           itemName: data.itemSelection.name,
           itemCategory: data.itemSelection.category,
           transactionType: data.transactionType,
           quantity: Math.abs(data.quantity),
           unit: data.itemSelection.unit,
           storehouse: data.storehouse,
           stockBefore: 0,
           stockAfter: 0,
           executedBy: dataService.getCurrentUser().fullName,
           supplierOrReceiver: finalSupplierOrReceiver,
           notes: data.notes || '',
           attachment: selectedImage || undefined,
           createdAt: new Date().toISOString(),
           updatedAt: new Date().toISOString(),
           transferType: data.transactionType === 'وارد' || data.transactionType === 'افتتاحي' || (data.transactionType === 'تسوية' && data.quantity >= 0) ? 'in' : 'out'
         };
         
         const res = await dataService.saveTransaction(payload);
         if (res.success) {
           onSuccess(res.message);
           onClose();
         } else {
           onError(presentResultMessage(res.message));
         }
      }
    } catch (err: any) {
      onError(safeUserMessage(err, 'generic', { allowAppText: true, fallback: 'حدث خطأ' }));
    } finally {
      setIsSubmitting(false);
    }
  };

  const getPartnerEntityOptions = () => {
    if (watchTxType === 'وارد') {
      return [...settings.partners.filter(p => p.type === 'مورد').map(p => p.name), 'OTHER'];
    } else if (watchTxType === 'صادر') {
      return [...settings.partners.filter(p => p.type === 'جهة مستلمة').map(p => p.name), 'OTHER'];
    }
    return [];
  };

  const handleItemModalSuccess = (msg: string) => {
    // Refresh materials
    setMaterials(dataService.getMaterials());
    setOpenItemModal(false);
    onSuccess(msg); // Show toast without closing tx modal
  };

  return (
    <>
    <Dialog 
      open={open} 
      onClose={onClose} 
      maxWidth="md" 
      fullWidth
      slotProps={{ paper: { sx: { py: 1, direction: 'rtl' } } }}
    >
      <DialogTitle sx={{ fontWeight: 'bold', color: '#1e293b' }}>
        تسجيل حركة مخزنية جديدة
      </DialogTitle>
      <form onSubmit={handleSubmit(onSubmitForm)}>
        <DialogContent>
          <Box className="grid grid-cols-1 md:grid-cols-12 gap-4 pt-2">
            
            {/* Transaction Type */}
            <Box className="col-span-1 md:col-span-4">
              <TextField
                select
                fullWidth
                label="نوع الحركة المخزنية"
                {...register('transactionType')}
                value={watchTxType || ''}
              >
                <MenuItem value="وارد">{renderOption("وارد")}</MenuItem>
                <MenuItem value="صادر">{renderOption("صادر")}</MenuItem>
                <MenuItem value="مستهلك">{renderOption("مستهلك")}</MenuItem>
                <MenuItem value="تحويل">{renderOption("تحويل")}</MenuItem>
                <MenuItem value="تسوية">{renderOption("تسوية")}</MenuItem>
                <MenuItem value="افتتاحي">{renderOption("افتتاحي")}</MenuItem>
              </TextField>
            </Box>

            <Box className="col-span-1 md:col-span-4">
              <TextField
                fullWidth
                type="date"
                label="تاريخ تسجيل الحركة"
                slotProps={{ inputLabel: { shrink: true } }}
                {...register('date')}
                error={!!errors.date}
                helperText={errors.date?.message}
              />
            </Box>

            <Box className="col-span-1 md:col-span-4" /> {/* spacer */}

            {/* Item Selection with New Item Button */}
            <Box className="col-span-1 md:col-span-12" sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <Controller
                name="itemSelection"
                control={control}
                render={({ field }) => (
                  <Autocomplete
                    {...field}
                    sx={{ flexGrow: 1 }}
                    value={field.value || null}
                    options={availableItems}
                    getOptionLabel={(option) => `[${option.code}] ${option.name}`}
                    isOptionEqualToValue={(option, value) => option.id === value?.id}
                    onChange={(_, newValue) => field.onChange(newValue)}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="اختر الصنف المخزني 📦"
                        error={!!errors.itemSelection}
                        helperText={errors.itemSelection ? errors.itemSelection.message : 'البحث بالكود أو الاسم'}
                      />
                    )}
                    renderOption={(props, option) => (
                      <li {...props} key={option.id}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 0.5 }}>
                          <Chip label={option.code} size="small" sx={{ fontWeight: 'bold', fontFamily: 'monospace' }} />
                          {renderOption(option.name, 'item')}
                        </Box>
                      </li>
                    )}
                  />
                )}
              />
              <Tooltip title="إنشاء صنف جديد">
                <IconButton 
                  color="primary" 
                  onClick={() => setOpenItemModal(true)}
                  sx={{ 
                    width: '56px', 
                    minWidth: '56px', 
                    maxWidth: '56px', 
                    height: '56px', 
                    minHeight: '56px', 
                    maxHeight: '56px', 
                    flexShrink: 0, 
                    borderRadius: '10px', 
                    border: '1px solid #cbd5e1',
                    p: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                >
                  <AddCircleIcon fontSize="large" />
                </IconButton>
              </Tooltip>
            </Box>

            {/* Item Info Panel */}
            {watchItem && (
              <Box className="col-span-1 md:col-span-12">
                <Card variant="outlined" sx={{ bgcolor: '#f0f9ff', borderColor: '#bae6fd' }}>
                  <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Typography variant="body2" sx={{ color: '#0369a1', fontWeight: 'bold' }}>
                      معلومات الصنف: {watchItem.category}
                    </Typography>
                    {globalStorehouseScope === 'all' ? (
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="caption" sx={{ color: '#0284c7' }}>الأرصدة في المستودعات:</Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
                          {settings.storehouses.map(st => {
                            const stStock = dataService.getItemStockByStorehouse(watchItem.id, st);
                            if (stStock > 0) {
                              return <Chip key={st} label={`${st}: ${stStock}`} size="small" sx={{ bgcolor: '#e0f2fe', color: '#0369a1' }} />;
                            }
                            return null;
                          })}
                        </Box>
                        <Typography variant="body2" sx={{ mt: 1, fontWeight: 'bold', color: '#0369a1' }}>
                          إجمالي الكمية المتوفرة: {dataService.getItemStockByStorehouse(watchItem.id, 'all')} {watchItem.unit}
                        </Typography>
                      </Box>
                    ) : (
                      <Typography variant="body2" sx={{ mt: 1, color: '#0284c7' }}>
                        الرصيد في مستودع ({globalStorehouseScope}): <strong>{dataService.getItemStockByStorehouse(watchItem.id, globalStorehouseScope)} {watchItem.unit}</strong>
                      </Typography>
                    )}
                    
                    {dataService.getItemStockByStorehouse(watchItem.id, globalStorehouseScope) === 0 && ['وارد', 'افتتاحي'].includes(watchTxType) && (
                      <Typography variant="caption" sx={{ color: '#059669', display: 'block', mt: 1 }}>
                        لا يوجد رصيد سابق لهذا الصنف، وسيتم إنشاء أو زيادة رصيده من خلال هذه الحركة.
                      </Typography>
                    )}
                  </CardContent>
                </Card>
              </Box>
            )}

            {/* Storehouses */}
            <Box className="col-span-1 md:col-span-4">
              <TextField
                select
                fullWidth
                label={watchTxType === 'تحويل' ? "المستودع المصدر 🏢" : "المستودع 🏢"}
                {...register('storehouse')}
                value={watchStorehouse || ''}
                error={!!errors.storehouse}
                helperText={errors.storehouse?.message || (sourceStorehouses.length === 0 && watchItem ? 'لا توجد مستودعات برصيد' : '')}
              >
                {sourceStorehouses.map((store) => (
                  <MenuItem key={store} value={store}>{renderOption(store, "storehouse")}</MenuItem>
                ))}
              </TextField>
            </Box>

            {watchTxType === 'تحويل' && (
              <Box className="col-span-1 md:col-span-4">
                <TextField
                  select
                  fullWidth
                  label="المستودع المستهدف 🏢"
                  {...register('destStorehouse')}
                  value={watchDestStorehouse || ''}
                  error={!!errors.destStorehouse}
                  helperText={errors.destStorehouse?.message}
                >
                  {targetStorehouses.map((store) => (
                    <MenuItem key={store} value={store}>{renderOption(store, "storehouse")}</MenuItem>
                  ))}
                </TextField>
              </Box>
            )}

            <Box className="col-span-1 md:col-span-4">
              <TextField
                fullWidth
                type="number"
                label="الكمية"
                {...register('quantity', { valueAsNumber: true })}
                onFocus={(e) => e.target.select()}
                error={!!errors.quantity}
                helperText={errors.quantity?.message}
                slotProps={{ htmlInput: { step: 'any' } }}
              />
            </Box>

            {/* Supplier / Receiver / Consumer */}
            {['وارد', 'صادر', 'مستهلك'].includes(watchTxType) && (
              <Box className="col-span-1 md:col-span-12">
                {watchTxType === 'مستهلك' ? (
                  <Controller
                    name="supplierOrReceiver"
                    control={control}
                    render={({ field }) => (
                      <TextField
                        fullWidth
                        label="جهة الاستهلاك / نص السند"
                        placeholder="استهلاك مخزني داخلي"
                        {...field}
                        value={field.value || ''}
                        error={!!errors.supplierOrReceiver}
                        helperText={errors.supplierOrReceiver?.message}
                      />
                    )}
                  />
                ) : (
                  <>
                    <Controller
                      name="supplierOrReceiver"
                      control={control}
                      render={({ field }) => (
                        <TextField
                          select
                          fullWidth
                          label={watchTxType === 'وارد' ? 'المورد 👤' : 'الجهة المستلمة 👤'}
                          {...field}
                          value={field.value || ''}
                          error={!!errors.supplierOrReceiver}
                          helperText={errors.supplierOrReceiver?.message}
                        >
                          {getPartnerEntityOptions().map(opt => (
                            <MenuItem key={opt} value={opt}>{renderOption(opt === 'OTHER' ? (watchTxType === 'وارد' ? 'مورد آخر...' : 'جهة مستلمة أخرى...') : opt, "partner")}</MenuItem>
                          ))}
                        </TextField>
                      )}
                    />
                    
                    {watchSupplier === 'OTHER' && (
                      <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 1, p: 2, bgcolor: '#f8fafc', borderRadius: '10px' }}>
                        <TextField
                          fullWidth
                          size="small"
                          label={watchTxType === 'وارد' ? 'اسم المورد الجديد' : 'اسم الجهة المستلمة الجديدة'}
                          value={customPartnerEntityName}
                          onChange={(e) => setCustomPartnerEntityName(e.target.value)}
                        />
                        <FormControlLabel
                          control={<Checkbox checked={savePartnerEntity} onChange={(e) => setSavePartnerEntity(e.target.checked)} />}
                          label="حفظ هذه الجهة في الإعدادات لاستخدامها مستقبلاً"
                        />
                      </Box>
                    )}
                  </>
                )}
              </Box>
            )}

            {/* Auto text display for fixed types */}
            {['افتتاحي', 'تسوية', 'تحويل'].includes(watchTxType) && (
              <Box className="col-span-1 md:col-span-12">
                <TextField
                  fullWidth
                  disabled
                  label="نص السند التلقائي"
                  value={
                    watchTxType === 'تحويل' 
                    ? `تحويل من [${watchStorehouse || '...'}] إلى [${watchDestStorehouse || '...'}]`
                    : watchSupplier
                  }
                  sx={{ bgcolor: '#f1f5f9' }}
                />
              </Box>
            )}

            <Box className="col-span-1 md:col-span-12">
              <TextField
                fullWidth
                multiline
                rows={2}
                label="ملاحظات تفصيلية (اختياري)"
                {...register('notes')}
              />
            </Box>

            
            {/* Image attachment */}
            <Box className="col-span-1 md:col-span-12">
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 1.5, color: '#475569' }}>
                إرفاق مستند الحركة (صورة)
              </Typography>
              {!selectedImage ? (
                <Box
                  sx={{ border: '2px dashed #cbd5e1', borderRadius: '10px', p: 3, textAlign: 'center', bgcolor: '#f8fafc', cursor: 'pointer', '&:hover': { borderColor: '#0284c7', bgcolor: '#f0f9ff' } }}
                  onClick={() => document.getElementById('receipt-image-upload')?.click()}
                >
                  <input
                    type="file"
                    id="receipt-image-upload"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        try {
                          const compressed = await compressImage(file);
                          setSelectedImage(compressed);
                          const sizeInKB = ((compressed.length * 3 / 4) / 1024).toFixed(2);
                          setAttachmentSize(sizeInKB + ' KB');
                        } catch (err) {
                          onError('فشل قراءة الملف');
                        }
                        e.target.value = '';
                      }
                    }}
                  />
                  <Typography sx={{ fontSize: '2rem', mb: 1 }}>📸</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#475569' }}>
                    اضغط هنا لإرفاق مستند
                  </Typography>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, p: 2, borderRadius: '10px', bgcolor: '#f0fdf4' }}>
                  <Box component="img" src={selectedImage} alt="مرفق" sx={{ width: 75, height: 75, objectFit: 'cover', borderRadius: '8px', border: '1px solid #bbf7d0' }} />
                  <Box sx={{ flexGrow: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#166534' }}>تم إرفاق صورة السند بنجاح {attachmentSize && `(${attachmentSize})`}</Typography>
                  </Box>
                  <Button variant="outlined" color="error" size="small" onClick={() => setSelectedImage(null)} sx={{ borderRadius: '8px' }}>
                    حذف المرفق
                  </Button>
                </Box>
              )}
            </Box>

            {/* Simulation Table */}
            {liveStockSim && watchStorehouse && (
              <Box className="col-span-1 md:col-span-12">
                <Typography variant="subtitle2" sx={{ mb: 1, color: '#475569', fontWeight: 'bold' }}>محاكاة الرصيد:</Typography>
                <Box sx={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f8fafc', borderBottom: '2px solid #cbd5e1' }}>
                        <th style={{ padding: '8px' }}>المستودع</th>
                        <th style={{ padding: '8px' }}>الرصيد السابق</th>
                        <th style={{ padding: '8px' }}>التغيير</th>
                        <th style={{ padding: '8px' }}>الرصيد بعد الحركة</th>
                      </tr>
                    </thead>
                    <tbody>
                      {globalStorehouseScope === 'all' && liveStockSim.allStorehousesDetails && liveStockSim.allStorehousesDetails.length > 0 ? (
                        <>
                          {liveStockSim.globalStock !== null && liveStockSim.simulatedGlobalAfter !== null && (
                            <tr style={{ borderBottom: '2px solid #bae6fd', backgroundColor: '#f0f9ff', fontWeight: 'bold' }}>
                              <td style={{ padding: '8px' }}>جميع المستودعات (الإجمالي)</td>
                              <td style={{ padding: '8px' }}>{liveStockSim.globalStock} {liveStockSim.unit}</td>
                              <td style={{ padding: '8px', color: (watchTxType === 'صادر' || watchTxType === 'مستهلك' || (watchTxType==='تسوية'&&watchQty<0)) ? '#ef4444' : (watchTxType === 'تحويل' ? 'inherit' : '#10b981') }}>
                                {watchTxType === 'تحويل' ? '0' : ((watchTxType === 'صادر' || watchTxType === 'مستهلك' || (watchTxType==='تسوية'&&watchQty<0)) ? '-' : '+') + (watchQty || 0)}
                              </td>
                              <td style={{ padding: '8px', fontWeight: 'bold' }}>
                                {liveStockSim.simulatedGlobalAfter} {liveStockSim.unit}
                              </td>
                            </tr>
                          )}
                          {liveStockSim.allStorehousesDetails.map(sh => (
                            <tr key={sh.name} style={{ borderBottom: '1px solid #e2e8f0', backgroundColor: sh.simulated < 0 ? '#fef2f2' : 'inherit' }}>
                              <td style={{ padding: '8px', paddingRight: '20px' }}>↳ {sh.name}</td>
                              <td style={{ padding: '8px' }}>{sh.current} {liveStockSim.unit}</td>
                              <td style={{ padding: '8px', color: sh.diff < 0 ? '#ef4444' : (sh.diff > 0 ? '#10b981' : 'inherit') }}>
                                {sh.diff === 0 ? '-' : (sh.diff > 0 ? `+${sh.diff}` : sh.diff)}
                              </td>
                              <td style={{ padding: '8px', fontWeight: 'bold', color: sh.simulated < 0 ? '#ef4444' : 'inherit' }}>
                                {sh.simulated} {liveStockSim.unit}
                              </td>
                            </tr>
                          ))}
                        </>
                      ) : (
                        <>
                          <tr style={{ borderBottom: '1px solid #e2e8f0', backgroundColor: liveStockSim.isNegative ? '#fef2f2' : 'inherit' }}>
                            <td style={{ padding: '8px' }}>{liveStockSim.storehouseName}</td>
                            <td style={{ padding: '8px' }}>{liveStockSim.current} {liveStockSim.unit}</td>
                            <td style={{ padding: '8px', color: (watchTxType === 'صادر' || watchTxType === 'مستهلك' || watchTxType === 'تحويل' || (watchTxType==='تسوية'&&watchQty<0)) ? '#ef4444' : '#10b981' }}>
                              {(watchTxType === 'صادر' || watchTxType === 'مستهلك' || watchTxType === 'تحويل' || (watchTxType==='تسوية'&&watchQty<0)) ? '-' : '+'}{watchQty || 0}
                            </td>
                            <td style={{ padding: '8px', fontWeight: 'bold', color: liveStockSim.isNegative ? '#ef4444' : 'inherit' }}>
                              {liveStockSim.simulated} {liveStockSim.unit}
                            </td>
                          </tr>
                          {watchTxType === 'تحويل' && watchDestStorehouse && (
                            <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                              <td style={{ padding: '8px' }}>{watchDestStorehouse}</td>
                              <td style={{ padding: '8px' }}>{dataService.getItemStockByStorehouse(watchItem.id, watchDestStorehouse)} {liveStockSim.unit}</td>
                              <td style={{ padding: '8px', color: '#10b981' }}>+{watchQty || 0}</td>
                              <td style={{ padding: '8px', fontWeight: 'bold' }}>
                                {dataService.getItemStockByStorehouse(watchItem.id, watchDestStorehouse) + (Number(watchQty) || 0)} {liveStockSim.unit}
                              </td>
                            </tr>
                          )}
                        </>
                      )}
                    </tbody>
                  </table>
                </Box>
                {liveStockSim.isNegative && (
                  <Typography color="error" variant="caption" sx={{ display: 'block', mt: 1, fontWeight: 'bold' }}>
                    خطأ: لا يوجد رصيد كافٍ في المستودع لإتمام الحركة.
                  </Typography>
                )}
              </Box>
            )}

          </Box>
        </DialogContent>
        <DialogActions sx={{ p: 3, justifyContent: 'flex-start', gap: 2 }}>
          <Button
            type="submit"
            variant="contained"
            disabled={liveStockSim?.isNegative || isSubmitting || !watchStorehouse || (watchTxType === 'تحويل' && !watchDestStorehouse)}
            startIcon={isSubmitting ? <CircularProgress size={20} /> : null}
            sx={{ px: 4, py: 1, borderRadius: '10px' }}
          >
            حفظ السند
          </Button>
          <Button onClick={onClose} variant="outlined" sx={{ borderRadius: '10px' }}>
            إلغاء
          </Button>
        </DialogActions>
      </form>
    </Dialog>

    <MaterialFormDialog 
      open={openItemModal} 
      onClose={() => setOpenItemModal(false)}
      selectedMaterial={null}
      onSuccess={handleItemModalSuccess}
      onError={onError}
    />
    </>
  );
}
