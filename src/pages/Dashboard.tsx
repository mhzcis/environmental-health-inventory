import { useState, useEffect } from 'react';
import EmptyState from '../components/EmptyState';
import { 
  Typography, Container, Grid, Paper, Box, Button, Table, TableBody, TableCell, TableRow, TableHead,
  TableContainer, Chip, Alert, Select, MenuItem, FormControl, InputLabel
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { 
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, 
  CartesianGrid, Tooltip as ChartTooltip, Legend
} from 'recharts';

import CategoryIcon from '@mui/icons-material/Category';
import InventoryIcon from '@mui/icons-material/Inventory';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import LaunchIcon from '@mui/icons-material/Launch';

import { dataService } from '../services/dataService';
import { Material, InventoryTransaction } from '../types';
import { buildMaterialWarehouseView, buildTransactionLedger } from '../utils/inventoryLogic';
import { useStorehouse } from '../context/StorehouseContext';
import { renderOption } from '../utils/emoji';


export default function Dashboard() {
  const navigate = useNavigate();
  const { selectedStorehouse, setSelectedStorehouse } = useStorehouse();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [settings, setSettings] = useState(dataService.getSettings());

  useEffect(() => {
    const load = () => {
      setMaterials(dataService.getMaterials());
      setTransactions(dataService.getTransactions());
      setSettings(dataService.getSettings());
    };
    load();
    return dataService.subscribe(load);
  }, []);

  // Compute stats based on filter
  // Dashboard card "Total Items" shows the number of distinct items, which is handled correctly by the central logic (1 main row per item)
  const dashboardMaterials = buildMaterialWarehouseView(materials, selectedStorehouse, settings.storehouses).filter(m => !m.isSubRow);
  
  const totalItems = dashboardMaterials.length;
  

  // Low stock
  const lowStockItems = dashboardMaterials.filter(item => item.currentStock <= item.minimumStock);
  const lowStockCount = lowStockItems.length;

  // Daily & Monthly transactions
  const todayStr = new Date().toISOString().split('T')[0];
  const thisMonthStr = new Date().toISOString().slice(0, 7); // YYYY-MM

  const ledgerTx = buildTransactionLedger(transactions, selectedStorehouse, settings.storehouses, materials);

  const dailyTxCount = ledgerTx.filter(t => t.date === todayStr).length;
  const monthlyTxCount = ledgerTx.filter(t => t.date.startsWith(thisMonthStr)).length;

  // Top 5 recent transactions for the selected storehouse (or all)
  const recentTransactions = [...ledgerTx]
    .sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      if (dateB !== dateA) return dateB - dateA;
      
      const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      
      return b.id.localeCompare(a.id);
    })
    .slice(0, 5);

  // Warnings list
  const warningsList: { id: string; title: string; desc: string; type: 'error' | 'warning' }[] = [];
  
  lowStockItems.slice(0, 5).forEach(item => {
    warningsList.push({
      id: `low-${item.id}`,
      title: `رصيد منخفض 📈 - ${item.name}`,
      desc: `الرصيد المتاح: ${item.currentStock} (حد الأمان: ${item.minimumStock}) - ${item.storageLocation}`,
      type: item.currentStock === 0 ? 'error' : 'warning'
    });
  });

  // Recharts Dynamic Dataset 1: Pie Chart comparing active items per category
  const categoryCounts: { [key: string]: number } = {};
  dashboardMaterials.forEach(item => { // dashboardMaterials is already unique items filtered by warehouse
    const cat = item.category || 'تصنيف عام';
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  });

  const categoryDistributionData = Object.keys(categoryCounts).map((catName, idx) => {
    const colors = ['#007ab7', '#10b981', '#f59e0b', '#7c3aed', '#ec4899', '#3b82f6', '#ef4444'];
    return {
      name: catName,
      value: categoryCounts[catName],
      color: colors[idx % colors.length]
    };
  });

  // Recharts Dynamic Dataset 2: Bar Chart showing active items count per warehouse
  // Recharts Dynamic Dataset 3: Additions vs Withdrawals per warehouse
  const warehouseInOut: { [key: string]: { in: number, out: number } } = {};
  settings.storehouses.forEach(wh => warehouseInOut[wh] = { in: 0, out: 0 });
  ledgerTx.forEach(tx => {
    const wh = tx.storehouse;
    if (!wh || !settings.storehouses.includes(wh)) return;
    if (tx.transactionType === "وارد" || tx.transactionType === "افتتاحي" || (tx.transactionType === "تحويل" && tx.transferType === "in") || (tx.transactionType === "تسوية" && (tx.transferType === "in" || tx.quantity >= 0))) {
      warehouseInOut[wh].in += Math.abs(tx.quantity);
    } else {
      warehouseInOut[wh].out += Math.abs(tx.quantity);
    }
  });
  
  // Calculate most consumed item (current month)
  const thisMonthTx = ledgerTx.filter(t => t.date.startsWith(thisMonthStr) && (t.transactionType === "صادر" || t.transactionType === "مستهلك"));
  const consumptionMap: {[key: string]: {name: string, qty: number}} = {};
  thisMonthTx.forEach(t => {
    if (!consumptionMap[t.itemId]) consumptionMap[t.itemId] = {name: t.itemName, qty: 0};
    consumptionMap[t.itemId].qty += Math.abs(t.quantity);
  });
  let mostConsumedItem = { name: "لا يوجد", qty: 0 };
  Object.values(consumptionMap).forEach(v => {
    if (v.qty > mostConsumedItem.qty) mostConsumedItem = v;
  });

  const warehouseCounts: { [key: string]: number } = {};
  if (selectedStorehouse === 'all') {
    // We can use the full materials list to count warehouse presence safely
    settings.storehouses.forEach((store) => {
      materials.forEach((item) => {
        const stock = item.warehouseStocks?.[store];
        const tracked = Object.prototype.hasOwnProperty.call(item.warehouseStocks || {}, store) || item.storageLocation === store;
        if (tracked && ((typeof stock === 'number' && stock > 0) || item.storageLocation === store)) {
          warehouseCounts[store] = (warehouseCounts[store] || 0) + 1;
        }
      });
    });
  } else {
    // If a specific warehouse is selected, only that warehouse should have a bar, and its count is exactly the number of items
    warehouseCounts[selectedStorehouse] = dashboardMaterials.length;
  }

  const warehouseDistributionData = Object.keys(warehouseCounts).map((whName, idx) => {
    const colors = ['#007ab7', '#3b82f6', '#0284c7', '#0369a1', '#075985'];
    return {
      name: whName,
      count: warehouseCounts[whName],
      color: colors[idx % colors.length]
    };
  });

  return (
    <Container maxWidth="xl" sx={{ mt: 1, px: 2, direction: 'rtl' }}>
      {/* Title */}
      <Box sx={{ mb: 4, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <Box sx={{ textAlign: 'start' }}>
          <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#1e293b' }}>
            مراقبة المخزون والموازنات الإدارية البيئية
          </Typography>
          <Typography variant="body2" sx={{ color: '#64748b', mt: 0.5 }}>
            بيانات تفصيلية حية لمتغيرات الأرصدة المتوفرة، حركات الصرف، ومؤشرات التوريد اللوجستي بمكتب خان يونس
          </Typography>
        </Box>
        <FormControl size="small" sx={{ minWidth: 220, bgcolor: '#fff' }}>
          <InputLabel>المستودع الرئيسي المعتمد</InputLabel>
          <Select
            value={selectedStorehouse}
            label="المستودع الرئيسي المعتمد"
            onChange={(e) => { void setSelectedStorehouse(e.target.value).catch(() => {}); }}
            sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold' }}
          >
            <MenuItem value="all" sx={{ fontWeight: 'bold' }}>{renderOption("جميع المستودعات (شامل)")}</MenuItem>
            {settings.storehouses.map((wh) => (
              <MenuItem key={wh} value={wh}>{renderOption(wh, "storehouse")}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>


      {/* KPI Cards Grid */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        {/* KPI 1 */}
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Paper sx={{ p: 2.5, }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#64748b' }}>إجمالي الأصناف بالمستودعات</Typography>
                <Typography variant="h4" sx={{ fontWeight: 'bold', color: '#1e293b', mt: 1 }}>{totalItems}</Typography>
              </Box>
              <Box sx={{ p: 1.5, bgcolor: '#ecfdf5', color: '#059669', borderRadius: '12px' }}>
                <CategoryIcon />
              </Box>
            </Box>
            <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mt: 1.5 }}>
              الأصناف المسجلة بنشاط بالنظام
            </Typography>
          </Paper>
        </Grid>

        {/* KPI 2 */}
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Paper sx={{ p: 2.5, border: '1px solid #f1f5f9' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#64748b' }}>أكثر المواد استهلاكاً (الشهر)</Typography>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#007ab7', mt: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '140px' }} title={mostConsumedItem.name}>
                  {mostConsumedItem.name}
                </Typography>
              </Box>
              <Box sx={{ p: 1.5, bgcolor: '#eff6ff', color: '#007ab7', borderRadius: '12px' }}>
                <InventoryIcon />
              </Box>
            </Box>
            <Typography variant="caption" sx={{ color: '#007ab7', display: 'block', mt: 1.5, fontWeight: 'bold' }}>
              بحجم استهلاك: {mostConsumedItem.qty} وحدة
            </Typography>
          </Paper>
        </Grid>

        {/* KPI 3 */}
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Paper sx={{ p: 2.5, bgcolor: lowStockCount > 0 ? 'rgba(239,68,68,0.01)' : 'white' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#64748b' }}>الأصناف الشحيحة (تحت الحد)</Typography>
                <Typography variant="h4" sx={{ fontWeight: 'bold', color: lowStockCount > 0 ? '#ef4444' : '#059669', mt: 1 }}>
                  {lowStockCount}
                </Typography>
              </Box>
              <Box sx={{ p: 1.5, bgcolor: '#fff1f2', color: '#f43f5e', borderRadius: '12px' }}>
                <WarningAmberIcon />
              </Box>
            </Box>
            <Typography variant="caption" sx={{ color: lowStockCount > 0 ? '#ef4444' : '#059669', display: 'block', mt: 1.5, fontWeight: 'bold' }}>
              {lowStockCount > 0 ? 'يتطلب تزويداً عاجلاً للمستودعات' : 'مستويات الأرصدة ممتازة'}
            </Typography>
          </Paper>
        </Grid>

        {/* KPI 4 */}
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Paper sx={{ p: 2.5, border: '1px solid #f1f5f9' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#64748b' }}>حركات التوريد والصرف (الشهر)</Typography>
                <Typography variant="h4" sx={{ fontWeight: 'bold', color: '#7c3aed', mt: 1 }}>{monthlyTxCount}</Typography>
              </Box>
              <Box sx={{ p: 1.5, bgcolor: '#faf5ff', color: '#7c3aed', borderRadius: '12px' }}>
                <ReceiptLongIcon />
              </Box>
            </Box>
            <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mt: 1.5 }}>
              حركات اليوم المسجلة: <strong>{dailyTxCount} حركة هامة</strong>
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {/* Charts and Alerts Section */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        {/* Charts Panel */}
        <Grid size={{ xs: 12, lg: 8 }}>
          <Grid container spacing={3}>
            {/* Chart 1: Category Distribution */}
            <Grid size={{ xs: 12, md: 6 }}>
              <Paper sx={{ p: 3, display: 'flex', flexDirection: 'column', height: 320 }}>
                <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#334155', mb: 2, textAlign: 'start' }}>
                  توزيع الأصناف حسب التصنيف الإداري
                </Typography>
                <Box sx={{ flexGrow: 1, minHeight: 220, position: 'relative' }}>
                  {categoryDistributionData.length > 0 ? (
                    <div dir="ltr" style={{ width: '100%', height: '100%' }}>
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie
                          data={categoryDistributionData}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={80}
                          paddingAngle={3}
                          dataKey="value"
                        >
                          {categoryDistributionData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Pie>
                        <ChartTooltip formatter={(value) => `${value} صنف`} />
                        <Legend verticalAlign="bottom" height={36} iconType="circle" />
                      </PieChart>
                    </ResponsiveContainer>
                    </div>
                  ) : (
                    <EmptyState message="لا يوجد أصناف لعرضها" minHeight="100%" />
                  )}
                </Box>
              </Paper>
            </Grid>

            {/* Chart 2: Items per Warehouse */}
            <Grid size={{ xs: 12, md: 6 }}>
              <Paper sx={{ p: 3, display: 'flex', flexDirection: 'column', height: 320 }}>
                <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#334155', mb: 2, textAlign: 'start' }}>
                  تعددية الأصناف حسب مواقع التخزين والمستودعات
                </Typography>
                <Box sx={{ flexGrow: 1, minHeight: 220, position: 'relative' }}>
                  {warehouseDistributionData.length > 0 ? (
                    <div dir="ltr" style={{ width: '100%', height: '100%' }}>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={warehouseDistributionData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="name" stroke="#94a3b8" fontSize={10} tickLine={false} />
                        <YAxis orientation="right" stroke="#94a3b8" fontSize={11} width={25} />
                        <ChartTooltip formatter={(value) => `${value} صنف`} />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {warehouseDistributionData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    </div>
                  ) : (
                    <EmptyState message="لا يوجد مستودعات لعرضها" minHeight="100%" />
                  )}
                </Box>
              </Paper>
            </Grid>
          </Grid>
        </Grid>

        {/* Alerts and Quick Warnings Panel */}
        <Grid size={{ xs: 12, lg: 4 }}>
          <Paper sx={{ p: 3, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 320 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2.5 }}>
              <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#1e293b' }}>
                تنبيهات عجز التوريدات وأرصدة الأمان
              </Typography>
              <Chip label={warningsList.length} color={warningsList.length > 0 ? 'error' : 'success'} size="small" sx={{ fontWeight: 'bold' }} />
            </Box>

            <Box sx={{ flexGrow: 1, overflowY: 'auto', maxHeight: 180, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {warningsList.length > 0 ? (
                warningsList.map((warn, idx) => (
                  <Alert 
                    key={`${warn.id}-${idx}`}
                    severity={warn.type}
                    variant="outlined"
                    onClose={() => {}}
                    sx={{ 
                      borderRadius: '12px', 
                      direction: 'rtl',
                      textAlign: 'start',
                      alignItems: 'center',
                      '& .MuiAlert-message': { width: '100%' },
                      '& .MuiAlert-icon': { ml: 1.5, mr: 0 },
                      '& .MuiAlert-action': { pl: 0, pr: 2, mr: 'auto', ml: 0 },
                      borderColor: warn.type === 'error' ? '#fca5a5' : '#fde047',
                      bgcolor: warn.type === 'error' ? 'rgba(254, 226, 226, 0.2)' : 'rgba(254, 243, 199, 0.15)'
                    }}
                  >
                    <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#1e293b', fontSize: '0.8rem' }}>
                      {warn.title}
                    </Typography>
                    <Typography variant="caption" sx={{ color: '#475569', display: 'block', mt: 0.5 }}>
                      {warn.desc}
                    </Typography>
                  </Alert>
                ))
              ) : (
                <Box sx={{ py: 4, textAlign: 'center', color: '#94a3b8' }}>
                  <Typography variant="body2" sx={{ fontStyle: 'italic', fontSize: '0.85rem' }}>
                    ✅ رائع! لا يوجد أي عجز أو شح في رصيد أمان الأصناف اللوجستية المسجلة حالياً.
                  </Typography>
                </Box>
              )}
            </Box>

            <Button
              fullWidth
              variant="contained"
              endIcon={<LaunchIcon sx={{ mr: 0.5, fontSize: '0.9rem' }} />}
              onClick={() => navigate('/materials')}
              sx={{ mt: 2, borderRadius: '12px', py: 1.5, fontSize: '0.85rem', fontWeight: 'bold', bgcolor: '#007ab7', color: 'white', boxShadow: '0 4px 6px -1px rgba(0, 122, 183, 0.2), 0 2px 4px -1px rgba(0, 122, 183, 0.1)', '&:hover': { bgcolor: '#006293', boxShadow: '0 6px 8px -1px rgba(0, 122, 183, 0.3)' } }}
            >
              عرض الأصناف وإضافة الأرصدة
            </Button>
          </Paper>
        </Grid>
      </Grid>

      {/* Recent Transactions Table */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, justifyContent: 'space-between', alignItems: { xs: 'stretch', sm: 'center' }, mb: 2.5, gap: 1.5 }}>
          <Box sx={{ textAlign: 'start' }}>
            <Typography variant="body1" sx={{ fontWeight: 'bold', color: '#1e293b' }}>
              آخر الحركات السنوية والمستندات المسجلة
            </Typography>
            <Typography variant="caption" sx={{ color: '#64748b' }}>
              تتبع فوري لأحدث إيصالات التوريد، أذونات التحويل والصرف اللوجستي المنفذة
            </Typography>
          </Box>
          <Button 
            variant="contained" 
            endIcon={<LaunchIcon sx={{ mr: 0.5, fontSize: '0.9rem' }} />} 
            onClick={() => navigate('/transactions')}
            sx={{ py: 1.5, fontSize: '0.85rem', fontWeight: 'bold', bgcolor: '#007ab7', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 122, 183, 0.2), 0 2px 4px -1px rgba(0, 122, 183, 0.1)', '&:hover': { bgcolor: '#006293', boxShadow: '0 6px 8px -1px rgba(0, 122, 183, 0.3)' } }}
          >
            عرض كافة الحركات المخزنية
          </Button>
        </Box>

        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ bgcolor: '#f8fafc' }}>
                <TableCell sx={{ fontWeight: 'bold', py: 1.5 }}>رقم الحركة</TableCell>
                <TableCell sx={{ fontWeight: 'bold', py: 1.5 }}>اسم الصنف وتصنيفه</TableCell>
                <TableCell align="center" sx={{ fontWeight: 'bold', py: 1.5 }}>نوع الحركة</TableCell>
                <TableCell align="center" sx={{ fontWeight: 'bold', py: 1.5 }}>الكمية</TableCell>
                <TableCell align="center" sx={{ fontWeight: 'bold', py: 1.5 }}>الرصيد بعد التنفيذ</TableCell>
                <TableCell sx={{ fontWeight: 'bold', py: 1.5 }}>الجهة المسؤولة / الملاحظة</TableCell>
                <TableCell sx={{ fontWeight: 'bold', py: 1.5 }}>تاريخ التسجيل</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recentTransactions.map((tx, idx) => {
                let colorClass = { bg: '#e0f2fe', text: '#007ab7' };
                if (tx.transactionType === 'افتتاحي') colorClass = { bg: '#dcfce7', text: '#15803d' };
                if (tx.transactionType === 'صادر') colorClass = { bg: '#fee2e2', text: '#b91c1c' };
                if (tx.transactionType === 'مستهلك') colorClass = { bg: '#fffbeb', text: '#b45309' };
                if (tx.transactionType === 'تحويل') colorClass = { bg: '#f3e8ff', text: '#6b21a8' };
                if (tx.transactionType === 'تسوية') colorClass = { bg: '#f1f5f9', text: '#475569' };

                const isInbound = 
                  tx.transactionType === 'وارد' || 
                  tx.transactionType === 'افتتاحي' || 
                  (tx.transactionType === 'تحويل' && tx.transferType === 'in') || 
                  (tx.transactionType === 'تسوية' && (tx.transferType === 'in' || tx.quantity >= 0));

                return (
                  <TableRow key={`${tx.id}-${idx}`} sx={{ '&:hover': { bgcolor: '#f8fafc' } }}>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 600, color: '#64748b' }}><span dir="ltr">{tx.transactionNumber || '---'}</span></TableCell>
                    <TableCell sx={{ fontWeight: 'bold' }}>
                      {tx.itemName} 
                      <Typography variant="caption" sx={{ color: '#007ab7', display: 'block' }}>
                        📦 <span dir="ltr">{tx.itemCode}</span> • 🏢 {tx.storehouse || 'المخزن الرئيسي'}
                      </Typography>
                    </TableCell>
                    <TableCell align="center">
                      <Chip label={tx.transactionType} size="small" sx={{ bgcolor: colorClass.bg, color: colorClass.text, fontWeight: 'bold', height: 22, fontSize: '10px' }} />
                    </TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold', color: isInbound ? '#15803d' : '#ef4444' }}>
                      <span dir="ltr">{isInbound ? '+' : '-'}{tx.quantity}</span>
                    </TableCell>
                    <TableCell align="center" sx={{ fontWeight: 'bold' }}>{tx.displayStockAfter ?? tx.stockAfter}</TableCell>
                    <TableCell sx={{ fontSize: '0.82rem', color: '#475569' }}>{tx.supplierOrReceiver || tx.notes || 'غير محدد'}</TableCell>
                    <TableCell sx={{ color: '#64748b', fontSize: '0.8rem' }}>{tx.date}</TableCell>
                  </TableRow>
                );
              })}
              {recentTransactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 4, color: '#94a3b8', fontStyle: 'italic' }}>
                    لا توجد حركات مسجلة بالنظام حالياً.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Container>
  );
}
