import type { AppSettings, Storehouse } from '../types';
import { WAREHOUSE_SCHEMA_VERSION, buildStorehouseEntities, getStorehouseEntities, normalizeWarehouseName } from './warehouseDomain';
import { assertComposedSettingsViewModel, withSettingsAttachmentManifest } from './productSchema';

const project = (settings: AppSettings, entities: Storehouse[]): AppSettings => {
  const projected = withSettingsAttachmentManifest({
    ...settings,
  warehouseSchemaVersion: WAREHOUSE_SCHEMA_VERSION,
  storehouseEntities: entities,
  storehouseIds: entities.map((item) => item.id),
  storehouses: entities.filter((item) => item.active).map((item) => item.name),
  }) as unknown as AppSettings;
  assertComposedSettingsViewModel(projected as unknown as Record<string, unknown>);
  return projected;
};

export const canonicalizeWarehouseSettings = (settings: AppSettings): AppSettings => {
  const explicit = Array.isArray(settings.storehouseEntities) ? settings.storehouseEntities : [];
  const entities = explicit.length > 0
    ? getStorehouseEntities(settings)
    : buildStorehouseEntities(Array.isArray(settings.storehouses) ? settings.storehouses : []);
  if (entities.filter((item) => item.active).length === 0) throw new Error('يجب الإبقاء على مستودع فعال واحد على الأقل.');
  return project(settings, entities);
};

export const addOrReactivateWarehouse = (settings: AppSettings, rawName: string): AppSettings => {
  const name = normalizeWarehouseName(rawName);
  if (!name) throw new Error('اسم المستودع فارغ أو غير صالح.');
  const canonical = canonicalizeWarehouseSettings(settings);
  const entities = [...(canonical.storehouseEntities || [])];
  const existingIndex = entities.findIndex((item) => normalizeWarehouseName(item.name) === name);
  if (existingIndex >= 0) {
    if (entities[existingIndex].active) throw new Error('المستودع موجود ومفعل بالفعل.');
    entities[existingIndex] = { ...entities[existingIndex], active: true, updatedAt: new Date().toISOString() };
    return project(canonical, entities);
  }
  const created = buildStorehouseEntities([name])[0];
  if (entities.some((item) => item.id === created.id)) throw new Error('تعذر إنشاء هوية مستودع فريدة.');
  entities.push({ ...created, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return project(canonical, entities);
};

export const renameWarehouseEntity = (settings: AppSettings, reference: string, rawName: string): AppSettings => {
  const name = normalizeWarehouseName(rawName);
  if (!name) throw new Error('اسم المستودع فارغ أو غير صالح.');
  const canonical = canonicalizeWarehouseSettings(settings);
  const entities = [...(canonical.storehouseEntities || [])];
  const index = entities.findIndex((item) => item.id === reference || item.name === normalizeWarehouseName(reference));
  if (index < 0) throw new Error('المستودع غير موجود.');
  if (entities.some((item, i) => i !== index && normalizeWarehouseName(item.name) === name)) throw new Error('يوجد مستودع آخر بنفس الاسم.');
  entities[index] = { ...entities[index], name, updatedAt: new Date().toISOString() };
  return project(canonical, entities);
};

export const setWarehouseEntityActive = (settings: AppSettings, reference: string, active: boolean): AppSettings => {
  const canonical = canonicalizeWarehouseSettings(settings);
  const entities = [...(canonical.storehouseEntities || [])];
  const index = entities.findIndex((item) => item.id === reference || item.name === normalizeWarehouseName(reference));
  if (index < 0) throw new Error('المستودع غير موجود.');
  if (!active && entities[index].active && entities.filter((item) => item.active).length <= 1) {
    throw new Error('لا يمكن تعطيل آخر مستودع فعال في النظام.');
  }
  entities[index] = { ...entities[index], active, updatedAt: new Date().toISOString() };
  return project(canonical, entities);
};

export const reorderWarehouseEntity = (
  settings: AppSettings,
  reference: string,
  direction: 'up' | 'down',
): AppSettings => {
  const canonical = canonicalizeWarehouseSettings(settings);
  const entities = [...(canonical.storehouseEntities || [])];
  const activeIndices = entities
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.active);
  const activeIndex = activeIndices.findIndex(({ item }) => item.id === reference || item.name === normalizeWarehouseName(reference));
  if (activeIndex < 0) throw new Error('المستودع الفعال غير موجود.');
  const targetActiveIndex = direction === 'up' ? activeIndex - 1 : activeIndex + 1;
  if (targetActiveIndex < 0 || targetActiveIndex >= activeIndices.length) return canonical;
  const a = activeIndices[activeIndex].index;
  const b = activeIndices[targetActiveIndex].index;
  [entities[a], entities[b]] = [entities[b], entities[a]];
  return project(canonical, entities);
};
