import React, { useRef, useState } from 'react';
import { 
  Box, CssBaseline, AppBar, Toolbar, Typography, Drawer, List, ListItem, 
  ListItemButton, ListItemIcon, ListItemText, Avatar, Divider, Chip, IconButton,
  MenuItem, Button, Popover, Dialog, DialogTitle, DialogContent, 
  DialogContentText, DialogActions, Menu
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/Dashboard';
import InventoryIcon from '@mui/icons-material/Inventory';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import AssessmentIcon from '@mui/icons-material/Assessment';
import SettingsIcon from '@mui/icons-material/Settings';
import NotificationsIcon from '@mui/icons-material/Notifications';
import HistoryIcon from '@mui/icons-material/History';
import ElectricBoltIcon from '@mui/icons-material/ElectricBolt';
import MenuIcon from '@mui/icons-material/Menu';
import ExitToAppIcon from '@mui/icons-material/ExitToApp';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckIcon from '@mui/icons-material/Check';
import StorefrontIcon from '@mui/icons-material/Storefront';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  dataService,
  monitoringPhaseArabicLabel,
  monitoringPhaseColor,
  pendingDeliveryCount,
} from '../services/dataService';
import { buildMaterialWarehouseView } from '../utils/inventoryLogic';
import { useThemeMode } from '../theme/ThemeContext';
import { useStorehouse } from '../context/StorehouseContext';
import { OperationalAlertBanner } from '../components/OperationalAlertBanner';
import { ServiceWorkerHealthIndicator } from '../components/ServiceWorkerHealthIndicator';
import { StorageHealthIndicator } from '../components/StorageHealthIndicator';
import { syncErrorSavedNotice } from '../services/syncPersistenceState';
import { safeUserMessage, safeUserMessages } from '../services/safeUserMessage';

const drawerWidth = 285;

interface Props {
  children: React.ReactNode;
}

