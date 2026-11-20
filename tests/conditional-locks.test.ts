import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addOrReactivateWarehouse,
  canonicalizeWarehouseSettings,
  removeWarehouseEntity,
  renameWarehouseEntity,
  setWarehouseEntityActive,
} from '../src/utils/warehouseSettings';
import { safeUserMessage } from '../src/services/safeUserMessage';
import type { AppSettings } from '../src/types';

const baseSettings = (): AppSettings =>
  canonicalizeWarehouseSettings({
    organizationName: 'مكتب صحة البيئة',
    departmentName: 'دائرة البنى التحتية',
    expiryWarningThresholdDays: 90,
    categories: [
      { name: 'مبيدات حشرية', prefix: 'PES', startRange: 1001, endRange: 1999 },
      { name: 'معقمات ومطهرات', prefix: 'SAN', startRange: 2001, endRange: 2999 },
      { name: 'معدات رش ومكافحة', prefix: 'EQP', startRange: 3001, endRange: 3999 },
      { name: 'طعوم قوارض', prefix: 'ROD', startRange: 4001, endRange: 4999 },
      { name: 'كلور ومواد كيميائية', prefix: 'CHM', startRange: 5001, endRange: 5999 },
    ],
    units: ['لتر', 'كجم'],
    storehouses: ['المخزن الرئيسي', 'مخزن فرعي'],
  });

describe('Conditional category & warehouse locks (unit)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('removes an unused warehouse entity and keeps canonical projections consistent', () => {
    const settings = baseSettings();
    const secondary = settings.storehouseEntities![1];
    const after = removeWarehouseEntity(settings, secondary.id);
    expect(after.storehouseEntities).toHaveLength(1);
    expect(after.storehouses).toEqual(['المخزن الرئيسي']);
    expect(after.storehouseIds).toEqual([settings.storehouseEntities![0].id]);
  });

  it('refuses removing the last active warehouse', () => {
    const settings = baseSettings();
    const onlyOne = removeWarehouseEntity(settings, settings.storehouseEntities![1].id);
    expect(() => removeWarehouseEntity(onlyOne, onlyOne.storehouseEntities![0].id)).toThrow(/آخر مستودع فعال/);
  });

  it('allows deactivating, renaming, and reactivating a warehouse while preserving stable id', () => {
    const settings = baseSettings();
    const secondary = settings.storehouseEntities![1];
    const disabled = setWarehouseEntityActive(settings, secondary.id, false);
    expect(disabled.storehouseEntities!.find(w => w.id === secondary.id)?.active).toBe(false);
    expect(disabled.storehouses).toEqual(['المخزن الرئيسي']);

    const renamed = renameWarehouseEntity(disabled, secondary.id, 'مخزن فرعي محدث');
    expect(renamed.storehouseEntities!.find(w => w.id === secondary.id)?.name).toBe('مخزن فرعي محدث');

    const reactivated = setWarehouseEntityActive(renamed, secondary.id, true);
    expect(reactivated.storehouseEntities!.find(w => w.id === secondary.id)?.active).toBe(true);
    expect(reactivated.storehouses).toContain('مخزن فرعي محدث');

    const viaAdd = addOrReactivateWarehouse(disabled, secondary.name);
    expect(viaAdd.storehouseEntities!.find(w => w.id === secondary.id)?.active).toBe(true);
  });

  it('maps conditional lock and offline conflict server codes to clear Arabic messages', () => {
    expect(safeUserMessage(new Error('INVENTORY_WAREHOUSE_IN_USE'))).toMatch(/مستودع.*استُخدم|تعطيله/);
    expect(safeUserMessage(new Error('INVENTORY_CATEGORY_PREFIX_FROZEN'))).toMatch(/التصنيف.*بادئته|الاسم الظاهر/);
    expect(safeUserMessage(new Error('INVENTORY_CONFLICT'))).toMatch(/تعارض|لوحة المزامنة/);
  });
});
