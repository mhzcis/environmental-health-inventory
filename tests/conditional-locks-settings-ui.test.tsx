// @vitest-environment jsdom
// Conditional locks — Settings UI rules: used category = name-only edit and no delete; unused = full edit/delete;
// warehouses: delete only when unused, disabled ones listed with "re-enable"; fail-closed when usage is unknown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Settings from '../src/pages/Settings';

const fake = vi.hoisted(() => ({
  usage: null as any,
  usageError: false,
  setStorehouseActive: vi.fn(),
  deleteStorehouse: vi.fn(),
}));
const cats = [
  { name: 'مبيدات حشرية', prefix: 'PES', startRange: 1001, endRange: 1999 },
  { name: 'معقمات ومطهرات', prefix: 'SAN', startRange: 2001, endRange: 2999 },
];
const entities = [
  { id: 'wh-used', name: 'المخزن الرئيسي', active: true },
  { id: 'wh-free', name: 'مخزن فارغ', active: true },
  { id: 'wh-off', name: 'مخزن معطل', active: false },
];
vi.mock('../src/services/dataService', () => ({ dataService: {
  getSettings: () => ({ organizationName: 'Test', departmentName: 'Test', expiryWarningThresholdDays: 90, categories: cats, units: ['لتر'],
    storehouses: entities.filter(e => e.active).map(e => e.name), storehouseIds: entities.map(e => e.id), storehouseEntities: entities, warehouseSchemaVersion: 2 }),
  getUsers: () => [],
  getCurrentUser: () => ({ id: 'admin-test', fullName: 'Test admin' }),
  subscribe: () => () => {},
  hasPermission: () => true,
  getMaterials: () => [],
  getReferenceUsage: async () => { if (fake.usageError) throw new Error('rpc missing'); return fake.usage; },
  setStorehouseActive: (...a: any[]) => fake.setStorehouseActive(...a),
  deleteStorehouse: (...a: any[]) => fake.deleteStorehouse(...a),
  getMonitoringHealth: () => ({ phase: 'HEALTHY', online: true, outbox: {}, errors: { writeOrEnqueue: null, monitoringByCollection: {} }, differences: [], syncIssues: [] }),
  refreshManagedUsersFromCloud: async () => ({ success: true }),
}, monitoringPhaseArabicLabel: () => 'المزامنة سليمة', monitoringPhaseColor: () => 'green', pendingDeliveryCount: () => 0 }));
vi.mock('../src/theme/ThemeContext', () => ({ useThemeMode: () => ({ mode: 'light', toggleColorMode: vi.fn() }) }));
vi.mock('../src/context/StorehouseContext', () => ({ useStorehouse: () => ({ selectedStorehouse: 'جميع المستودعات', activeStorehouses: [], setSelectedStorehouse: vi.fn() }) }));
vi.mock('../src/components/InventorySyncPanel', () => ({ default: () => null }));
vi.mock('../src/components/OperationalAlertBanner', () => ({ OperationalAlertBanner: () => null }));
vi.mock('../src/components/ServiceWorkerHealthIndicator', () => ({ ServiceWorkerHealthIndicator: () => null }));
vi.mock('../src/components/StorageHealthIndicator', () => ({ StorageHealthIndicator: () => null }));
vi.mock('../src/services/backupService', () => ({
  dryRunAuditLogSync: vi.fn(), executeAuditLogSync: vi.fn(), createBackup: vi.fn(), validateBackup: vi.fn(),
  migrateValidatedBackupToFirestore: vi.fn(), testFirestoreRbacReads: vi.fn(), compareLocalAndCloudData: vi.fn(),
  P7_CLOUD_MIGRATION_EXECUTION_ENABLED: false, isSystemAdminRole: () => true,
}));
vi.mock('../src/services/firebase', () => ({ auth: { currentUser: null }, isFirebaseAvailable: false }));
vi.mock('../src/services/supabase', () => ({ supabaseAuthVerifyPassword: vi.fn() }));

