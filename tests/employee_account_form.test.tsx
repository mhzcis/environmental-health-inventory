// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Settings from '../src/pages/Settings';
import AppLayout from '../src/layouts/AppLayout';

const fake = vi.hoisted(() => ({
  users: [] as any[],
  createUser: vi.fn(),
  saveUser: vi.fn(),
  permissions: null as null | string[],
}));

vi.mock('../src/services/dataService', () => ({ dataService: {
  getSettings: () => ({ organizationName: 'Test', departmentName: 'Test', expiryWarningThresholdDays: 90, categories: [], units: [], storehouses: [] }),
  getUsers: () => fake.users,
  getCurrentUser: () => ({ id: 'admin-test', fullName: 'Test admin' }),
  subscribe: () => () => {},
  hasPermission: (permission: string) => fake.permissions === null || fake.permissions.includes(permission),
  getMaterials: () => [],
  getMonitoringHealth: () => ({ phase: 'HEALTHY', online: true, outbox: {}, errors: { writeOrEnqueue: null, monitoringByCollection: {} }, differences: [], syncIssues: [] }),
  refreshManagedUsersFromCloud: async () => ({ success: true }),
  createUser: (...args: any[]) => fake.createUser(...args),
  saveUser: (...args: any[]) => fake.saveUser(...args),
}, monitoringPhaseArabicLabel: () => 'المزامنة سليمة', monitoringPhaseColor: () => 'green', pendingDeliveryCount: () => 0 }));
vi.mock('../src/theme/ThemeContext', () => ({ useThemeMode: () => ({ mode: 'light', toggleColorMode: vi.fn() }) }));
vi.mock('../src/context/StorehouseContext', () => ({ useStorehouse: () => ({ selectedStorehouse: 'جميع المستودعات', activeStorehouses: [], setSelectedStorehouse: vi.fn() }) }));
vi.mock('../src/components/OperationalAlertBanner', () => ({ OperationalAlertBanner: () => null }));
vi.mock('../src/components/ServiceWorkerHealthIndicator', () => ({ ServiceWorkerHealthIndicator: () => null }));
vi.mock('../src/components/StorageHealthIndicator', () => ({ StorageHealthIndicator: () => null }));
vi.mock('../src/services/backupService', () => ({
  dryRunAuditLogSync: vi.fn(), executeAuditLogSync: vi.fn(), createBackup: vi.fn(), validateBackup: vi.fn(),
  migrateValidatedBackupToFirestore: vi.fn(), testFirestoreRbacReads: vi.fn(), compareLocalAndCloudData: vi.fn(),
  P7_CLOUD_MIGRATION_EXECUTION_ENABLED: false,
  isSystemAdminRole: (role: string) => role === 'مدير نظام' || role === 'مدير النظام',
}));
vi.mock('../src/services/firebase', () => ({ auth: { currentUser: null }, isFirebaseAvailable: false }));
vi.mock('../src/services/supabase', () => ({ supabaseAuthVerifyPassword: vi.fn() }));

beforeEach(() => {
  fake.users = [];
  fake.permissions = null;
  fake.createUser.mockReset().mockResolvedValue({ success: true, message: 'تم إنشاء الحساب.' });
  fake.saveUser.mockReset().mockResolvedValue({ success: true, message: 'تم حفظ الحساب.' });
});
afterEach(cleanup);

async function openAccounts() {
  render(<MemoryRouter><Settings /></MemoryRouter>);
  fireEvent.click(screen.getByRole('tab', { name: 'الحسابات والصلاحيات' }));
  await screen.findByRole('button', { name: /إنشاء حساب الموظف/ });
}