export default function AppLayout({ children }: Props) {
  const { mode, toggleColorMode } = useThemeMode();
  const { selectedStorehouse, activeStorehouses, setSelectedStorehouse } = useStorehouse();
  const navigate = useNavigate();

  const location = useLocation();
  const [, setUpdateKey] = useState(0);

  React.useEffect(() => {
    return dataService.subscribe(() => {
      setUpdateKey((prev) => prev + 1);
    });
  }, []);

  const settings = dataService.getSettings();
  const currentUser = dataService.getCurrentUser();
  
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notifAnchorEl, setNotifAnchorEl] = useState<null | HTMLElement>(null);
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const [logoutTimer, setLogoutTimer] = useState(5);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const logoutInFlightRef = useRef(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [storehouseAnchorEl, setStorehouseAnchorEl] = useState<null | HTMLElement>(null);
  const [resolvingSyncIssueId, setResolvingSyncIssueId] = useState<string | null>(null);
  const isStorehouseMenuOpen = Boolean(storehouseAnchorEl);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input, textarea, or contenteditable
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.getAttribute('contenteditable') === 'true')
      ) {
        return;
      }

      // Check Alt key shortcuts (Alt + number)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        let targetPath: string | null = null;
        let permission: string | null = null;

        if (e.key === '1') {
          targetPath = '/';
          permission = 'dashboard_view';
        } else if (e.key === '2') {
          targetPath = '/materials';
          permission = 'materials_view';
        } else if (e.key === '3') {
          targetPath = '/transactions';
          permission = 'transactions_view';
        } else if (e.key === '4') {
          targetPath = '/reports';
          permission = 'reports_view';
        } else if (e.key === '5') {
          targetPath = '/audit';
          permission = 'audit_view';
        } else if (e.key === '6') {
          targetPath = '/settings';
          permission = 'settings_view';
        }

        if (targetPath && permission && dataService.hasPermission(permission)) {
          e.preventDefault();
          navigate(targetPath);
        }
      }

      // Alt + / or Shift + ? (when not in input) to toggle shortcuts helper dialog
      if ((e.altKey && e.key === '/') || (e.key === '?' && e.shiftKey)) {
        e.preventDefault();
        setShortcutsHelpOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  React.useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (logoutDialogOpen) {
      setLogoutTimer(5);
      interval = setInterval(() => {
        setLogoutTimer((prev) => {
          if (prev <= 1) {
            if (interval) clearInterval(interval);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      setLogoutTimer(5);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [logoutDialogOpen]);

  const performLogout = async () => {
    if (logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    setIsLoggingOut(true);
    try {
      const result = await dataService.logout();
      if (result.failures.length > 0) {
        // The service has already completed every local security step. Keep diagnostics visible
        // to operators without converting best-effort audit/cloud failures into an unhandled UI
        // rejection or reopening the authenticated layout.
        console.error('Logout completed with best-effort failures', result.failures);
      }
    } catch (error) {
      // Defensive boundary: logout currently aggregates failures, but the UI must remain safe if
      // an unexpected implementation error escapes in a future change.
      console.error('Unexpected logout failure', error);
    } finally {
      navigate('/', { replace: true });
    }
  };

  const handleLogoutAttempt = async () => {
    if (logoutInFlightRef.current) return;
    if (dataService.hasUnbackedUpChanges()) {
      setLogoutDialogOpen(true);
    } else {
      await performLogout();
    }
  };

  const handleConfirmLogoutOnly = async () => {
    if (logoutInFlightRef.current) return;
    setLogoutDialogOpen(false);
    await performLogout();
  };

  const handleConfirmBackupAndLogout = () => {
    setLogoutDialogOpen(false);
    navigate('/settings?triggerBackup=true');
  };

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

  const handleNotifClick = (event: React.MouseEvent<HTMLElement>) => {
    setNotifAnchorEl(event.currentTarget);
  };

  const handleNotifClose = () => {
    setNotifAnchorEl(null);
  };

  const handleResolveSyncIssue = async (
    id: string,
    action: 'retry-blocked' | 'use-local' | 'use-remote',
  ) => {
    if (action === 'use-local' && !window.confirm('سيتم اعتماد التغيير المحلي فوق النسخة السحابية الحالية بعد فحصها مجدداً. هل تريد المتابعة؟')) return;
    if (action === 'use-remote' && !window.confirm('سيتم إلغاء التغيير المحلي المتعارض واعتماد النسخة السحابية. لا يمكن التراجع عن هذا القرار. هل تريد المتابعة؟')) return;
    setResolvingSyncIssueId(id);
    await dataService.resolveSyncIssue(id, action);
    setResolvingSyncIssueId(null);
  };

  const menuItems = [
    { text: 'لوحة التحكم', icon: <DashboardIcon />, path: '/', permission: 'dashboard_view', shortcutKey: '1' },
    { text: 'إدارة الأصناف والمخزون', icon: <InventoryIcon />, path: '/materials', permission: 'materials_view', shortcutKey: '2' },
    { text: 'الحركات المخزنية', icon: <ReceiptLongIcon />, path: '/transactions', permission: 'transactions_view', shortcutKey: '3' },
    { text: 'سجل تشغيل المولد', icon: <ElectricBoltIcon />, path: '/generator-log', permission: 'generator_log' },
    { text: 'التقارير الشاملة', icon: <AssessmentIcon />, path: '/reports', permission: 'reports_view', shortcutKey: '4' },
    { text: 'سجل العمليات', icon: <HistoryIcon />, path: '/audit', permission: 'audit_view', shortcutKey: '5' },
    { text: 'الإعدادات العامة', icon: <SettingsIcon />, path: '/settings', permission: 'settings_view', shortcutKey: '6' },
  ].filter(item => dataService.hasPermission(item.permission));

  const routePermissions: Record<string, string> = {
    '/': 'dashboard_view',
    '/materials': 'materials_view',
    '/pesticides': 'materials_view',
    '/transactions': 'transactions_view',
    '/generator-log': 'generator_log',
    '/reports': 'reports_view',
    '/audit': 'audit_view',
    '/settings': 'settings_view'
  };

  const currentRoutePermission = routePermissions[location.pathname];
  const isAuthorized = !currentRoutePermission || dataService.hasPermission(currentRoutePermission);

  // Calculate some quick critical warning counts using active selected storehouse
  const rawMaterials = dataService.getMaterials();
  const materials = buildMaterialWarehouseView(rawMaterials, selectedStorehouse, activeStorehouses.map((warehouse) => warehouse.name)).filter(m => !m.isSubRow);
  const lowStockCount = materials.filter(m => m.currentStock <= m.minimumStock).length;

  const expiredOrWarningMaterials = materials.filter(m => {
    if (!m.expiryDate) return false;
    const status = dataService.getPesticideExpiryStatus(m.expiryDate, settings.expiryWarningThresholdDays);
    return status === 'expired' || status === 'critical' || status === 'warning';
  }).length;

  const totalAlerts = lowStockCount + expiredOrWarningMaterials;

  // Compile specific detailed alerts for notifications
  const activeAlerts: { id: string; title: string; desc: string; type: 'stock' | 'expiry' }[] = [];

  materials.filter(m => m.currentStock <= m.minimumStock).forEach(m => {
    activeAlerts.push({
      id: `stock-${m.id}`,
      title: `رصيد حرج: ${m.name}`,
      desc: `الرصيد المتاح حالياً (${m.currentStock} ${m.unit}) تحت حد الأمان المطلوب (${m.minimumStock}) بـ ${m.storageLocation}.`,
      type: 'stock',
    });
  });

  materials.filter(m => {
    if (!m.expiryDate) return false;
    const status = dataService.getPesticideExpiryStatus(m.expiryDate, settings.expiryWarningThresholdDays);
    return status === 'expired' || status === 'critical' || status === 'warning';
  }).forEach(m => {
    const status = dataService.getPesticideExpiryStatus(m.expiryDate!, settings.expiryWarningThresholdDays);
    let label = 'صلاحية منتهية';
    if (status === 'critical') label = 'صلاحية حرجة';
    if (status === 'warning') label = 'تنبيه قرب الصلاحية';
    activeAlerts.push({
      id: `expiry-${m.id}`,
      title: `${label}: ${m.name}`,
      desc: `صلاحية المادة ستنتهي في (${m.expiryDate}) وتتطلب فحصاً فورياً.`,
      type: 'expiry',
    });
  });

  const openNotif = Boolean(notifAnchorEl);

  const drawerContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between', bgcolor: 'secondary.main', color: 'secondary.contrastText' }}>
      <Box>
        {/* Sidebar Logo */}
        <Box sx={{ p: { xs: 2, sm: 2.5 }, display: 'flex', alignItems: 'center', gap: 2, borderBottom: '1px solid', borderColor: 'divider', minHeight: 88 }}>
          <Box sx={{ 
            width: 46, 
            height: 46, 
            background: 'linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%)', 
            borderRadius: '12px', 
            boxShadow: '0 8px 16px -4px rgba(37, 99, 235, 0.5)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            flexShrink: 0 
          }}>
            <InventoryIcon sx={{ color: 'white', fontSize: 24 }} />
          </Box>
          <Box sx={{ textAlign: 'right', overflow: 'hidden', flexGrow: 1 }}>
            <Typography variant="h6" sx={{ 
              fontWeight: 800, 
              fontSize: '1.1rem', 
              color: 'secondary.contrastText', 
              fontFamily: '"Cairo", sans-serif', 
              textOverflow: 'ellipsis', 
              overflow: 'hidden', 
              whiteSpace: 'nowrap',
              lineHeight: 1.2,
              letterSpacing: '-0.01em'
            }}>
              نظام إدارة المخزون
            </Typography>
            <Typography variant="caption" sx={{ 
              color: 'secondary.contrastText',
              opacity: 0.6, 
              fontSize: '0.75rem', 
              fontWeight: 600,
              display: 'inline-block', 
              fontFamily: '"Cairo", sans-serif', 
              mt: 0.5,
              ml: 0.5,
            }}>
              برمجة وتطوير
            </Typography>
            <Typography variant="caption" sx={{ 
              color: '#38bdf8',
              fontSize: '0.75rem', 
              fontWeight: 700,
              display: 'inline-block', 
              fontFamily: '"Cairo", sans-serif', 
            }}>
              م. محمد أبو زهري
            </Typography>
          </Box>
        </Box>

        {/* Navigation Links */}
        <Box sx={{ mt: 2, px: 1.5 }}>
          <List>
            {menuItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <ListItem key={item.text} disablePadding sx={{ mb: 0.5 }}>
                  <ListItemButton 
                    onClick={() => {
                      navigate(item.path);
                      setMobileOpen(false);
                    }}
                    sx={{ 
                      borderRadius: '12px', 
                      bgcolor: isActive ? 'primary.main' : 'transparent',
                      backgroundImage: isActive ? 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0) 100%)' : 'none',
                      boxShadow: isActive ? '0 4px 12px -2px rgba(0, 0, 0, 0.2)' : 'none',
                      '&:hover': { bgcolor: isActive ? 'primary.dark' : 'rgba(255,255,255,0.08)' },
                      color: isActive ? '#ffffff' : 'secondary.contrastText', opacity: isActive ? 1 : 0.8,
                      transition: 'all 0.15s ease-in-out',
                      py: 1.2,
                      px: 2,
                    }}
                  >
                    <ListItemIcon sx={{ color: isActive ? '#ffffff' : 'secondary.contrastText', opacity: isActive ? 1 : 0.6, minWidth: 42, display: 'flex', justifyContent: 'center' }}>
                      {item.icon}
                    </ListItemIcon>
                    <ListItemText 
                      primary={
                        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                          <Typography sx={{ color: isActive ? '#ffffff' : '#cbd5e1', fontSize: '0.85rem', fontWeight: isActive ? '700' : '500', fontFamily: '"Cairo", sans-serif', textAlign: 'right' }}>
                            {item.text}
                          </Typography>
                          {item.shortcutKey && (
                            <Box 
                              className="no-print-area" 
                              sx={{ 
                                display: { xs: 'none', lg: 'inline-flex' }, 
                                alignItems: 'center', 
                                justifyContent: 'center', 
                                px: 0.8, 
                                py: 0.2, 
                                borderRadius: '4px', 
                                bgcolor: isActive ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)',
                                border: isActive ? '1px solid rgba(255,255,255,0.35)' : '1px solid rgba(255,255,255,0.1)',
                                color: isActive ? '#ffffff' : 'rgba(255,255,255,0.55)',
                                fontSize: '10px',
                                fontFamily: 'monospace',
                                fontWeight: 'bold',
                                ml: 1,
                                height: '16px',
                                direction: 'ltr'
                              }}
                            >
                              Alt+{item.shortcutKey}
                            </Box>
                          )}
                        </Box>
                      } 
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        </Box>
      </Box>

      {/* User profile footer */}
      <Box sx={{ p: 2, bgcolor: '#0b0f19', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        {/* User Card */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
          <Avatar sx={{ bgcolor: '#007ab7', width: 32, height: 32, fontSize: '0.8rem', fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>
            {currentUser.fullName.charAt(0)}
          </Avatar>
          <Box sx={{ display: 'flex', flexDirection: 'column', textAlign: 'right', flexGrow: 1, overflow: 'hidden' }}>
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#ffffff', fontFamily: '"Cairo", sans-serif', fontSize: '0.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {currentUser.fullName}
            </Typography>
            <Typography variant="caption" sx={{ color: '#94a3b8', fontFamily: '"Cairo", sans-serif', fontSize: '0.7rem' }}>
              {currentUser.role}
            </Typography>
          </Box>
          <IconButton 
            onClick={handleLogoutAttempt} 
            title="تسجيل الخروج"
            sx={{ 
              color: '#ef4444', 
              bgcolor: 'rgba(239, 68, 68, 0.15)', 
              p: 0.5,
              borderRadius: '6px',
              '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.25)' } 
            }}
          >
            <ExitToAppIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>

        
        {/* Sync Status Flag & Theme Toggle */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {(() => {
              // P9: bind status to MonitoringHealth.phase — never CLOUD_MONITORING_ENABLED alone.
              const health = dataService.getMonitoringHealth();
              const statusText = monitoringPhaseArabicLabel(health.phase);
              const statusColor = monitoringPhaseColor(health.phase);

              return (
                <>
                  <Box 
                    sx={{ 
                      width: 8, 
                      height: 8, 
                      borderRadius: '50%', 
                      bgcolor: statusColor,
                      boxShadow: `0 0 8px ${statusColor}`
                    }} 
                  />
                  <Typography variant="caption" sx={{ color: statusColor, fontWeight: 'bold', fontFamily: '"Cairo", sans-serif', fontSize: '0.75rem' }}>
                    {statusText}
                  </Typography>
                </>
              );
            })()}
          </Box>
          <IconButton 
 
            onClick={toggleColorMode} 
            sx={{ color: '#94a3b8', p: 0.5, '&:hover': { color: '#ffffff', bgcolor: 'rgba(255,255,255,0.1)' } }}
            title="تبديل المظهر"
          >
            {mode === 'dark' ? <LightModeIcon sx={{ fontSize: 18 }} /> : <DarkModeIcon sx={{ fontSize: 18 }} />}
          </IconButton>
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', bgcolor: 'var(--mui-palette-background-default)', minHeight: '100vh', direction: 'rtl' }}>
      <CssBaseline />
      
      {/* Top Header */}
      <AppBar 
        position="fixed" 
        sx={{ 
          width: '100%',
          mr: 0,
          ml: 0,
          bgcolor: '#0f172a', 
          color: '#ffffff', 
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.08)', 
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          zIndex: (theme) => theme.zIndex.drawer + 1
        }}
      >
        <Toolbar sx={{ justifyContent: 'space-between', px: { xs: 2, sm: 3 } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1.5 } }}>
            <IconButton
              color="inherit"
              aria-label="toggle drawer"
              edge="start"
              onClick={handleDrawerToggle}
              sx={{ ml: 1, display: 'inline-flex', p: 0.5 }}
            >
              <MenuIcon />
            </IconButton>
            <Box sx={{ textAlign: 'right' }}>
              <Typography variant="h6" sx={{ fontWeight: 'bold', fontSize: { xs: '0.9rem', sm: '1.15rem' }, color: '#ffffff', fontFamily: '"Cairo", sans-serif', maxWidth: { xs: '180px', sm: '350px', md: '100%' }, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {settings.organizationName}
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 600, color: '#38bdf8', fontSize: { xs: '0.7rem', sm: '0.85rem' }, fontFamily: '"Cairo", sans-serif', display: 'block', maxWidth: { xs: '180px', sm: '350px', md: '100%' }, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {settings.departmentName}
              </Typography>
            </Box>
          </Box>
          
          <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 1.5 } }}>
            {/* Global Storehouse Selector - Sleek Pill & Menu */}
            <Box>
              <Button
                onClick={(e) => setStorehouseAnchorEl(e.currentTarget)}
                aria-label="تحديد المستودع النشط"
                endIcon={<ExpandMoreIcon sx={{ fontSize: '18px !important', color: '#38bdf8', transition: 'transform 0.2s', transform: isStorehouseMenuOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} />}
                startIcon={<StorefrontIcon sx={{ fontSize: '18px !important', color: '#38bdf8' }} />}
                sx={{
                  bgcolor: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: '20px',
                  px: { xs: 1.2, sm: 1.8 },
                  py: 0.5,
                  color: '#ffffff',
                  fontWeight: 'bold',
                  fontSize: { xs: '0.75rem', sm: '0.85rem' },
                  fontFamily: '"Cairo", sans-serif',
                  textTransform: 'none',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s ease',
                  boxShadow: 'none',
                  '&:hover': {
                    bgcolor: 'rgba(255,255,255,0.15)',
                    borderColor: '#38bdf8',
                    boxShadow: '0 0 10px rgba(56, 189, 248, 0.2)'
                  }
                }}
              >
                <Box component="span" sx={{ display: { xs: 'none', md: 'inline' }, opacity: 0.85, ml: 0.5 }}>
                  المستودع:
                </Box>
                <Box component="span" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>
                  {selectedStorehouse === 'all' ? (
                    <>
                      <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>جميع المستودعات</Box>
                      <Box component="span" sx={{ display: { xs: 'inline', sm: 'none' } }}>الكل</Box>
                    </>
                  ) : (
                    selectedStorehouse
                  )}
                </Box>
              </Button>

              <Menu
                anchorEl={storehouseAnchorEl}
                open={isStorehouseMenuOpen}
                onClose={() => setStorehouseAnchorEl(null)}
                slotProps={{
                  paper: {
                    elevation: 6,
                    sx: {
                      mt: 1.5,
                      borderRadius: '14px',
                      minWidth: 230,
                      border: '1px solid #e2e8f0',
                      p: 0.5,
                      boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
                      '& .MuiMenuItem-root': {
                        borderRadius: '8px',
                        my: 0.3,
                        px: 1.5,
                        py: 1,
                        fontFamily: '"Cairo", sans-serif',
                        fontSize: '0.88rem',
                      }
                    }
                  }
                }}
                transformOrigin={{ horizontal: 'right', vertical: 'top' }}
                anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
              >
                <Box sx={{ px: 1.5, py: 1, borderBottom: '1px solid #f1f5f9', mb: 0.5 }}>
                  <Typography variant="caption" sx={{ color: '#64748b', fontWeight: 'bold', fontFamily: '"Cairo", sans-serif', display: 'block' }}>
                    🏢 نطاق التغطية والمستودع النشط
                  </Typography>
                </Box>
                <MenuItem
                  selected={selectedStorehouse === 'all'}
                  onClick={() => {
                    void setSelectedStorehouse('all').catch(() => {});
                    setStorehouseAnchorEl(null);
                  }}
                  sx={{
                    justifyContent: 'space-between',
                    fontWeight: selectedStorehouse === 'all' ? 'bold' : 'normal',
                    color: selectedStorehouse === 'all' ? '#0284c7' : '#334155',
                    bgcolor: selectedStorehouse === 'all' ? '#f0f9ff !important' : 'transparent',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    🌐 جميع المستودعات (شامل)
                  </Box>
                  {selectedStorehouse === 'all' && <CheckIcon sx={{ fontSize: 18, color: '#0284c7' }} />}
                </MenuItem>
                <Divider sx={{ my: 0.5 }} />
                {activeStorehouses.map((warehouse) => (
                  <MenuItem
                    key={warehouse.id}
                    selected={selectedStorehouse === warehouse.name}
                    onClick={() => {
                      void setSelectedStorehouse(warehouse.id).catch(() => {});
                      setStorehouseAnchorEl(null);
                    }}
                    sx={{
                      justifyContent: 'space-between',
                      fontWeight: selectedStorehouse === warehouse.name ? 'bold' : 'normal',
                      color: selectedStorehouse === warehouse.name ? '#0284c7' : '#334155',
                      bgcolor: selectedStorehouse === warehouse.name ? '#f0f9ff !important' : 'transparent',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      🏢 {warehouse.name}
                    </Box>
                    {selectedStorehouse === warehouse.name && <CheckIcon sx={{ fontSize: 18, color: '#0284c7' }} />}
                  </MenuItem>
                ))}
              </Menu>
            </Box>

            <IconButton
              onClick={() => setShortcutsHelpOpen(true)}
              title="اختصارات لوحة المفاتيح (Shift + ?)"
              sx={{ color: '#e2e8f0', p: 0.5, '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' } }}
            >
              <KeyboardIcon sx={{ fontSize: { xs: 20, sm: 24 } }} />
            </IconButton>

            <Box sx={{ position: 'relative', cursor: 'pointer', display: 'flex', alignItems: 'center' }} onClick={handleNotifClick}>
              <NotificationsIcon sx={{ color: '#e2e8f0', fontSize: { xs: 20, sm: 24 } }} />
              {totalAlerts > 0 && (
                <Chip
                  label={totalAlerts}
                  size="small"
                  color="error"
                  sx={{
                    position: 'absolute',
                    top: -10,
                    right: -8,
                    height: 18,
                    minWidth: 18,
                    fontSize: '9px',
                    fontWeight: 'bold',
                    p: 0,
                    '& .MuiChip-label': { px: 0.5 }
                  }}
                />
              )}
            </Box>

            <Popover
              open={openNotif}
              anchorEl={notifAnchorEl}
              onClose={handleNotifClose}
              anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'left',
              }}
              transformOrigin={{
                vertical: 'top',
                horizontal: 'left',
              }}
              slotProps={{
                paper: {
                  sx: {
                    width: 330,
                    maxHeight: 400,
                    borderRadius: '16px',
                    boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
                    border: '1px solid #f1f5f9',
                    p: 2,
                    direction: 'rtl'
                  }
                }
              }}
            >
              <Typography variant="body1" sx={{ fontWeight: 'bold', mb: 1, fontFamily: '"Cairo", sans-serif', color: '#1e293b', textAlign: 'right' }}>
                🔔 التنبيهات والإنذارات المخزنية
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
              
              {activeAlerts.length > 0 ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, maxHeight: 310, overflowY: 'auto', pr: 0.5 }}>
                  {activeAlerts.map((alert) => (
                    <Box key={alert.id} sx={{ p: 1.2, bgcolor: alert.type === 'stock' ? 'rgba(239, 68, 68, 0.04)' : 'rgba(245, 158, 11, 0.04)', borderRadius: '12px', borderLeft: `4px solid ${alert.type === 'stock' ? '#ef4444' : '#f59e0b'}`, textAlign: 'right' }}>
                      <Typography variant="body2" sx={{ fontWeight: 'bold', fontSize: '0.8rem', color: '#0f172a', fontFamily: '"Cairo", sans-serif', mb: 0.5 }}>
                        {alert.title}
                      </Typography>
                      <Typography variant="caption" sx={{ color: '#475569', fontSize: '0.75rem', fontFamily: '"Cairo", sans-serif', display: 'block', lineHeight: 1.4 }}>
                        {alert.desc}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              ) : (
                <Box sx={{ textAlign: 'center', py: 4 }}>
                  <Typography variant="body2" sx={{ color: '#94a3b8', fontStyle: 'italic', fontFamily: '"Cairo", sans-serif' }}>
                    لا توجد تنبيهات عاجلة، الأرصدة آمنة.
                  </Typography>
                </Box>
              )}
            </Popover>
            <Divider orientation="vertical" flexItem sx={{ mx: { xs: 0.5, sm: 1 }, borderColor: 'rgba(255, 255, 255, 0.15)' }} />
            
            <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 0.5, sm: 1.5 } }}>
              <Avatar sx={{ bgcolor: 'primary.main', width: { xs: 28, sm: 36 }, height: { xs: 28, sm: 36 }, fontSize: '0.8rem', fontWeight: 'bold', fontFamily: '"Cairo", sans-serif' }}>
                {currentUser.fullName.charAt(0)}
              </Avatar>
              <Box sx={{ display: { xs: 'none', md: 'flex' }, flexDirection: 'column', textAlign: 'right' }}>
                <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#f8fafc', fontFamily: '"Cairo", sans-serif', lineHeight: 1.2 }}>
                  {currentUser.fullName}
                </Typography>
                <Typography variant="caption" sx={{ color: '#94a3b8', fontFamily: '"Cairo", sans-serif', fontSize: '0.75rem', mt: 0.2 }}>
                  {currentUser.role}
                </Typography>
              </Box>
              <IconButton 
                onClick={handleLogoutAttempt} 
                title="تسجيل الخروج الآمن"
                sx={{ 
                  color: '#f87171', 
                  p: { xs: 0.5, sm: 1 },
                  '&:hover': { bgcolor: 'rgba(248, 113, 113, 0.15)' }
                }}
              >
                <ExitToAppIcon sx={{ fontSize: { xs: 20, sm: 24 } }} />
              </IconButton>
            </Box>
          </Box>
        </Toolbar>
      </AppBar>

      {/* Responsive temporary drawer that slides in from the right and hides when clicking outside */}
      <Drawer
        variant="temporary"
        anchor="left"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{
          keepMounted: true, 
        }}
        sx={{
          [`& .MuiDrawer-paper`]: { 
            width: drawerWidth, 
            boxSizing: 'border-box',
            top: { xs: 56, sm: 64 },
            height: { xs: 'calc(100vh - 56px)', sm: 'calc(100vh - 64px)' },
            borderRight: '1px solid var(--mui-palette-divider)',
            borderLeft: 'none',
            boxShadow: '4px 0 16px rgba(0,0,0,0.1)'
          },
        }}
      >
        {drawerContent}
      </Drawer>

      {/* Main Content Area Container */}
      <Box 
        component="main" 
        sx={{ 
          flexGrow: 1, 
          p: { xs: 2, sm: 3 }, 
          mr: 0, 
          ml: 0,
          width: '100%',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'background.default',
          boxSizing: 'border-box'
        }}
      >
        <Toolbar sx={{ mb: 1 }} /> {/* Spacing helper for fixed AppBar */}
        <OperationalAlertBanner />
        <ServiceWorkerHealthIndicator />
        <StorageHealthIndicator />
        {(() => {
          const health = dataService.getMonitoringHealth();
          // PREPROD-B: raw SDK/queue text never reaches the banner; only allowlisted Arabic text.
          const lastError = health.errors.writeOrEnqueue ? safeUserMessage(health.errors.writeOrEnqueue, 'sync', { allowAppText: true }) : null;
          const pendingWrites = pendingDeliveryCount(health.outbox);
          const monitoringError = safeUserMessages(Object.values(health.errors.monitoringByCollection), 'monitoring', { allowAppText: true }).join(' | ') || null;
          const monitoringDifferences = health.differences;
          const syncIssues = health.syncIssues;

          // Prefer phase-driven banners: ACTION_REQUIRED before sticky errors so quarantined stays distinct.
          if (health.phase === 'ACTION_REQUIRED' || syncIssues.length > 0) {
            return (
              <Box sx={{ mb: 2.5, p: 1.8, bgcolor: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '12px' }}>
                <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', color: '#991b1b', fontWeight: 'bold', mb: 1 }}>
                  {syncIssues.length > 0
                    ? `توجد ${syncIssues.length} عملية مزامنة تحتاج قراراً صريحاً.`
                    : `يلزم إجراء يدوي — تعارضات/محجوب/حجر: ${health.outbox.conflicts + health.outbox.blocked + health.outbox.quarantined} (ليست مجرد مزامنة معلّقة).`}
                </Typography>
                {syncIssues.map(issue => (
                  <Box key={issue.id} sx={{ mt: 1, p: 1.2, bgcolor: 'rgba(255,255,255,0.65)', borderRadius: '8px' }}>
                    <Typography variant="caption" sx={{ display: 'block', fontFamily: '"Cairo", sans-serif', color: '#7f1d1d' }}>
                      {issue.label || issue.id} — {issue.documentKeys.join('، ')}
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                      {issue.status === 'quarantined' ? (
                        <Typography variant="caption" sx={{ color: '#991b1b', fontFamily: '"Cairo", sans-serif' }}>
                          العملية محفوظة في الحجر ولا يمكن إسقاطها أو اعتبارها ناجحة تلقائياً. يلزم فحص يدوي لعقدها القديم.
                        </Typography>
                      ) : issue.status === 'blocked' ? (
                        <Button size="small" variant="outlined" disabled={resolvingSyncIssueId === issue.id} onClick={() => void handleResolveSyncIssue(issue.id, 'retry-blocked')}>
                          إعادة المحاولة
                        </Button>
                      ) : (
                        <>
                          <Button size="small" variant="contained" color="warning" disabled={resolvingSyncIssueId === issue.id} onClick={() => void handleResolveSyncIssue(issue.id, 'use-local')}>
                            اعتماد المحلي
                          </Button>
                          <Button size="small" variant="outlined" color="error" disabled={resolvingSyncIssueId === issue.id} onClick={() => void handleResolveSyncIssue(issue.id, 'use-remote')}>
                            اعتماد السحابة
                          </Button>
                        </>
                      )}
                    </Box>
                  </Box>
                ))}
              </Box>
            );
          }
          
          if (lastError) {
            return (
              <Box 
                sx={{ 
                  mb: 2.5, 
                  p: 1.8, 
                  bgcolor: 'rgba(239, 68, 68, 0.08)', 
                  border: '1px solid rgba(239, 68, 68, 0.25)', 
                  borderRadius: '12px', 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 1.5,
                }}
              >
                <Typography sx={{ fontSize: '1.2rem', display: 'flex', alignItems: 'center' }}>⚠️</Typography>
                <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', color: '#b91c1c', fontWeight: '600', textAlign: 'start', lineHeight: 1.5 }}>
                  خطأ سحابي: {lastError}. {pendingWrites > 0 ? `لديك ${pendingWrites} تغيير(ات) توصيل معلّقة. ` : ""}{syncErrorSavedNotice(dataService.getLastCloudWriteErrorPersistence())}
                </Typography>
              </Box>
            );
          }
          if (monitoringError) {
             return (
               <Box sx={{ mb: 2.5, p: 1.8, bgcolor: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '12px' }}>
                 <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', color: '#b91c1c', fontWeight: 'bold' }}>⚠️ خطأ مراقبة: {monitoringError}</Typography>
               </Box>
             );
          }
          const diffs = monitoringDifferences.filter(d => d.missingLocallyCount > 0 || d.missingCloudCount > 0 || d.contentMismatchCount > 0 || d.duplicateIdsCount > 0 || d.orphanCount > 0 || d.warehouseBalanceDiff > 0);
          if (diffs.length > 0) {
             return (
               <Box sx={{ mb: 2.5, p: 1.8, bgcolor: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)', borderRadius: '12px' }}>
                 <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', color: '#b45309', fontWeight: 'bold' }}>🔍 فرق سحابي مكتشف (وضع المراقبة):</Typography>
                 <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                   {diffs.map(d => (
                     <Box key={d.collection} sx={{ bgcolor: 'rgba(255,255,255,0.5)', p: 1, borderRadius: '4px', fontSize: '12px' }}>
                       <strong>{d.collection}</strong>: 
                       {d.missingLocallyCount > 0 && <span style={{color:'red'}}> مفقود محلياً ({d.missingLocallyCount})</span>}
                       {d.missingCloudCount > 0 && <span style={{color:'red'}}> مفقود سحابياً ({d.missingCloudCount})</span>}
                       {d.contentMismatchCount > 0 && <span style={{color:'orange'}}> اختلاف محتوى ({d.contentMismatchCount})</span>}
                       {d.duplicateIdsCount > 0 && <span style={{color:'red'}}> تكرار ({d.duplicateIdsCount})</span>}
                       {d.orphanCount > 0 && <span style={{color:'red'}}> يتيمة ({d.orphanCount})</span>}
                       {d.warehouseBalanceDiff > 0 && <span style={{color:'orange'}}> فرق أرصدة ({d.warehouseBalanceDiff})</span>}
                     </Box>
                   ))}
                 </Box>
               </Box>
             );
          }
          if (health.phase === 'PENDING') {
            return (
              <Box sx={{ mb: 2.5, p: 1.8, bgcolor: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)', borderRadius: '12px' }}>
                <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', color: '#b45309', fontWeight: 'bold' }}>
                  مزامنة معلّقة: {pendingWrites} عملية توصيل (staging/pending/retrying) — ليست عمليات تتطلب قراراً يدوياً.
                </Typography>
              </Box>
            );
          }
          if (health.phase === 'NOT_READY' || health.phase === 'UNKNOWN') {
            return (
              <Box sx={{ mb: 2.5, p: 1.8, bgcolor: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.25)', borderRadius: '12px' }}>
                <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', color: '#3730a3', fontWeight: 'bold' }}>
                  {health.phase === 'UNKNOWN'
                    ? 'جاري تهيئة المراقبة — لا يوجد دليل جاهزية موثوق بعد.'
                    : `المراقبة غير جاهزة — مجموعات ناقصة: ${health.ready.missing.join('، ') || '—'}.`}
                </Typography>
              </Box>
            );
          }
          if (health.phase === 'OFFLINE' || (settings.cloudSyncEnabled && !health.online)) {
            return (
              <Box 
                sx={{ 
                  mb: 2.5, 
                  p: 1.8, 
                  bgcolor: 'rgba(245, 158, 11, 0.08)', 
                  border: '1px solid rgba(245, 158, 11, 0.25)', 
                  borderRadius: '12px', 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 1.5,
                }}
              >
                <Typography sx={{ fontSize: '1.2rem', display: 'flex', alignItems: 'center' }}>📡</Typography>
                <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', color: '#b45309', fontWeight: '600', textAlign: 'start', lineHeight: 1.5 }}>
                  التطبيق يعمل الآن في وضع التخزين المحلي الآمن (أوفلاين). جميع بياناتك محفوظة محلياً بالكامل.
                </Typography>
              </Box>
            );
          }
          return null;
        })()}
        <Box sx={{ flexGrow: 1 }}>
          {isAuthorized ? (
            children
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 8, px: 2, textAlign: 'center' }}>
              <Box sx={{ width: 80, height: 80, bgcolor: '#fee2e2', color: '#ef4444', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 3 }}>
                <Typography variant="h3" sx={{ fontWeight: 'bold' }}>🔒</Typography>
              </Box>
              <Typography variant="h5" sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold', color: '#1e293b', mb: 1 }}>
                {location.pathname === '/' ? 'لا تمتلك صلاحية عرض لوحة التحكم' : 'عذراً، لا تمتلك الصلاحية الكافية للدخول'}
              </Typography>
              <Typography variant="body1" sx={{ fontFamily: '"Cairo", sans-serif', color: '#64748b', maxWidth: 500, mb: 4, lineHeight: 1.7 }}>
                {location.pathname === '/' ? (
                  'لا يتوفر لحسابك صلاحية استعراض لوحة التحكم الرئيسية للمنظومة حالياً. بإمكانك التنقل واستعراض بقية صفحات وأقسام النظام المتاحة لك بكل سهولة من خلال استخدام القائمة الجانبية.'
                ) : (
                  `يتطلب استعراض صفحة (${location.pathname === '/settings' ? 'الإعدادات العامة' : 'هذا القسم'}) الحصول على صلاحية خاصة من مسؤول النظام مسبقاً. مرحباً بك دائماً.`
                )}
              </Typography>
              {location.pathname === '/' ? (
                <Button
                  variant="contained"
                  onClick={handleDrawerToggle}
                  sx={{
                    bgcolor: '#007ab7',
                    fontFamily: '"Cairo", sans-serif',
                    fontWeight: 'bold',
                    borderRadius: '12px',
                    px: 4,
                    py: 1.2,
                    '&:hover': { bgcolor: '#006293' }
                  }}
                >
                  فتح القائمة الجانبية ☰
                </Button>
              ) : (
                <Button
                  variant="contained"
                  onClick={() => navigate('/')}
                  sx={{
                    bgcolor: '#007ab7',
                    fontFamily: '"Cairo", sans-serif',
                    fontWeight: 'bold',
                    borderRadius: '12px',
                    px: 4,
                    py: 1.2,
                    '&:hover': { bgcolor: '#006293' }
                  }}
                >
                  العودة للرئيسية
                </Button>
              )}
            </Box>
          )}
        </Box>
      </Box>

      {/* Logout Cloud Backup Confirmation Dialog */}
      <Dialog
        open={logoutDialogOpen}
        onClose={() => setLogoutDialogOpen(false)}
        aria-labelledby="logout-backup-dialog-title"
        aria-describedby="logout-backup-dialog-description"
        sx={{ '& .MuiDialog-paper': { borderRadius: '16px', p: 1, direction: 'rtl' } }}
      >
        <DialogTitle id="logout-backup-dialog-title" sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1, color: '#eab308' }}>
          ⚠️ تنبيه: تغييرات غير محفوظة سحابياً
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="logout-backup-dialog-description" sx={{ fontFamily: '"Cairo", sans-serif', color: 'text.primary', fontSize: '0.95rem', lineHeight: 1.6 }}>
            هناك تعديلات جديدة جرت على البيانات (المواد، الحركات، أو الإعدادات) منذ آخر نسخة احتياطية سحابية قمت برفعها. هل ترغب في إجراء نسخ احتياطي سحابي سريع إلى Google Drive قبل تسجيل الخروج لتأمين بياناتك؟
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1, justifyContent: 'flex-start' }}>
          <Button 
            onClick={handleConfirmBackupAndLogout} 
            variant="contained" 
            sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold', bgcolor: '#eab308', color: '#000000', '&:hover': { bgcolor: '#ca8a04' } }}
          >
            📤 نعم، نسخ احتياطي الآن
          </Button>
          <Button 
            onClick={handleConfirmLogoutOnly} 
            variant="outlined" 
            color="error"
            disabled={logoutTimer > 0}
            sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold' }}
          >
            {logoutTimer > 0 ? `⏰ لاحقاً (${logoutTimer}ث)` : '⏰ لاحقاً (تسجيل الخروج)'}
          </Button>
          <Button 
            onClick={() => setLogoutDialogOpen(false)} 
            sx={{ fontFamily: '"Cairo", sans-serif', color: 'text.secondary' }}
          >
            إلغاء
          </Button>
        </DialogActions>
      </Dialog>

      {/* Modern Secure Animated Full-Screen Loading Overlay */}
      {isLoggingOut && (
        <Box
          sx={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100vw',
            height: '100vh',
            bgcolor: '#0f172a', // Solid dark slate background to guarantee absolute masking of all states
            zIndex: 99999, // Highest possible z-index to overlay AppBars, menus and modals
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
            direction: 'rtl',
            animation: 'fadeInOverlay 0.3s ease-out forwards',
            '@keyframes fadeInOverlay': {
              '0%': { opacity: 0 },
              '100%': { opacity: 1 },
            },
          }}
        >
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3.5,
              textAlign: 'center',
              px: 3,
            }}
          >
            {/* Elegant double-ring spinner with central lock icon */}
            <Box
              sx={{
                position: 'relative',
                width: 90,
                height: 90,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Box
                sx={{
                  position: 'absolute',
                  width: '100%',
                  height: '100%',
                  borderRadius: '50%',
                  border: '4px solid rgba(0, 122, 183, 0.12)',
                  borderTopColor: '#007ab7',
                  animation: 'spinLoader 1.1s linear infinite',
                  '@keyframes spinLoader': {
                    '0%': { transform: 'rotate(0deg)' },
                    '100%': { transform: 'rotate(360deg)' },
                  },
                }}
              />
              <Box
                sx={{
                  position: 'absolute',
                  width: '74%',
                  height: '74%',
                  borderRadius: '50%',
                  border: '4px solid rgba(234, 179, 8, 0.06)',
                  borderBottomColor: '#eab308',
                  animation: 'spinLoaderInverse 1.6s linear infinite',
                  '@keyframes spinLoaderInverse': {
                    '0%': { transform: 'rotate(360deg)' },
                    '100%': { transform: 'rotate(0deg)' },
                  },
                }}
              />
              <Typography 
                sx={{ 
                  fontSize: '2rem', 
                  zIndex: 2, 
                  userSelect: 'none',
                  animation: 'pulseIcon 2s infinite ease-in-out', 
                  '@keyframes pulseIcon': { 
                    '0%, 100%': { transform: 'scale(1)' }, 
                    '50%': { transform: 'scale(1.15)' } 
                  } 
                }}
              >
                🔒
              </Typography>
            </Box>

            {/* Custom styled messages */}
            <Box>
              <Typography
                variant="h5"
                sx={{
                  fontFamily: '"Cairo", sans-serif',
                  fontWeight: 'bold',
                  color: '#ffffff',
                  mb: 1.5,
                  letterSpacing: '0.5px',
                  textShadow: '0 2px 4px rgba(0,0,0,0.3)',
                }}
              >
                جاري تسجيل الخروج وتأمين البيانات...
              </Typography>
              <Typography
                variant="body1"
                sx={{
                  fontFamily: '"Cairo", sans-serif',
                  color: '#94a3b8',
                  maxWidth: 480,
                  mx: 'auto',
                  fontSize: '0.95rem',
                  lineHeight: 1.7,
                }}
              >
                نشكرك على مساهمتك القيّمة في حفظ وإدارة سجلات المواد والمبيدات. يتم الآن تأمين الجلسة وإغلاقها بأمان تام.
              </Typography>
            </Box>

            {/* Glowing system status pill */}
            <Box
              sx={{
                mt: 1,
                px: 2.8,
                py: 1,
                borderRadius: '50px',
                bgcolor: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
              }}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: '#10b981',
                  boxShadow: '0 0 8px #10b981',
                  animation: 'pulseStatus 1s infinite alternate',
                  '@keyframes pulseStatus': {
                    '0%': { opacity: 0.4, transform: 'scale(0.8)' },
                    '100%': { opacity: 1, transform: 'scale(1.2)' },
                  },
                }}
              />
              <Typography
                variant="caption"
                sx={{
                  fontFamily: '"Cairo", sans-serif',
                  color: '#cbd5e1',
                  fontWeight: '600',
                  fontSize: '0.85rem',
                }}
              >
                تم تشفير وتأمين قاعدة البيانات المحلية بنجاح
              </Typography>
            </Box>
          </Box>
        </Box>
      )}

      {/* Keyboard Shortcuts Help Dialog */}
      <Dialog
        open={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
        maxWidth="xs"
        fullWidth
        sx={{ '& .MuiDialog-paper': { borderRadius: '16px', p: 1, direction: 'rtl' } }}
      >
        <DialogTitle sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1, borderBottom: '1px solid #e2e8f0', pb: 1.5, color: '#007ab7' }}>
          ⌨️ اختصارات لوحة المفاتيح للمنظومة
        </DialogTitle>
        <DialogContent sx={{ mt: 2 }}>
          <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', color: '#64748b', mb: 2, lineHeight: 1.6 }}>
            بإمكانك استخدام الاختصارات التالية للتنقل السريع والكفؤ بين أقسام المنظومة الرئيسية دون الحاجة للفأرة:
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {[
              { label: 'لوحة التحكم الرئيسية', keys: ['Alt', '1'] },
              { label: 'إدارة الأصناف والمواد', keys: ['Alt', '2'] },
              { label: 'الحركات المخزنية', keys: ['Alt', '3'] },
              { label: 'التقارير الشاملة', keys: ['Alt', '4'] },
              { label: 'سجل العمليات والتدقيق', keys: ['Alt', '5'] },
              { label: 'الإعدادات العامة', keys: ['Alt', '6'] },
              { label: 'عرض اختصارات لوحة المفاتيح', keys: ['Shift', '?'] },
            ].map((sh, idx) => (
              <Box key={idx} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', p: 1, bgcolor: '#f8fafc', borderRadius: '12px', border: '1px solid #f1f5f9' }}>
                <Typography variant="body2" sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: '600', color: '#334155' }}>
                  {sh.label}
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                  {sh.keys.map((k, kidx) => (
                    <React.Fragment key={kidx}>
                      {kidx > 0 && <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>+</span>}
                      <Box sx={{ px: 1, py: 0.3, bgcolor: '#ffffff', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '11px', fontFamily: 'monospace', fontWeight: 'bold', color: '#007ab7', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}>
                        {k}
                      </Box>
                    </React.Fragment>
                  ))}
                </Box>
              </Box>
            ))}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button 
            onClick={() => setShortcutsHelpOpen(false)} 
            variant="contained"
            sx={{ fontFamily: '"Cairo", sans-serif', fontWeight: 'bold', bgcolor: '#007ab7', '&:hover': { bgcolor: '#006293' }, borderRadius: '8px' }}
          >
            حسناً، فهمت
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