beforeEach(() => {
  fake.usageError = false;
  fake.usage = { usedCategoryPrefixes: ['PES'], usedCategoryNames: ['مبيدات حشرية'], usedWarehouseIds: ['wh-used'], supported: true };
  fake.setStorehouseActive.mockReset().mockResolvedValue({ success: true, message: 'ok' });
  fake.deleteStorehouse.mockReset().mockResolvedValue({ success: true, message: 'ok' });
});
afterEach(cleanup);

const open = async () => {
  render(<MemoryRouter><Settings /></MemoryRouter>);
  fireEvent.click(screen.getByRole('tab', { name: 'خيارات تهيئة المستودعات والأصناف' }));
  await screen.findByText('مخزن معطل');
};
const item = (text: string) => screen.getByText(text).closest('li') as HTMLElement;
const deleteButton = (li: HTMLElement) => within(li).getAllByRole('button').find(b => /حذف/.test(b.getAttribute('title') || ''))!;

describe('Conditional locks in Settings', () => {
  it('used category: badge, no delete, name-only edit dialog; unused category: delete enabled and full edit', async () => {
    await open();
    await waitFor(() => expect(within(item('مبيدات حشرية')).getByText('مستخدم – مقفل')).toBeTruthy());
    expect((deleteButton(item('مبيدات حشرية')) as HTMLButtonElement).disabled).toBe(true);
    expect((deleteButton(item('معقمات ومطهرات')) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(item('مبيدات حشرية')).getByTitle(/تعديل الاسم الظاهر فقط/));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('تعديل اسم التصنيف')).toBeTruthy();
    expect((within(dialog).getByLabelText(/البادئة/, { selector: 'input' }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText(/بداية المدى/, { selector: 'input' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    cleanup(); await open();
    await waitFor(() => expect(within(item('مبيدات حشرية')).queryByText('مستخدم – مقفل')).toBeTruthy());
    fireEvent.click(within(item('معقمات ومطهرات')).getByTitle('تعديل بيانات التصنيف'));
    const d2 = await screen.findByRole('dialog');
    expect(within(d2).getByText('تعديل بيانات التصنيف')).toBeTruthy();
    expect((within(d2).getByLabelText(/البادئة/, { selector: 'input' }) as HTMLInputElement).disabled).toBe(false);
  });
  it('warehouses: used one cannot be deleted, unused one can; the disabled one is listed and can be re-enabled', async () => {
    await open();
    await waitFor(() => expect(within(item('المخزن الرئيسي')).getByText('مستخدم – مقفل')).toBeTruthy());
    expect((deleteButton(item('المخزن الرئيسي')) as HTMLButtonElement).disabled).toBe(true);
    const free = deleteButton(item('مخزن فارغ')) as HTMLButtonElement;
    expect(free.disabled).toBe(false);
    fireEvent.click(free);
    await waitFor(() => expect(fake.deleteStorehouse).toHaveBeenCalledWith('wh-free'));
    fireEvent.click(within(item('مخزن معطل')).getByRole('button', { name: /إعادة تفعيل/ }));
    await waitFor(() => expect(fake.setStorehouseActive).toHaveBeenCalledWith('wh-off', true));
  });
  it('fails closed when usage cannot be read (server RPC missing before the migration): every delete and structural edit stays locked', async () => {
    fake.usageError = true;
    await open();
    for (const name of ['مبيدات حشرية', 'معقمات ومطهرات', 'المخزن الرئيسي', 'مخزن فارغ', 'مخزن معطل']) {
      expect((deleteButton(item(name)) as HTMLButtonElement).disabled, name).toBe(true);
    }
    fake.usageError = false; fake.usage = { ...fake.usage, supported: false };
    cleanup(); await open();
    await new Promise(r => setTimeout(r, 0));
    expect((deleteButton(item('معقمات ومطهرات')) as HTMLButtonElement).disabled).toBe(true);
    expect((deleteButton(item('مخزن فارغ')) as HTMLButtonElement).disabled).toBe(true);
  });
});
