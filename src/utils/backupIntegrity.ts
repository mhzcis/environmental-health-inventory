import type { AppSettings, Material, SystemUser } from '../types';

export interface BackupRecordCounts {
  materials: number;
  transactions: number;
  users: number;
  settings: number;
  auditLogs: number;
  generatorLogs: number;
}

export interface WarehouseValidationResult {
  totals: Record<string, number>;
  errors: string[];
}

const nearlyEqual = (a: number, b: number): boolean => {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Number.EPSILON * 16 * scale;
};

const safeArrayLength = (value: unknown): number => Array.isArray(value) ? value.length : 0;

export const buildExpectedCounts = (backup: {
  materials?: unknown;
  transactions?: unknown;
  users?: unknown;
  auditLogs?: unknown;
  generatorLogs?: unknown;
}): BackupRecordCounts => ({
  materials: safeArrayLength(backup?.materials),
  transactions: safeArrayLength(backup?.transactions),
  users: safeArrayLength(backup?.users),
  settings: 1,
  auditLogs: safeArrayLength(backup?.auditLogs),
  generatorLogs: safeArrayLength(backup?.generatorLogs),
});

export const calculateMigrationBatchCount = (
  counts: BackupRecordCounts,
  batchLimit = 400,
): number => {
  if (!Number.isInteger(batchLimit) || batchLimit <= 0) {
    throw new Error('batchLimit must be a positive integer.');
  }
  const totalOperations = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return Math.max(1, Math.ceil(totalOperations / batchLimit));
};

export const validateStorehouses = (settings: Pick<AppSettings, 'storehouses'>): string[] => {
  const errors: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(settings.storehouses)) return ['قائمة المستودعات غير صالحة.'];

  settings.storehouses.forEach((rawName, index) => {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
      errors.push(`اسم المستودع رقم ${index + 1} فارغ أو غير صالح.`);
      return;
    }
    if (rawName !== name) errors.push(`اسم المستودع يحتوي مسافات زائدة ويجب تصحيحه: ${rawName}.`);
    if (seen.has(name)) errors.push(`اسم المستودع مكرر: ${name}.`);
    seen.add(name);
  });
  return errors;
};

export const calculateWarehouseTotals = (
  materials: Material[],
  storehouses: string[],
): WarehouseValidationResult => {
  const errors: string[] = [];
  const normalizedStores = storehouses.map(name => name.trim());
  const storeSet = new Set(normalizedStores);
  const totals = Object.fromEntries(normalizedStores.map(name => [name, 0])) as Record<string, number>;

  for (const material of materials) {
    const currentStock = Number(material.currentStock);
    if (!Number.isFinite(currentStock) || currentStock < 0) {
      errors.push(`الرصيد الإجمالي غير صالح للمادة ${material.id}.`);
      continue;
    }

    const entries = material.warehouseStocks ? Object.entries(material.warehouseStocks) : [];
    if (entries.length > 0) {
      let materialTotal = 0;
      for (const [rawStoreName, rawStock] of entries) {
        const storeName = rawStoreName.trim();
        const stock = Number(rawStock);
        if (rawStoreName !== storeName) {
          errors.push(`مفتاح المستودع للمادة ${material.id} يحتوي مسافات زائدة: ${rawStoreName}.`);
          continue;
        }
        if (!storeSet.has(storeName)) {
          errors.push(`المادة ${material.id} مرتبطة بمستودع غير معرف: ${rawStoreName}.`);
          continue;
        }
        if (!Number.isFinite(stock) || stock < 0) {
          errors.push(`كمية غير صالحة للمادة ${material.id} في ${storeName}.`);
          continue;
        }
        totals[storeName] += stock;
        materialTotal += stock;
      }
      if (!nearlyEqual(currentStock, materialTotal)) {
        errors.push(`عدم تطابق الرصيد الإجمالي للمادة ${material.id} مع مجموع أرصدة المستودعات.`);
      }
      continue;
    }

    const rawLegacyStore = material.storageLocation;
    const legacyStore = rawLegacyStore?.trim();
    if (legacyStore) {
      if (rawLegacyStore !== legacyStore) {
        errors.push(`موقع التخزين للمادة ${material.id} يحتوي مسافات زائدة: ${rawLegacyStore}.`);
      } else if (!storeSet.has(legacyStore)) {
        errors.push(`المادة ${material.id} مرتبطة بمستودع غير معرف: ${legacyStore}.`);
      } else {
        totals[legacyStore] += currentStock;
      }
    } else if (!nearlyEqual(currentStock, 0)) {
      errors.push(`المادة ${material.id} لها رصيد دون مستودع معرف.`);
    }
  }

  return { totals, errors };
};

export const validateManifestWarehouseTotals = (
  manifestTotals: Record<string, number> | undefined,
  calculatedTotals: Record<string, number>,
  storehouses: string[],
): string[] => {
  const errors: string[] = [];
  if (!manifestTotals || typeof manifestTotals !== 'object') return ['إجماليات المستودعات في البيان غير صالحة.'];

  const expectedKeys = new Set(storehouses.map(name => name.trim()));
  for (const key of Object.keys(manifestTotals)) {
    if (key !== key.trim()) errors.push(`بيان النسخة يحتوي اسم مستودع بمسافات زائدة: ${key}.`);
    else if (!expectedKeys.has(key)) errors.push(`بيان النسخة يحتوي مستودعاً غير معرف: ${key}.`);
  }

  for (const storehouse of expectedKeys) {
    const declared = Number(manifestTotals[storehouse]);
    const calculated = Number(calculatedTotals[storehouse] ?? 0);
    if (!Number.isFinite(declared) || !nearlyEqual(declared, calculated)) {
      errors.push(`إجمالي المستودع ${storehouse} لا يطابق البيانات الفعلية.`);
    }
  }
  return errors;
};

export const validateSelectedStorehouse = (
  selectedStorehouse: string | undefined,
  storehouses: string[],
): string[] => {
  if (!selectedStorehouse || selectedStorehouse === 'all') return [];
  const trimmed = selectedStorehouse.trim();
  if (selectedStorehouse !== trimmed) return [`فلتر المستودع المحدد يحتوي مسافات زائدة: ${selectedStorehouse}.`];
  return storehouses.map(name => name.trim()).includes(trimmed)
    ? []
    : [`فلتر المستودع المحدد غير موجود ضمن إعدادات النسخة: ${selectedStorehouse}.`];
};

export const validateMigrationUserLinks = (users: SystemUser[]): {
  errors: string[];
  linkedCount: number;
  matrixCount: number;
} => {
  const errors: string[] = [];
  const authUids = new Set<string>();
  let linkedCount = 0;
  let matrixCount = 0;

  for (const user of users) {
    const username = user.username?.trim().toLowerCase();
    const isMatrix = username === 'matrix@system.com';
    if (isMatrix) {
      matrixCount++;
      if (user.authUid) errors.push('مستخدم Matrix يجب أن لا يمتلك authUid.');
      continue;
    }

    if (!user.authUid?.trim()) {
      errors.push(`المستخدم ${user.username} غير مرتبط بحساب Firebase (authUid مفقود).`);
      continue;
    }
    const uid = user.authUid.trim();
    if (user.authUid !== uid) errors.push(`authUid للمستخدم ${user.username} يحتوي مسافات زائدة.`);
    if (authUids.has(uid)) errors.push(`يوجد تكرار في authUid: ${uid}.`);
    authUids.add(uid);
    linkedCount++;
  }

  if (matrixCount > 1) errors.push('يوجد أكثر من مستخدم Matrix في النسخة.');
  return { errors, linkedCount, matrixCount };
};