describe('Employee account form', () => {
  it('blocks mismatched passwords, allows independent visibility toggles, and submits only the confirmed password', async () => {
    await openAccounts();
    fireEvent.change(screen.getByLabelText(/الاسم الكامل للموظف/, { selector: 'input' }), { target: { value: 'موظف اختبار' } });
    fireEvent.change(screen.getByLabelText(/البريد الإلكتروني/, { selector: 'input' }), { target: { value: 'employee@example.com' } });
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /أمين مستودع/ }));
    const password = screen.getByLabelText(/كلمة مرور الحساب الجديد/, { selector: 'input' }) as HTMLInputElement;
    const confirmation = screen.getByLabelText(/^تأكيد كلمة المرور/, { selector: 'input' }) as HTMLInputElement;
    const form = password.closest('form')!;
    fireEvent.change(password, { target: { value: 'synthetic-password-1' } });
    fireEvent.change(confirmation, { target: { value: 'synthetic-password-2' } });
    fireEvent.submit(form);
    expect(fake.createUser).not.toHaveBeenCalled();
    expect(confirmation.getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'إظهار كلمة مرور الحساب الجديد' }));
    expect(password.type).toBe('text');
    expect(confirmation.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: 'إظهار تأكيد كلمة المرور' }));
    expect(confirmation.type).toBe('text');
    expect(fake.createUser).not.toHaveBeenCalled();

    fireEvent.change(confirmation, { target: { value: 'synthetic-password-1' } });
    fireEvent.submit(form);
    await waitFor(() => expect(fake.createUser).toHaveBeenCalledOnce());
    expect(fake.createUser).toHaveBeenCalledWith(expect.objectContaining({ username: 'employee@example.com', role: 'أمين مستودع' }), 'synthetic-password-1');
    expect(fake.createUser.mock.calls[0][0]).not.toHaveProperty('password');
    expect(fake.createUser.mock.calls[0][0]).not.toHaveProperty('passwordConfirmation');
    await waitFor(() => expect(password.value).toBe(''));
    expect(confirmation.value).toBe('');
    expect(password.type).toBe('password');
    expect(confirmation.type).toBe('password');
  });

  it('edits an existing account without requiring or sending new credentials', async () => {
    fake.users = [{ id: 'employee-test', authUid: 'employee-test', fullName: 'مستخدم سابق', username: 'existing@example.com', role: 'أمين مستودع', permissions: ['materials_view'], active: true }];
    await openAccounts();
    fireEvent.click(screen.getByRole('heading', { name: 'مستخدم سابق' }));
    const name = screen.getByLabelText(/الاسم الكامل للموظف/, { selector: 'input' });
    fireEvent.change(name, { target: { value: 'مستخدم مُحدّث' } });
    expect(screen.queryByLabelText(/^تأكيد كلمة المرور/, { selector: 'input' })).toBeNull();
    fireEvent.submit(name.closest('form')!);
    await waitFor(() => expect(fake.saveUser).toHaveBeenCalledOnce());
    expect(fake.saveUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'employee-test', fullName: 'مستخدم مُحدّث', permissions: ['materials_view'] }));
    expect(fake.saveUser.mock.calls[0][0]).not.toHaveProperty('password');
    expect(fake.createUser).not.toHaveBeenCalled();
  });

  it('blocks dashboard content without dashboard_view while keeping authorized warehouse navigation usable', async () => {
    fake.permissions = ['materials_view', 'materials_create', 'materials_edit', 'materials_stocktake', 'transactions_view', 'transactions_create', 'reports_view', 'reports_export', 'reports_print'];
    const dashboardMounted = vi.fn();
    function PrivateDashboard() { dashboardMounted(); return <div>محتوى لوحة التحكم</div>; }
    render(<MemoryRouter><AppLayout><Routes>
      <Route path="/" element={<PrivateDashboard />} />
      <Route path="/materials" element={<div>صفحة الأصناف المسموحة</div>} />
    </Routes></AppLayout></MemoryRouter>);
    expect(screen.getByText('لا تمتلك صلاحية عرض لوحة التحكم')).toBeTruthy();
    expect(dashboardMounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /فتح القائمة الجانبية/ }));
    expect(screen.queryByRole('button', { name: /^لوحة التحكم/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^الإعدادات العامة/ })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /^إدارة الأصناف والمخزون/ })[0]);
    expect(await screen.findByText('صفحة الأصناف المسموحة')).toBeTruthy();
    expect(dashboardMounted).not.toHaveBeenCalled();
  });
});
