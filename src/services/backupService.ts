import type { AppSettings, AuditLog, GeneratorLogEntry, InventoryTransaction, Material, SystemUser, MigrationLog } from '../types';
import { safeUserMessage } from './safeUserMessage';
import { getCurrentAuthUser, isSupabaseConfigured, supabaseDb, type SupabaseTableName } from './supabase';
import { RbacTestReport, RbacTestResult } from "../types";
import {
  buildExpectedCounts,
  calculateMigrationBatchCount,
  calculateWarehouseTotals,
  validateManifestWarehouseTotals,
  validateMigrationUserLinks,
  validateSelectedStorehouse,
  validateStorehouses,
} from '../utils/backupIntegrity';
import { buildWarehouseBackupProjection } from '../utils/warehouseBackup';
import {
  composeSettingsForBackupExport,
  extractTypedSettingsChildren,
  isTypedSettingsCloudInactiveOrTombstone,
  prepareSettingsForBackupImport,
  settingsDocKind,
} from '../utils/settingsNormalization';
import {
  getActiveOfflineDomainUserId,
  OFFLINE_PROJECTION_OWNER_KEY,
  offlineProjectionStorage,
  persistSessionOwnedOfflineDomainProjection,
} from './offlineDomainStore';
import { buildAuditLog, normalizeAuditLog } from '../utils/auditPolicy';
import { fingerprintDocument } from '../utils/syncProtocol';
import { validateSyncMutation, type SyncOperation } from './syncCoordinator';

const localStorage = offlineProjectionStorage;

export const BACKUP_VERSION = '2.0' as const;

export const SYSTEM_ADMIN_ROLES = ['مدير نظام', 'مدير النظام'] as const;

export const isSystemAdminRole = (role: unknown): boolean => {
  if (typeof role !== 'string') return false;
  const trimmed = role.trim();
  return trimmed === 'مدير نظام' || trimmed === 'مدير النظام';
};

export const normalizeSystemAdminRole = (role: unknown): string => {
  if (typeof role !== 'string') return '';
  const trimmed = role.trim();
  return isSystemAdminRole(trimmed) ? 'مدير نظام' : trimmed;
};
export const BACKUP_FORMAT = 'remix-inventory-backup' as const;
export const P7_CLOUD_MIGRATION_EXECUTION_ENABLED = false as const;
const K = {
  materials: 'remix_materials_v1', transactions: 'remix_transactions_v1', users: 'remix_users_v1',
  settings: 'remix_settings_v1', auditLogs: 'remix_audit_logs_v1', generatorLogs: 'remix_generator_logs_v1',
  selectedStorehouse: 'inventory_app_storehouse_filter', selectedStorehouseId: 'inventory_app_storehouse_scope_v2'
} as const;

type SafeUser = SystemUser & { authUid?: string };
export interface BackupV2 {
  materials: Material[]; transactions: InventoryTransaction[]; users: SafeUser[]; settings: AppSettings;
  auditLogs: AuditLog[]; generatorLogs: GeneratorLogEntry[]; backupVersion: typeof BACKUP_VERSION; exportedAt: string;
  manifest: { format: typeof BACKUP_FORMAT; version: typeof BACKUP_VERSION; backupId: string; exportedAt: string;
    counts: { materials:number; transactions:number; users:number; auditLogs:number; generatorLogs:number; storehouses:number };
    selectedStorehouse:string; selectedStorehouseId?:string; warehouseTotals:Record<string,number>; checksumAlgorithm:'SHA-256'; checksum:string };
}
const read = <T>(key:string, fallback:T):T => { const raw=localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; };
const canonical = (v:unknown):string => v===null||typeof v!=='object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v as object).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;
const hash = async(v:unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(v))))).map(b=>b.toString(16).padStart(2,'0')).join('');
const payload=(b:BackupV2)=>{const {checksum,...manifest}=b.manifest;return {...b,manifest}};
const hasForbiddenCredentialKey = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenCredentialKey);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    key.toLowerCase() === 'password' || hasForbiddenCredentialKey(nested)
  );
};
const stripLegacyPassword = (value: SystemUser): SafeUser => {
  const safe = { ...value } as unknown as Record<string, unknown>;
  delete safe.password;
  return safe as unknown as SafeUser;
};

export async function createBackup():Promise<BackupV2>{
 const rawMaterials=read<Material[]>(K.materials,[]), rawTransactions=read<InventoryTransaction[]>(K.transactions,[]);
 const users=read<SystemUser[]>(K.users,[]).map(stripLegacyPassword), rawSettings=read<AppSettings>(K.settings,{} as AppSettings);
 const auditLogs=read<AuditLog[]>(K.auditLogs,[]), generatorLogs=read<GeneratorLogEntry[]>(K.generatorLogs,[]), exportedAt=new Date().toISOString();
 const selectedCandidate=localStorage.getItem(K.selectedStorehouseId)||localStorage.getItem(K.selectedStorehouse)||'all';
 const warehouseProjection=buildWarehouseBackupProjection({settings:rawSettings,materials:rawMaterials,transactions:rawTransactions,selectedStorehouse:selectedCandidate});
 if(warehouseProjection.errors.length)throw new Error(['تعذر إنشاء نسخة احتياطية بسبب أخطاء سلامة المستودعات.',...warehouseProjection.errors].join(' '));
 const materials=warehouseProjection.materials, transactions=warehouseProjection.transactions,
   settings=composeSettingsForBackupExport(warehouseProjection.settings);
 const storehouses=settings.storehouses||[];
 const storeErrors=validateStorehouses({storehouses});
 const warehouseCheck=calculateWarehouseTotals(materials,storehouses);
 if(storeErrors.length||warehouseCheck.errors.length)throw new Error(['تعذر إنشاء نسخة احتياطية بسبب أخطاء سلامة البيانات.',...storeErrors,...warehouseCheck.errors].join(' '));
 const base= {materials,transactions,users,settings,auditLogs,generatorLogs,backupVersion:BACKUP_VERSION,exportedAt,
 manifest:{format:BACKUP_FORMAT,version:BACKUP_VERSION,backupId:crypto.randomUUID?.()||`backup-${Date.now()}`,exportedAt,
 counts:{materials:materials.length,transactions:transactions.length,users:users.length,auditLogs:auditLogs.length,generatorLogs:generatorLogs.length,storehouses:storehouses.length},
 selectedStorehouse:warehouseProjection.selectedStorehouseName,selectedStorehouseId:warehouseProjection.selectedStorehouseId,warehouseTotals:warehouseCheck.totals,checksumAlgorithm:'SHA-256' as const,checksum:''}};
 if (hasForbiddenCredentialKey(base)) throw new Error('تم إيقاف إنشاء النسخة الاحتياطية لوجود حقل بيانات اعتماد محظور.');
 const checksum=await hash({...base,manifest:((({checksum:_c,...m})=>m)(base.manifest))}); return {...base,manifest:{...base.manifest,checksum}};
}
export async function validateBackup(value:unknown):Promise<{success:boolean;errors:string[];warnings:string[];backup?:BackupV2}>{
 const errors:string[]=[],warnings:string[]=[]; if(!value||typeof value!=='object')return{success:false,errors:['ملف JSON غير صالح.'],warnings}; const b=value as BackupV2;
 for(const key of ['materials','transactions','users','auditLogs','generatorLogs'] as const) if(!Array.isArray(b[key])) errors.push(`${key} يجب أن يكون مصفوفة.`);
 if(!b.settings||!Array.isArray(b.settings.storehouses))errors.push('إعدادات المستودعات غير صالحة.');
 if(!b.manifest||typeof b.manifest!=='object'||!b.manifest.counts||typeof b.manifest.warehouseTotals!=='object')errors.push('بيان النسخة الاحتياطية غير صالح.');
 if(errors.length)return{success:false,errors,warnings};
 for(const [name,items] of Object.entries({materials:b.materials,transactions:b.transactions,users:b.users,auditLogs:b.auditLogs,generatorLogs:b.generatorLogs})){
  const ids=new Set<string>(); for(const item of items as Array<{id?:string}>){if(!item?.id)errors.push(`${name}: سجل بلا معرف.`);else if(ids.has(item.id))errors.push(`${name}: معرف مكرر ${item.id}.`);else ids.add(item.id)} }
 const mids=new Set(b.materials.map(m=>m.id)); if(b.transactions.some(t=>!mids.has(t.itemId)))errors.push('توجد حركات مرتبطة بأصناف غير موجودة.');
 if(b.transactions.some(t=>!Number.isFinite(Number(t.quantity))||Number(t.quantity)<0))errors.push('توجد كمية حركة غير صالحة.');
 if(hasForbiddenCredentialKey(b))errors.push('النسخة تحتوي حقول بيانات اعتماد محظورة وتم رفضها.');
 const warehouseProjection=buildWarehouseBackupProjection({settings:b.settings,materials:b.materials,transactions:b.transactions,selectedStorehouse:b.manifest.selectedStorehouseId||b.manifest.selectedStorehouse});
 errors.push(...warehouseProjection.errors); warnings.push(...warehouseProjection.warnings);
 errors.push(...validateStorehouses(warehouseProjection.settings));
 const warehouseCheck=calculateWarehouseTotals(warehouseProjection.materials,warehouseProjection.settings.storehouses); errors.push(...warehouseCheck.errors);
 errors.push(...validateManifestWarehouseTotals(b.manifest.warehouseTotals,warehouseCheck.totals,warehouseProjection.settings.storehouses));
 warnings.push(...validateSelectedStorehouse(b.manifest.selectedStorehouse,warehouseProjection.settings.storehouses));
 if(typeof b.manifest.backupId!=='string'||!b.manifest.backupId.trim())errors.push('معرف النسخة الاحتياطية غير صالح.');
 if(b.backupVersion!==BACKUP_VERSION||b.manifest.format!==BACKUP_FORMAT||b.manifest.version!==BACKUP_VERSION||b.manifest.checksumAlgorithm!=='SHA-256')errors.push('إصدار أو تنسيق النسخة غير مدعوم.');
 else {const expected=await hash(payload(b));if(expected!==b.manifest.checksum)errors.push('فشلت بصمة SHA-256؛ الملف تالف أو تم تعديله.');
 const c=b.manifest.counts;if(c.materials!==b.materials.length||c.transactions!==b.transactions.length||c.users!==b.users.length||c.auditLogs!==b.auditLogs.length||c.generatorLogs!==b.generatorLogs.length||c.storehouses!==warehouseProjection.settings.storehouses.length)errors.push('أعداد السجلات لا تطابق بيان النسخة.');}
 return errors.length?{success:false,errors,warnings}:{success:true,errors,warnings,backup:b};
}
export function applyBackupLocally(b:BackupV2):()=>void{
 const keys=Object.values(K), previous=new Map(keys.map(k=>[k,localStorage.getItem(k)])); const rollback=()=>previous.forEach((v,k)=>v===null?localStorage.removeItem(k):localStorage.setItem(k,v));
 const warehouseProjection=buildWarehouseBackupProjection({settings:b.settings,materials:b.materials,transactions:b.transactions,selectedStorehouse:b.manifest.selectedStorehouseId||b.manifest.selectedStorehouse});
 if(warehouseProjection.errors.length)throw new Error(['تعذر استعادة النسخة بسبب أخطاء سلامة المستودعات.',...warehouseProjection.errors].join(' '));
 try{localStorage.setItem(K.materials,JSON.stringify(warehouseProjection.materials));localStorage.setItem(K.transactions,JSON.stringify(warehouseProjection.transactions));localStorage.setItem(K.users,JSON.stringify(b.users));localStorage.setItem(K.settings,JSON.stringify(prepareSettingsForBackupImport(warehouseProjection.settings)));localStorage.setItem(K.auditLogs,JSON.stringify(b.auditLogs));localStorage.setItem(K.generatorLogs,JSON.stringify(b.generatorLogs));localStorage.setItem(K.selectedStorehouseId,warehouseProjection.selectedStorehouseId);localStorage.setItem(K.selectedStorehouse,warehouseProjection.selectedStorehouseName);return rollback}catch(e){rollback();throw e}
}

/** Dedicated key outside OFFLINE_DOMAIN_STORAGE_KEYS so snapshot apply does not wipe recovery intent. */
export const RESTORE_RECOVERY_STORAGE_KEY = 'remix_restore_recovery_intent_v1';
/** Durable quarantine marker independent of corrupt intent payload; outside OFFLINE_DOMAIN_STORAGE_KEYS. */
export const RESTORE_RECOVERY_QUARANTINE_STORAGE_KEY = 'remix_restore_recovery_quarantine_v1';
export const BACKUP_PROJECTION_KEYS = Object.values(K);
export type RestoreRecoveryState = 'prepared' | 'applying' | 'awaiting_audit' | 'audit_committed' | 'quarantined';
export interface RestoreRecoveryRecord {
  version: 1;
  state: RestoreRecoveryState;
  ownerUserId: string;
  backupId: string;
  checksum: string;
  previous: Record<string, string | null>;
  backup: BackupV2;
  createdAt: string;
  updatedAt?: string;
  /**
   * Deterministic restore-audit operation identity minted at beginCrashSafeLocalRestore
   * (owner + backupId + checksum + createdAt). Used as logAudit clientAuditId so crash
   * retries confirm the same durable operation. Present from prepared onward — not only
   * after audit_committed.
   */
  auditOperationId?: string;
  /**
   * Stable ISO timestamp for the restore-audit payload, minted once at begin. Retries MUST
   * reuse this value (via AuditEventContext.clientAuditTimestamp) — never regenerate.
   * Present from prepared onward.
   */
  auditTimestamp?: string;
  /**
   * Restart-stable deterministic delivery/mutation identity for the SAME restore audit
   * (owner + backupId + checksum + createdAt, purpose restore-audit-delivery). Used as
   * queueCloudMutation / AppSync handoff id so journal → outbox → confirmed stay one op.
   * Present from prepared onward.
   */
  deliveryMutationId?: string;
  /**
   * R2-PP-50: random per-cycle identity minted at beginCrashSafeLocalRestore. Two lifecycles of
   * the same owner and backup never share it, so a stale continuation cannot claim a newer record.
   * Optional for legacy records (createdAt then remains the cycle discriminator).
   */
  recoveryCycleId?: string;
}
export interface RestoreRecoveryQuarantineMarker {
  version: 1;
  ownerUserId: string;
  reason: string;
  createdAt: string;
  source: 'corrupt_intent' | 'corrupt_marker' | 'backup_revalidation_failed' | 'backup_identity_mismatch' | 'apply_failed' | 'recover_apply_failed' | 'awaiting_audit_persist_failed' | string;
}
export type RecoverInterruptedLocalRestoreResult =
  | { status: 'none' }
  | { status: 'resumed'; record: RestoreRecoveryRecord; backup: BackupV2 }
  | { status: 'audit_committed'; record: RestoreRecoveryRecord }
  | { status: 'quarantined'; message: string }
  | { status: 'owner_mismatch'; message: string; ownerUserId: string }
  | { status: 'failed'; message: string };

const restoreRecoveryMetaKey = (ownerUserId: string) => `restore_recovery:${ownerUserId}`;

type RestoreRecoveryMetaStore = {
  getMeta<T>(key: string): Promise<T | undefined>;
  putMeta<T>(key: string, value: T): Promise<void>;
  putMetaIfCurrent?<T>(key: string, value: T, assertBeforeWrite: () => void): Promise<void>;
  deleteMeta(key: string, assertBeforeWrite?: () => void): Promise<void>;
  compareAndDeleteMeta?<T>(key: string, expectedValue: T, assertBeforeWrite?: () => void): Promise<boolean>;
  compareAndDeleteMetaIfCurrent?<T>(key: string, expectedValue: T, assertBeforeWrite?: () => void): Promise<boolean>;
};

/** R2-PP-50: guarded mirror write — assertion at the IndexedDB boundary when the store supports it. */
const putMetaGuarded = async <T>(
  store: RestoreRecoveryMetaStore,
  key: string,
  value: T,
  assertBeforeWrite: () => void,
): Promise<void> => {
  assertBeforeWrite();
  if (store.putMetaIfCurrent) {
    await store.putMetaIfCurrent(key, value, assertBeforeWrite);
    return;
  }
  await store.putMeta(key, value);
};

let restoreRecoveryMetaStore: RestoreRecoveryMetaStore | null | undefined;

const getRestoreRecoveryMetaStore = async (): Promise<RestoreRecoveryMetaStore | null> => {
  if (restoreRecoveryMetaStore === null) return null;
  if (restoreRecoveryMetaStore) return restoreRecoveryMetaStore;
  try {
    const offline = await import('./offlineDomainStore');
    const Store = (offline as { IndexedDbOfflineDomainStore?: new () => RestoreRecoveryMetaStore })
      .IndexedDbOfflineDomainStore;
    if (typeof Store !== 'function') {
      restoreRecoveryMetaStore = null;
      return null;
    }
    restoreRecoveryMetaStore = new Store();
    return restoreRecoveryMetaStore;
  } catch {
    restoreRecoveryMetaStore = null;
    return null;
  }
};


/** Test-only: inject or clear the restore-recovery IndexedDB meta store (undefined = re-init). */
export function __setRestoreRecoveryMetaStoreForTests(
  store: RestoreRecoveryMetaStore | null | undefined,
): void {
  restoreRecoveryMetaStore = store;
}

const RECOVERY_STATES = new Set<RestoreRecoveryState>(['prepared', 'applying', 'awaiting_audit', 'audit_committed', 'quarantined']);

export function resolveRestoreOwnerUserId(): string | null {
  const active = getActiveOfflineDomainUserId();
  if (typeof active === 'string' && active.trim()) return active.trim();
  const projectionOwner = localStorage.getItem(OFFLINE_PROJECTION_OWNER_KEY);
  if (typeof projectionOwner === 'string' && projectionOwner.trim() && !projectionOwner.includes('/')) {
    return projectionOwner.trim();
  }
  return null;
}

export function captureBackupProjectionPrevious(): Record<string, string | null> {
  const previous: Record<string, string | null> = {};
  for (const key of Object.values(K)) previous[key] = localStorage.getItem(key);
  return previous;
}

const applyPreviousProjection = (previous: Record<string, string | null>): void => {
  for (const key of Object.values(K)) {
    const value = previous[key];
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
};

const isValidRecoveryRecord = (value: unknown): value is RestoreRecoveryRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<RestoreRecoveryRecord>;
  if (record.version !== 1) return false;
  if (!record.state || !RECOVERY_STATES.has(record.state)) return false;
  if (typeof record.ownerUserId !== 'string' || !record.ownerUserId.trim() || record.ownerUserId.includes('/')) return false;
  if (typeof record.backupId !== 'string' || !record.backupId.trim()) return false;
  if (typeof record.checksum !== 'string' || !record.checksum.trim()) return false;
  if (typeof record.createdAt !== 'string' || !record.createdAt.trim()) return false;
  if (!record.previous || typeof record.previous !== 'object' || Array.isArray(record.previous)) return false;
  for (const key of Object.values(K)) {
    if (!(key in record.previous)) return false;
    const prev = (record.previous as Record<string, unknown>)[key];
    if (prev !== null && typeof prev !== 'string') return false;
  }
  if (!record.backup || typeof record.backup !== 'object') return false;
  const backup = record.backup as BackupV2;
  if (!backup.manifest || typeof backup.manifest !== 'object') return false;
  if (backup.manifest.backupId !== record.backupId) return false;
  if (backup.manifest.checksum !== record.checksum) return false;
  return true;
};

const writeRecoveryToLocalStorage = (record: RestoreRecoveryRecord): void => {
  localStorage.setItem(RESTORE_RECOVERY_STORAGE_KEY, JSON.stringify(record));
};

const RESTORE_RECOVERY_SUPERSEDED = 'RESTORE_RECOVERY_RECORD_SUPERSEDED';

/** R2-PP-50: one recovery cycle = owner + backup identity + cycle createdAt + random cycle id. */
const sameRecoveryCycle = (a: RestoreRecoveryRecord, b: RestoreRecoveryRecord): boolean => (
  a.ownerUserId === b.ownerUserId
  && a.backupId === b.backupId
  && a.checksum === b.checksum
  && a.createdAt === b.createdAt
  && (a.recoveryCycleId ?? null) === (b.recoveryCycleId ?? null)
);

/** True only while the authoritative primary still holds exactly these bytes. */
const isPrimaryExactly = (record: RestoreRecoveryRecord): boolean => (
  localStorage.getItem(RESTORE_RECOVERY_STORAGE_KEY) === JSON.stringify(record)
);

const liveRecoveryPrimary = (): RestoreRecoveryRecord | null => {
  const live = readRestoreRecoveryRecord();
  return live && live !== 'corrupt' ? live : null;
};

const mintRecoveryCycleId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
};

const mirrorRecoveryToMeta = async (
  record: RestoreRecoveryRecord,
  assertSessionCurrent?: () => void,
): Promise<void> => {
  // R2-PP-50-A: the mirror may only ever copy the record that is still the live primary of a
  // still-current lifecycle. Checked before resolving the store and again at the write boundary.
  const assertMirrorOwned = () => {
    assertSessionCurrent?.();
    if (!isPrimaryExactly(record)) throw new Error('RESTORE_RECOVERY_MIRROR_SUPERSEDED');
  };
  try {
    assertMirrorOwned();
    const store = await getRestoreRecoveryMetaStore();
    if (!store) return;
    assertMirrorOwned();
    await putMetaGuarded(store, restoreRecoveryMetaKey(record.ownerUserId), record, assertMirrorOwned);
  } catch {
    // IndexedDB may be unavailable in tests / restricted contexts; localStorage remains authoritative.
    // A superseded mirror write is intentionally dropped.
  }
};

const readRecoveryMeta = async (ownerUserId: string): Promise<RestoreRecoveryRecord | null | 'corrupt'> => {
  try {
    const store = await getRestoreRecoveryMetaStore();
    if (!store) return null;
    const value = await store.getMeta<unknown>(restoreRecoveryMetaKey(ownerUserId));
    if (value === undefined || value === null) return null;
    if (!isValidRecoveryRecord(value)) return 'corrupt';
    return value;
  } catch {
    return null;
  }
};

/**
 * R2-PP-50-B/C: mirror cleanup is compare-and-delete on the exact value that was observed, and
 * never removes a mirror that belongs to the live primary's cycle (a newer lifecycle). With
 * `expected`, only a mirror of that captured cycle may be removed — no forward permission needed.
 */
const deleteRecoveryMeta = async (
  ownerUserId: string,
  options: { expected?: RestoreRecoveryRecord; assertOwned?: () => void } = {},
): Promise<void> => {
  try {
    options.assertOwned?.();
    const store = await getRestoreRecoveryMetaStore();
    if (!store) return;
    const key = restoreRecoveryMetaKey(ownerUserId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      options.assertOwned?.();
      const value = await store.getMeta<unknown>(key);
      // R2-PP-52: an owner-scoped caller re-checks its lifecycle after the read await.
      options.assertOwned?.();
      if (value === undefined || value === null) return;
      const valid = isValidRecoveryRecord(value) ? value : null;
      if (options.expected && (!valid || !sameRecoveryCycle(valid, options.expected))) return;
      const live = liveRecoveryPrimary();
      if (valid && live && sameRecoveryCycle(valid, live)) return;
      const assertDeleteAllowed = () => {
        options.assertOwned?.();
        const current = liveRecoveryPrimary();
        if (valid && current && sameRecoveryCycle(valid, current)) {
          throw new Error(RESTORE_RECOVERY_SUPERSEDED);
        }
      };
      if (typeof store.compareAndDeleteMetaIfCurrent === 'function') {
        if (await store.compareAndDeleteMetaIfCurrent(key, value, assertDeleteAllowed)) return;
        continue;
      }
      if (typeof store.compareAndDeleteMeta === 'function') {
        if (await store.compareAndDeleteMeta(key, value, assertDeleteAllowed)) return;
        continue;
      }
      await store.deleteMeta(key, assertDeleteAllowed);
      return;
    }
  } catch {
    // Best-effort mirror cleanup.
  }
};

const isValidQuarantineMarker = (value: unknown): value is RestoreRecoveryQuarantineMarker => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Partial<RestoreRecoveryQuarantineMarker>;
  if (marker.version !== 1) return false;
  if (typeof marker.ownerUserId !== 'string' || !marker.ownerUserId.trim() || marker.ownerUserId.includes('/')) return false;
  if (typeof marker.reason !== 'string' || !marker.reason.trim()) return false;
  if (typeof marker.createdAt !== 'string' || !marker.createdAt.trim()) return false;
  if (typeof marker.source !== 'string' || !marker.source.trim()) return false;
  return true;
};

export function readRestoreRecoveryQuarantine(): RestoreRecoveryQuarantineMarker | null | 'corrupt' {
  const raw = localStorage.getItem(RESTORE_RECOVERY_QUARANTINE_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidQuarantineMarker(parsed)) return 'corrupt';
    return parsed;
  } catch {
    return 'corrupt';
  }
}

/**
 * Replace corrupt/non-JSON/schema-invalid quarantine bytes with a valid durable marker.
 * Fail-closed: never delete corrupt bytes and continue as clear/none.
 */
export async function repairCorruptRestoreRecoveryQuarantine(
  ownerUserId?: string | null,
): Promise<RestoreRecoveryQuarantineMarker> {
  const fromArg =
    typeof ownerUserId === 'string' && ownerUserId.trim() && !ownerUserId.includes('/')
      ? ownerUserId.trim()
      : null;
  const ownerUserIdResolved = fromArg || resolveRestoreOwnerUserId() || 'unknown';
  const marker: RestoreRecoveryQuarantineMarker = {
    version: 1,
    ownerUserId: ownerUserIdResolved,
    reason: 'corrupt_quarantine_marker',
    createdAt: new Date().toISOString(),
    source: 'corrupt_marker',
  };
  await writeRestoreRecoveryQuarantine(marker);
  return marker;
}

export function hasRestoreRecoveryQuarantine(ownerUserId?: string | null): boolean {
  const marker = readRestoreRecoveryQuarantine();
  // G2-F04 / FV-P8-04: key present with corrupt bytes MUST NOT report clear.
  if (marker === 'corrupt') return true;
  if (!marker) return false;
  if (!ownerUserId) return true;
  return marker.ownerUserId === ownerUserId.trim();
}

async function writeRestoreRecoveryQuarantine(marker: RestoreRecoveryQuarantineMarker): Promise<void> {
  if (!isValidQuarantineMarker(marker)) throw new Error('RESTORE_RECOVERY_QUARANTINE_INVALID');
  const markerRaw = JSON.stringify(marker);
  localStorage.setItem(RESTORE_RECOVERY_QUARANTINE_STORAGE_KEY, markerRaw);
  // R2-PP-50: mirror only the marker that is still the authoritative localStorage marker.
  const assertMarkerOwned = () => {
    if (localStorage.getItem(RESTORE_RECOVERY_QUARANTINE_STORAGE_KEY) !== markerRaw) {
      throw new Error('RESTORE_RECOVERY_QUARANTINE_SUPERSEDED');
    }
  };
  try {
    const store = await getRestoreRecoveryMetaStore();
    if (!store) return;
    assertMarkerOwned();
    await putMetaGuarded(store, `restore_recovery_quarantine:${marker.ownerUserId}`, marker, assertMarkerOwned);
  } catch {
    // localStorage marker remains authoritative.
  }
}

/**
 * Controlled exit from restore-recovery quarantine. Must only be called from an explicit
 * deactivate / clear / rebootstrap path — never from ordinary boot recovery or fail-closed logout alone.
 */
export async function clearRestoreRecoveryQuarantineAfterControlledRebootstrap(
  ownerUserId?: string,
  options: { assertOwned?: () => void } = {},
): Promise<void> {
  // R2-PP-52: an owner-scoped caller (factory reset tail) passes its lifecycle fence. It is checked
  // before the synchronous marker removal, before every await and at each IndexedDB write boundary,
  // so a superseded caller never removes a marker or mirror that a newer lifecycle wrote.
  const owned = (): boolean => {
    try {
      options.assertOwned?.();
      return true;
    } catch {
      return false;
    }
  };
  if (!owned()) return;
  const existing = readRestoreRecoveryQuarantine();
  // Controlled exit must remove the key even when bytes are corrupt/unparseable.
  localStorage.removeItem(RESTORE_RECOVERY_QUARANTINE_STORAGE_KEY);
  const owners = new Set<string>();
  if (ownerUserId) owners.add(ownerUserId.trim());
  if (existing && existing !== 'corrupt') owners.add(existing.ownerUserId);
  for (const owner of owners) {
    if (!owned()) return;
    try {
      const store = await getRestoreRecoveryMetaStore();
      if (!store) continue;
      const key = `restore_recovery_quarantine:${owner}`;
      // R2-PP-50: a marker re-created after this exit began belongs to a newer lifecycle.
      const assertNoLiveMarker = () => {
        options.assertOwned?.();
        const live = readRestoreRecoveryQuarantine();
        if (live === 'corrupt' || (live && live.ownerUserId === owner)) {
          throw new Error('RESTORE_RECOVERY_QUARANTINE_SUPERSEDED');
        }
      };
      assertNoLiveMarker();
      await store.deleteMeta(key, assertNoLiveMarker);
    } catch {
      // Best-effort mirror cleanup.
    }
  }
}

type OfflineModuleForRebootstrap = typeof import('./offlineDomainStore');

const readOfflineSessionEpoch = (offline: OfflineModuleForRebootstrap | null): number | null => {
  try {
    const read = offline?.getOfflineDomainSessionEpoch;
    return typeof read === 'function' ? read() : null;
  } catch {
    return null;
  }
};

/**
 * Controlled exit after restore quarantine: wipe contaminated offline snapshot (if possible),
 * clear recovery intent, then clear the durable quarantine marker. Must not run during ordinary
 * boot detection — only after App fail-closed / explicit rebootstrap has refused projection use.
 */
export async function controlledRebootstrapAfterRestoreQuarantine(
  ownerUserId: string,
  options: { isCurrent?: () => boolean } = {},
): Promise<void> {
  const normalized = ownerUserId.trim();
  if (!normalized || normalized.includes('/')) return;
  const isCurrent = options.isCurrent ?? (() => true);
  if (!isCurrent()) return;
  let offline: OfflineModuleForRebootstrap | null = null;
  try {
    offline = await import('./offlineDomainStore');
  } catch {
    offline = null;
  }
  if (!isCurrent()) return;
  // R2-PP-50-E: this controlled exit owns only the deactivated lifecycle it started in. Any later
  // activation/teardown (same UID included) or caller supersession stops every remaining wipe.
  const epochAtStart = readOfflineSessionEpoch(offline);
  const stillOwned = (): boolean => isCurrent() && readOfflineSessionEpoch(offline) === epochAtStart;
  const assertStillOwned = () => {
    if (!stillOwned()) throw new Error('RESTORE_REBOOTSTRAP_SUPERSEDED');
  };
  await clearRestoreRecoveryRecord(normalized, { assertOwned: assertStillOwned });
  if (!stillOwned()) return;
  try {
    const Store = (offline as { IndexedDbOfflineDomainStore?: new () => { delete(userId: string, assertBeforeWrite?: () => void): Promise<void> } } | null)
      ?.IndexedDbOfflineDomainStore;
    if (typeof Store === 'function') {
      await new Store().delete(normalized, assertStillOwned);
    }
  } catch {
    // Best-effort snapshot wipe; local projection should already be cleared by fail-closed deactivate.
  }
  if (!stillOwned()) return;
  await clearRestoreRecoveryQuarantineAfterControlledRebootstrap(normalized, { assertOwned: assertStillOwned });
}

export function readRestoreRecoveryRecord(): RestoreRecoveryRecord | null | 'corrupt' {
  const raw = localStorage.getItem(RESTORE_RECOVERY_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidRecoveryRecord(parsed)) return 'corrupt';
    return parsed;
  } catch {
    return 'corrupt';
  }
}

/**
 * R2-PP-50: a recovery write is admitted only for a fresh cycle (no primary, state prepared) or
 * the SAME cycle that still owns the primary, and never moves a committed/quarantined cycle back.
 */
const admitsRecoveryWrite = (
  current: RestoreRecoveryRecord | null | 'corrupt',
  next: RestoreRecoveryRecord,
): boolean => {
  if (current === null) return next.state === 'prepared';
  if (current === 'corrupt') return false;
  if (!sameRecoveryCycle(current, next)) return false;
  if (current.state === 'audit_committed' && next.state !== 'audit_committed') return false;
  if (current.state === 'quarantined' && next.state !== 'quarantined') return false;
  return true;
};

export async function persistRestoreRecoveryRecord(
  record: RestoreRecoveryRecord,
  options: { assertSessionCurrent?: () => void } = {},
): Promise<void> {
  if (!isValidRecoveryRecord(record)) throw new Error('RESTORE_RECOVERY_RECORD_INVALID');
  options.assertSessionCurrent?.();
  if (!admitsRecoveryWrite(readRestoreRecoveryRecord(), record)) {
    throw new Error(RESTORE_RECOVERY_SUPERSEDED);
  }
  // Durable intent MUST land before any live projection mutation.
  writeRecoveryToLocalStorage(record);
  await mirrorRecoveryToMeta(record, options.assertSessionCurrent);
}

/**
 * Clear the recovery intent. With `expected`, this is compare-and-delete on the captured cycle:
 * a newer lifecycle's primary and mirror are never touched, and no forward permission is needed.
 */
export async function clearRestoreRecoveryRecord(
  ownerUserId?: string,
  options: { expected?: RestoreRecoveryRecord; assertOwned?: () => void } = {},
): Promise<void> {
  const expected = options.expected;
  // R2-PP-52: with `assertOwned` (factory reset tail) nothing is touched once the caller's lifecycle
  // was superseded — checked before the primary removal, before every mirror await and at the boundary.
  const owned = (): boolean => {
    try {
      options.assertOwned?.();
      return true;
    } catch {
      return false;
    }
  };
  if (!owned()) return;
  const existing = readRestoreRecoveryRecord();
  if (expected) {
    if (existing && existing !== 'corrupt' && sameRecoveryCycle(existing, expected)) {
      localStorage.removeItem(RESTORE_RECOVERY_STORAGE_KEY);
    }
    await deleteRecoveryMeta(expected.ownerUserId, { expected, assertOwned: options.assertOwned });
    return;
  }
  localStorage.removeItem(RESTORE_RECOVERY_STORAGE_KEY);
  const owners = new Set<string>();
  if (ownerUserId) owners.add(ownerUserId);
  if (existing && existing !== 'corrupt') owners.add(existing.ownerUserId);
  for (const owner of owners) {
    if (!owned()) return;
    await deleteRecoveryMeta(owner, { assertOwned: options.assertOwned });
  }
}

export async function quarantineRestoreRecoveryRecord(
  reason: string,
  options: {
    ownerUserId?: string | null;
    source?: RestoreRecoveryQuarantineMarker['source'];
    assertSessionCurrent?: () => void;
  } = {},
): Promise<RestoreRecoveryRecord | null> {
  const assertSessionCurrent = options.assertSessionCurrent ?? (() => {});
  assertSessionCurrent();
  const existing = readRestoreRecoveryRecord();
  const existingRaw = localStorage.getItem(RESTORE_RECOVERY_STORAGE_KEY);
  const ownerFromOptions = typeof options.ownerUserId === 'string' ? options.ownerUserId.trim() : '';
  const source = options.source ?? (existing === 'corrupt' ? 'corrupt_intent' : reason);

  if (existing === 'corrupt') {
    // FV-P8-04: write durable quarantine marker BEFORE stripping unparseable intent bytes.
    // Never treat corrupt-as-deleted as status "none".
    const ownerUserId = ownerFromOptions || resolveRestoreOwnerUserId() || 'unknown';
    await writeRestoreRecoveryQuarantine({
      version: 1,
      ownerUserId,
      reason: reason || 'corrupt_json_or_schema',
      createdAt: new Date().toISOString(),
      source: source || 'corrupt_intent',
    });
    // R2-PP-50-C: strip only the exact corrupt bytes this quarantine observed. A valid intent
    // written by a newer lifecycle during the marker await is never unlinked.
    if (localStorage.getItem(RESTORE_RECOVERY_STORAGE_KEY) === existingRaw) {
      localStorage.removeItem(RESTORE_RECOVERY_STORAGE_KEY);
    }
    assertSessionCurrent();
    if (ownerFromOptions) await deleteRecoveryMeta(ownerFromOptions, { assertOwned: assertSessionCurrent });
    return null;
  }

  if (existing === null) {
    // Intent already gone (e.g. prior strip) but caller still wants fail-closed quarantine.
    const ownerUserId = ownerFromOptions || resolveRestoreOwnerUserId();
    if (ownerUserId) {
      await writeRestoreRecoveryQuarantine({
        version: 1,
        ownerUserId,
        reason: reason || 'missing_intent_fail_closed',
        createdAt: new Date().toISOString(),
        source,
      });
    }
    return null;
  }

  const quarantined: RestoreRecoveryRecord = {
    ...existing,
    state: 'quarantined',
    updatedAt: new Date().toISOString(),
  };
  writeRecoveryToLocalStorage(quarantined);
  await mirrorRecoveryToMeta(quarantined, options.assertSessionCurrent);
  // Durable session-blocking marker only for fail-closed integrity failures — not transient
  // apply/rollback paths that successfully restore the prior projection.
  const durableFailClosedSources = new Set([
    'corrupt_intent',
    'backup_revalidation_failed',
    'backup_identity_mismatch',
  ]);
  if (durableFailClosedSources.has(String(source))) {
    // R2-PP-53: the mirror await may have spanned a controlled exit or a newer lifecycle. The marker
    // is written only by a still-current session while the primary still holds exactly this
    // quarantined record; otherwise this stale call quarantines nothing and plants no marker.
    assertSessionCurrent();
    if (!isPrimaryExactly(quarantined)) return null;
    await writeRestoreRecoveryQuarantine({
      version: 1,
      ownerUserId: existing.ownerUserId,
      reason: reason || 'quarantined',
      createdAt: new Date().toISOString(),
      source,
    });
  }
  return quarantined;
}

/**
 * Irreversible post-audit boundary: persist audit_committed BEFORE clearing the recovery intent.
 * After this resolves, rollback of the restored projection is forbidden.
 */
export async function markRestoreRecoveryAuditCommitted(
  ownerUserId: string,
  identity: { backupId: string; checksum: string; auditOperationId?: string; expected?: RestoreRecoveryRecord },
): Promise<RestoreRecoveryRecord> {
  const loaded = readRestoreRecoveryRecord();
  if (loaded === 'corrupt') {
    throw new Error('RESTORE_RECOVERY_CORRUPT_AFTER_AUDIT');
  }
  if (!loaded) {
    throw new Error('RESTORE_RECOVERY_MISSING_AFTER_AUDIT');
  }
  if (loaded.ownerUserId !== ownerUserId.trim()) {
    throw new Error('RESTORE_RECOVERY_OWNER_MISMATCH_AFTER_AUDIT');
  }
  if (loaded.backupId !== identity.backupId || loaded.checksum !== identity.checksum) {
    throw new Error('RESTORE_RECOVERY_IDENTITY_MISMATCH_AFTER_AUDIT');
  }
  if (identity.expected && !sameRecoveryCycle(loaded, identity.expected)) {
    throw new Error('RESTORE_RECOVERY_IDENTITY_MISMATCH_AFTER_AUDIT');
  }
  const committed: RestoreRecoveryRecord = {
    ...loaded,
    state: 'audit_committed',
    updatedAt: new Date().toISOString(),
    ...(identity.auditOperationId ? { auditOperationId: identity.auditOperationId } : {}),
  };
  await persistRestoreRecoveryRecord(committed);
  return committed;
}

/**
 * Mint a restart-stable restore-audit operation id bound to owner + backup + checksum + cycle createdAt.
 * Must NOT be regeneratable from BackupV2 alone (createdAt is recovery-cycle specific).
 */
export async function mintRestoreAuditOperationId(
  ownerUserId: string,
  backupId: string,
  checksum: string,
  createdAt: string,
): Promise<string> {
  const digest = await hash({
    purpose: 'restore-audit-operation',
    ownerUserId: ownerUserId.trim(),
    backupId,
    checksum,
    createdAt,
  });
  return `restore-audit-${digest}`;
}

/**
 * Mint a restart-stable delivery/mutation identity for the same restore-audit cycle.
 * Distinct purpose from mintRestoreAuditOperationId so doc id and delivery id never collide.
 */
export async function mintRestoreAuditDeliveryMutationId(
  ownerUserId: string,
  backupId: string,
  checksum: string,
  createdAt: string,
): Promise<string> {
  const digest = await hash({
    purpose: 'restore-audit-delivery',
    ownerUserId: ownerUserId.trim(),
    backupId,
    checksum,
    createdAt,
  });
  return `restore-delivery-${digest}`;
}

/** Prefer the persisted recovery-cycle id; otherwise derive the deterministic id from record fields. */
export async function resolveRestoreAuditOperationId(record: RestoreRecoveryRecord): Promise<string> {
  if (typeof record.auditOperationId === 'string' && record.auditOperationId.trim()) {
    return record.auditOperationId.trim();
  }
  return mintRestoreAuditOperationId(
    record.ownerUserId,
    record.backupId,
    record.checksum,
    record.createdAt,
  );
}

/** Prefer persisted auditTimestamp; fall back to cycle createdAt (never regenerate wall-clock). */
export function resolveRestoreAuditTimestamp(record: RestoreRecoveryRecord): string {
  if (typeof record.auditTimestamp === 'string' && record.auditTimestamp.trim()) {
    return record.auditTimestamp.trim();
  }
  return record.createdAt;
}

/** Prefer persisted deliveryMutationId; otherwise derive deterministic id from record fields. */
export async function resolveRestoreDeliveryMutationId(record: RestoreRecoveryRecord): Promise<string> {
  if (typeof record.deliveryMutationId === 'string' && record.deliveryMutationId.trim()) {
    return record.deliveryMutationId.trim();
  }
  return mintRestoreAuditDeliveryMutationId(
    record.ownerUserId,
    record.backupId,
    record.checksum,
    record.createdAt,
  );
}

/**
 * Identity required to compute the exact expected restore-audit payload for a recovery cycle
 * (FV-P8-08). Actor fields must match what logAudit / buildAuditLog used for this cycle.
 */
export interface RestoreAuditProofIdentity {
  ownerUserId: string;
  auditOperationId: string;
  deliveryMutationId: string;
  auditTimestamp: string;
  actorUserId: string;
  actorDisplayName: string;
  /** Matches dataService.logAudit itemType for restore ('إعدادات'). */
  itemType?: string;
}

/**
 * Exact expected audit_logs document for a restore-audit delivery cycle.
 * Uses buildAuditLog so proof and logAudit share the same template-bound shape
 * (template action/details, not free-form caller strings).
 */
export function buildExpectedRestoreAuditPayload(identity: RestoreAuditProofIdentity) {
  return buildAuditLog({
    id: identity.auditOperationId.trim(),
    timestamp: identity.auditTimestamp.trim(),
    actorUserId: identity.actorUserId.trim(),
    actorDisplayName: identity.actorDisplayName,
    itemType: identity.itemType ?? 'إعدادات',
    context: {
      operationType: 'backup',
      affectedEntities: ['system/backup-restore'],
      templateId: 'backup_restore',
    },
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * FV-P8-09: expected must be structurally valid AND kind === 'missing'
 * (restore-audit create / append-audit-log contract). present or malformed ≠ proof.
 */
export const isExactRestoreAuditExpectedMissing = (expected: unknown): boolean => {
  if (!isPlainObject(expected)) return false;
  if (!Object.hasOwn(expected, 'kind')) return false;
  return expected.kind === 'missing';
};

/**
 * FV-P8-09: single restore-audit set op matching the exact delivery contract.
 * Requires expected.kind === 'missing' — soft presence of fingerprint alone cannot prove.
 */
export const isExactRestoreAuditDeliveryOperation = (
  operation: unknown,
  auditOperationId: string,
  expectedPayload: Record<string, unknown>,
): boolean => {
  if (!isPlainObject(operation)) return false;
  if (operation.collection !== 'audit_logs' || operation.kind !== 'set') return false;
  if (operation.docId !== auditOperationId) return false;
  if (!isPlainObject(operation.value)) return false;
  if (!isExactRestoreAuditExpectedMissing(operation.expected)) return false;
  return fingerprintDocument(operation.value) === fingerprintDocument(expectedPayload);
};

/**
 * FV-P8-09: ops array itself must be EXACTLY the single restore-audit delivery op.
 * `.some()` with extras cannot prove. Reuses validateSyncMutation structure checks;
 * throws → not-proof.
 */
export const operationsAreExactRestoreAuditDelivery = (
  operations: unknown,
  auditOperationId: string,
  expectedPayload: Record<string, unknown>,
): boolean => {
  if (!Array.isArray(operations) || operations.length !== 1) return false;
  try {
    validateSyncMutation({
      operations: operations as SyncOperation[],
      label: 'append-audit-log',
    });
  } catch {
    return false;
  }
  return isExactRestoreAuditDeliveryOperation(operations[0], auditOperationId, expectedPayload);
};

export type RestoreAuditDeliveryEnvelopeIdentity = Pick<
  RestoreAuditProofIdentity,
  'ownerUserId' | 'deliveryMutationId' | 'auditTimestamp' | 'auditOperationId'
>;

/**
 * FV-P8-09 canonical WHOLE delivery-envelope validator for handoff / journal shapes.
 * Requires ALL of: owner, deliveryMutationId, createdAt === Date.parse(auditTimestamp),
 * label === 'append-audit-log', exactly ONE restore-audit set op with expected.kind === 'missing'
 * and exact payload fingerprint. Optional requireHandoffVersion enforces version 1|2 (handoffs).
 */
export const isExactRestoreAuditDeliveryEnvelope = (
  envelope: unknown,
  identity: RestoreAuditDeliveryEnvelopeIdentity,
  expectedPayload: Record<string, unknown>,
  options: { requireHandoffVersion?: boolean } = {},
): boolean => {
  if (!isPlainObject(envelope)) return false;
  const owner = identity.ownerUserId.trim();
  const deliveryId = identity.deliveryMutationId.trim();
  const auditOpId = identity.auditOperationId.trim();
  const auditTimestamp = identity.auditTimestamp.trim();
  if (!owner || !deliveryId || !auditOpId || !auditTimestamp) return false;

  const expectedCreatedAt = Date.parse(auditTimestamp);
  if (!Number.isSafeInteger(expectedCreatedAt) || expectedCreatedAt < 0) return false;

  if (options.requireHandoffVersion) {
    if (envelope.version !== 1 && envelope.version !== 2) return false;
  } else if (Object.hasOwn(envelope, 'version')
    && envelope.version !== 1 && envelope.version !== 2) {
    return false;
  }

  if (typeof envelope.id !== 'string' || !envelope.id || envelope.id.includes('/')) return false;
  if (envelope.id !== deliveryId) return false;
  if (typeof envelope.userId !== 'string' || envelope.userId !== owner) return false;
  if (envelope.createdAt !== expectedCreatedAt) return false;
  if (!isPlainObject(envelope.input)) return false;
  if (envelope.input.label !== 'append-audit-log') return false;
  return operationsAreExactRestoreAuditDelivery(
    envelope.input.operations,
    auditOpId,
    expectedPayload,
  );
};

/**
 * FV-P8-10: adapt flat DurableSyncMutation (id/userId/createdAt/label/operations) into the
 * journal/handoff envelope shape expected by isExactRestoreAuditDeliveryEnvelope.
 * Prefer reuse of the canonical validator — do not build a parallel weaker outbox path.
 */
export const adaptDurableSyncMutationToRestoreAuditDeliveryEnvelope = (
  mutation: {
    id?: unknown;
    userId?: unknown;
    createdAt?: unknown;
    label?: unknown;
    operations?: unknown;
  },
): {
  id: unknown;
  userId: unknown;
  createdAt: unknown;
  input: { label: unknown; operations: unknown };
} => ({
  id: mutation.id,
  userId: mutation.userId,
  createdAt: mutation.createdAt,
  input: {
    label: mutation.label,
    operations: mutation.operations,
  },
});

/**
 * Authoritative durable proof that the current-cycle restore audit was claimed across durable
 * delivery stages with EXACT WHOLE-ENVELOPE binding (FV-P8-08/09/10):
 * OWNER + DELIVERY IDENTITY + AUDIT OPERATION IDENTITY + EXACT EXPECTED PAYLOAD +
 * label === append-audit-log + exactly ONE op + expected.kind === missing +
 * createdAt === Date.parse(auditTimestamp) (handoff/journal/outbox) + VALID STRUCTURE + LIFECYCLE/AUTHORITY.
 *
 * Soft/existence-only matches (id alone, key alone, unresolved key alone, snap.exists alone,
 * confirmed presence without fingerprint/mutationId, correct op + wrong label / extra ops /
 * expected.kind=present / wrong createdAt / wrong userId / ops-only outbox projection) are NOT proof.
 *
 * FORBIDDEN as authority: restored/local audit_logs projection scan (forged/imported backup_restore).
 */
export async function hasAuthoritativeRestoreAuditDeliveryProof(
  identity: RestoreAuditProofIdentity,
): Promise<boolean> {
  const owner = identity.ownerUserId.trim();
  const target = identity.auditOperationId.trim();
  const deliveryId = identity.deliveryMutationId.trim();
  const auditTimestamp = identity.auditTimestamp.trim();
  const actorUserId = identity.actorUserId.trim();
  if (!owner || !target || !deliveryId || !auditTimestamp || !actorUserId) return false;
  if (!identity.actorDisplayName || !String(identity.actorDisplayName).trim()) return false;

  let expectedPayload: Record<string, unknown>;
  try {
    expectedPayload = buildExpectedRestoreAuditPayload({
      ...identity,
      ownerUserId: owner,
      auditOperationId: target,
      deliveryMutationId: deliveryId,
      auditTimestamp,
      actorUserId,
    }) as unknown as Record<string, unknown>;
  } catch {
    return false;
  }
  const expectedFingerprint = fingerprintDocument(expectedPayload);
  const envelopeIdentity: RestoreAuditDeliveryEnvelopeIdentity = {
    ownerUserId: owner,
    deliveryMutationId: deliveryId,
    auditTimestamp,
    auditOperationId: target,
  };

  // 1) OfflineDomain journals — whole delivery envelope (owner/id/createdAt/label/single op).
  try {
    const offline = await import('./offlineDomainStore');
    if (typeof offline.getActiveOfflineDomainUserId === 'function'
      && offline.getActiveOfflineDomainUserId() === owner
      && typeof offline.listValidatedActiveOfflineMutationJournals === 'function') {
      const journals = await offline.listValidatedActiveOfflineMutationJournals();
      for (const journal of journals) {
        if (!journal || typeof journal !== 'object') continue;
        if (isExactRestoreAuditDeliveryEnvelope(journal, envelopeIdentity, expectedPayload)) {
          return true;
        }
      }
    }
  } catch {
    // Continue other stages.
  }

  // 2) Durable AppSync handoffs — exact WHOLE delivery envelope (FV-P8-09).
  // Id-alone / key-alone / wrong-label / extra-ops / wrong-createdAt acceptance is FORBIDDEN.
  try {
    const prefix = `remix_sync_handoff_v1:${encodeURIComponent(owner)}:`;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Corrupt/malformed JSON is never proof.
        continue;
      }
      if (isExactRestoreAuditDeliveryEnvelope(
        parsed,
        envelopeIdentity,
        expectedPayload,
        { requireHandoffVersion: true },
      )) {
        return true;
      }
    }
  } catch {
    // Continue other stages.
  }

  // 3–4) AppSync outbox / confirmed (owner-bound). Unresolved key alone is NEVER proof —
  // must confirm exact-envelope durable queue entry for deliveryMutationId.
  try {
    const appSync = await import('./appSyncService');
    if (typeof appSync.getConfirmedSyncStateForUser === 'function') {
      const confirmed = appSync.getConfirmedSyncStateForUser(owner, 'audit_logs', target);
      if (
        confirmed
        && confirmed.mutationId === deliveryId
        && confirmed.fingerprint === expectedFingerprint
      ) {
        return true;
      }
    }
    const activeUserId = typeof appSync.getAppSyncSnapshot === 'function'
      ? appSync.getAppSyncSnapshot()?.activeUserId
      : null;
    // FV-P8-10: active lifecycle consistency is a gate, NOT a substitute for mutation.userId.
    // Load full durable mutation and validate via the SAME canonical whole-envelope validator
    // (adapted flat id/userId/createdAt/label/operations → { id, userId, createdAt, input }).
    // Ops-only projection is FORBIDDEN — it soft-accepts wrong label/createdAt/userId.
    if (activeUserId === owner
      && typeof appSync.getAppSyncDurableQueueMutation === 'function') {
      const mutation = await appSync.getAppSyncDurableQueueMutation(deliveryId);
      if (mutation
        && isExactRestoreAuditDeliveryEnvelope(
          adaptDurableSyncMutationToRestoreAuditDeliveryEnvelope(mutation),
          envelopeIdentity,
          expectedPayload,
        )) {
        return true;
      }
    }
  } catch {
    // Continue optional remote stage.
  }

  // 5) Optional authoritative Supabase read — require the exact payload.
  try {
    if (isSupabaseConfigured() && getCurrentAuthUser()?.uid === owner) {
      const data = await supabaseDb.getDoc('audit_logs', target);
      if (getCurrentAuthUser()?.uid === owner && data) {
        if (isPlainObject(data) && fingerprintDocument(data) === expectedFingerprint) {
          return true;
        }
      }
    }
  } catch {
    // Remote unavailable is not proof of absence.
  }

  return false;
}

export async function hasAuthoritativeRestoreAuditJournalProof(
  auditOperationId: string,
): Promise<boolean> {
  void auditOperationId;
  return false;
}

/**
 * Crash-safe local restore: persist recovery intent (prepared → applying), mutate projection,
 * then leave intent at awaiting_audit until durable backup_restore audit is committed.
 */
export async function beginCrashSafeLocalRestore(
  backup: BackupV2,
  ownerUserId: string,
  options: { assertSessionCurrent?: () => void } = {},
): Promise<() => void> {
  const assertSessionCurrent = options.assertSessionCurrent ?? (() => {});
  assertSessionCurrent();
  const normalizedOwner = ownerUserId.trim();
  if (!normalizedOwner || normalizedOwner.includes('/')) {
    throw new Error('RESTORE_OWNER_REQUIRED');
  }
  const previous = captureBackupProjectionPrevious();
  const now = new Date().toISOString();
  // FV-P8-05/07: mint restart-stable restore-audit identity BEFORE projection apply / logAudit.
  const auditOperationId = await mintRestoreAuditOperationId(
    normalizedOwner,
    backup.manifest.backupId,
    backup.manifest.checksum,
    now,
  );
  assertSessionCurrent();
  const deliveryMutationId = await mintRestoreAuditDeliveryMutationId(
    normalizedOwner,
    backup.manifest.backupId,
    backup.manifest.checksum,
    now,
  );
  assertSessionCurrent();
  const prepared: RestoreRecoveryRecord = {
    version: 1,
    state: 'prepared',
    ownerUserId: normalizedOwner,
    backupId: backup.manifest.backupId,
    checksum: backup.manifest.checksum,
    previous,
    backup,
    createdAt: now,
    auditTimestamp: now,
    auditOperationId,
    deliveryMutationId,
    recoveryCycleId: mintRecoveryCycleId(),
  };
  await persistRestoreRecoveryRecord(prepared, { assertSessionCurrent });
  // R2-PP-54 (documented behavior): a session change from here on throws out of this function and
  // deliberately LEAVES the owner's prepared/applying intent (+ mirror) in place. It is not cleared by the
  // superseded caller (that would be a stale side effect on a lifecycle it no longer owns); the owner's next
  // boot resolves it via recoverInterruptedLocalRestore (resume / quarantine), never a silent open.
  assertSessionCurrent();
  const applying: RestoreRecoveryRecord = { ...prepared, state: 'applying', updatedAt: new Date().toISOString() };
  await persistRestoreRecoveryRecord(applying, { assertSessionCurrent });
  assertSessionCurrent();
  let rollback: () => void;
  try {
    rollback = applyBackupLocally(backup);
  } catch (error) {
    assertSessionCurrent();
    applyPreviousProjection(previous);
    await quarantineRestoreRecoveryRecord('apply_failed', { assertSessionCurrent });
    throw error;
  }
  try {
    const awaiting: RestoreRecoveryRecord = {
      ...applying,
      state: 'awaiting_audit',
      updatedAt: new Date().toISOString(),
    };
    await persistRestoreRecoveryRecord(awaiting, { assertSessionCurrent });
    assertSessionCurrent();
  } catch (error) {
    assertSessionCurrent();
    rollback();
    await quarantineRestoreRecoveryRecord('awaiting_audit_persist_failed', { assertSessionCurrent });
    throw error;
  }
  return rollback;
}

export async function finalizeCrashSafeLocalRestoreAfterAudit(
  ownerUserId: string,
  options: { expected?: RestoreRecoveryRecord } = {},
): Promise<void> {
  await clearRestoreRecoveryRecord(ownerUserId, options);
}

/**
 * Deterministic resume policy: re-validate + re-apply the exact validated backup, leave state
 * awaiting_audit until durable audit finalization clears the intent. Never reports success itself.
 * audit_committed means durable audit already landed — callers must only finalize/clear (no re-audit, no rollback).
 */
export async function recoverInterruptedLocalRestore(options: {
  expectedOwnerUserId?: string | null;
  assertSessionCurrent?: () => void;
} = {}): Promise<RecoverInterruptedLocalRestoreResult> {
  const assertSessionCurrent = options.assertSessionCurrent ?? (() => {});
  assertSessionCurrent();
  const activeOwner = options.expectedOwnerUserId ?? resolveRestoreOwnerUserId();

  // Durable quarantine marker blocks normal projection use until controlled rebootstrap.
  // G2-F04: corrupt/non-JSON/schema-invalid marker MUST fail closed (never treat as absent/none).
  const quarantineRawPresent =
    localStorage.getItem(RESTORE_RECOVERY_QUARANTINE_STORAGE_KEY) !== null;
  const quarantineMarker = readRestoreRecoveryQuarantine();
  if (quarantineMarker === 'corrupt' || (quarantineRawPresent && quarantineMarker === null)) {
    assertSessionCurrent();
    await repairCorruptRestoreRecoveryQuarantine(activeOwner);
    assertSessionCurrent();
    return {
      status: 'quarantined',
      message: 'علامة عزل الاستعادة تالفة أو غير صالحة؛ تم إصلاحها إلى عزل دائم دون السماح بمتابعة الجلسة.',
    };
  }
  if (quarantineMarker) {
    if (activeOwner && quarantineMarker.ownerUserId !== activeOwner) {
      return {
        status: 'owner_mismatch',
        ownerUserId: quarantineMarker.ownerUserId,
        message: 'عزل استعادة يخص مستخدماً آخر؛ رُفض التداخل دون تعديل بياناته.',
      };
    }
    return {
      status: 'quarantined',
      message: 'سجل استعادة معزول بشكل دائم؛ أُوقفت الجلسة حتى إعادة التهيئة الآمنة.',
    };
  }

  let loaded = readRestoreRecoveryRecord();

  // IndexedDB mirror is a recovery fallback: read + validate + owner-bind when local intent missing/corrupt.
  if (loaded === null || loaded === 'corrupt') {
    if (activeOwner) {
      const primaryRawBeforeFallback = localStorage.getItem(RESTORE_RECOVERY_STORAGE_KEY);
      const mirrored = await readRecoveryMeta(activeOwner);
      assertSessionCurrent();
      if (localStorage.getItem(RESTORE_RECOVERY_STORAGE_KEY) !== primaryRawBeforeFallback) {
        // R2-PP-50: a newer lifecycle wrote the primary during the mirror read; never overwrite it.
        return {
          status: 'failed',
          message: 'تغيّر سجل الاسترداد أثناء القراءة من المرآة؛ لم يُستبدل سجل الجلسة الأحدث.',
        };
      }
      if (mirrored && mirrored !== 'corrupt' && mirrored.ownerUserId === activeOwner) {
        // Rehydrate local authoritative intent from validated mirror.
        writeRecoveryToLocalStorage(mirrored);
        loaded = mirrored;
      } else if (loaded === 'corrupt') {
        await quarantineRestoreRecoveryRecord('corrupt_json_or_schema', {
          ownerUserId: activeOwner,
          source: 'corrupt_intent',
          assertSessionCurrent,
        });
        return {
          status: 'quarantined',
          message: 'سجل استعادة تالف؛ تم عزله دون تخمين أو تطبيق النسخة.',
        };
      } else if (mirrored === 'corrupt') {
        await quarantineRestoreRecoveryRecord('corrupt_json_or_schema', {
          ownerUserId: activeOwner,
          source: 'corrupt_intent',
          assertSessionCurrent,
        });
        return {
          status: 'quarantined',
          message: 'سجل استعادة تالف في المرآة المحلية؛ تم العزل دون تخمين.',
        };
      }
    } else if (loaded === 'corrupt') {
      await quarantineRestoreRecoveryRecord('corrupt_json_or_schema', {
        source: 'corrupt_intent',
        assertSessionCurrent,
      });
      return {
        status: 'quarantined',
        message: 'سجل استعادة تالف؛ تم عزله دون تخمين أو تطبيق النسخة.',
      };
    }
  }

  if (loaded === null) return { status: 'none' };
  // R2-PP-50-D: owner binding precedes EVERY owner-specific branch (quarantined included), so a
  // foreign quarantined intent is never adopted, re-marked, or rebootstrapped by this session.
  if (activeOwner && loaded.ownerUserId !== activeOwner) {
    return {
      status: 'owner_mismatch',
      ownerUserId: loaded.ownerUserId,
      message: 'سجل الاستعادة يخص مستخدماً آخر؛ رُفض التداخل دون تعديل بياناته.',
    };
  }
  // Corrupt paths above either rehydrated from a validated IDB mirror or returned quarantined.
  if (loaded.state === 'quarantined') {
    // Ensure durable marker exists even for legacy quarantined intents.
    const existingMarker = readRestoreRecoveryQuarantine();
    if (existingMarker === 'corrupt') {
      await repairCorruptRestoreRecoveryQuarantine(loaded.ownerUserId);
    } else if (existingMarker === null) {
      await writeRestoreRecoveryQuarantine({
        version: 1,
        ownerUserId: loaded.ownerUserId,
        reason: 'legacy_quarantined_intent',
        createdAt: new Date().toISOString(),
        source: 'corrupt_intent',
      });
    }
    return {
      status: 'quarantined',
      message: 'سجل استعادة معزول؛ ارفض الاستعادة حتى تُصفّى الحالة بأمان.',
    };
  }
  if (!activeOwner) {
    return {
      status: 'failed',
      message: 'تعذر ربط مالك المجال لاستكمال استعادة متقطعة.',
    };
  }
  if (loaded.ownerUserId !== activeOwner) {
    return {
      status: 'owner_mismatch',
      ownerUserId: loaded.ownerUserId,
      message: 'سجل الاستعادة يخص مستخدماً آخر؛ رُفض التداخل دون تعديل بياناته.',
    };
  }

  // Post-audit crash boundary: audit already durable — only finalize/clear remains.
  if (loaded.state === 'audit_committed') {
    return { status: 'audit_committed', record: loaded };
  }

  if (loaded.state !== 'prepared' && loaded.state !== 'applying' && loaded.state !== 'awaiting_audit') {
    return { status: 'failed', message: 'حالة سجل الاستعادة غير معروفة.' };
  }

  // FV-P8-05: local audit_logs (including imported/forged backup_restore rows) are NOT authority
  // for awaiting_audit → audit_committed. That transition requires journal/outbox proof or an
  // explicit markRestoreRecoveryAuditCommitted (handled by recoverInterruptedLocalRestoreAndFinalize).

  const validation = await validateBackup(loaded.backup);
  assertSessionCurrent();
  if (!validation.success || !validation.backup) {
    applyPreviousProjection(loaded.previous);
    await quarantineRestoreRecoveryRecord('backup_revalidation_failed', {
      ownerUserId: loaded.ownerUserId,
      source: 'backup_revalidation_failed',
      assertSessionCurrent,
    });
    return {
      status: 'quarantined',
      message: `فشلت إعادة التحقق من النسخة أثناء الاسترداد: ${validation.errors.join(' ')}`,
    };
  }
  if (
    validation.backup.manifest.backupId !== loaded.backupId
    || validation.backup.manifest.checksum !== loaded.checksum
  ) {
    applyPreviousProjection(loaded.previous);
    await quarantineRestoreRecoveryRecord('backup_identity_mismatch', {
      ownerUserId: loaded.ownerUserId,
      source: 'backup_identity_mismatch',
      assertSessionCurrent,
    });
    return {
      status: 'quarantined',
      message: 'بصمة أو معرف النسخة لا يطابق سجل الاستعادة؛ تم العزل.',
    };
  }

  assertSessionCurrent();
  try {
    applyBackupLocally(validation.backup);
  } catch (error) {
    applyPreviousProjection(loaded.previous);
    await quarantineRestoreRecoveryRecord('recover_apply_failed', {
      ownerUserId: loaded.ownerUserId,
      source: 'recover_apply_failed',
      assertSessionCurrent,
    });
    return {
      status: 'failed',
      message: `تعذر إعادة تطبيق النسخة أثناء الاسترداد: ${safeUserMessage(error, 'restore', { allowAppText: true })}`,
    };
  }

  const auditOperationId = await resolveRestoreAuditOperationId(loaded);
  assertSessionCurrent();
  const auditTimestamp = resolveRestoreAuditTimestamp(loaded);
  const deliveryMutationId = await resolveRestoreDeliveryMutationId(loaded);
  assertSessionCurrent();
  const resumed: RestoreRecoveryRecord = {
    ...loaded,
    backup: validation.backup,
    state: 'awaiting_audit',
    auditOperationId,
    auditTimestamp,
    deliveryMutationId,
    updatedAt: new Date().toISOString(),
  };
  await persistRestoreRecoveryRecord(resumed, { assertSessionCurrent });
  assertSessionCurrent();
  return { status: 'resumed', record: resumed, backup: validation.backup };
}

export async function migrateValidatedBackupToFirestore(backupData: BackupV2, mode: 'dry-run' | 'execute' = 'dry-run'): Promise<MigrationLog> {
  const startTime = new Date().toISOString();
  const expectedCounts = buildExpectedCounts(backupData);

  const fallbackLog: MigrationLog = {
    id: `mig-${Date.now()}`,
    backupId: backupData.manifest.backupId || 'unknown',
    checksum: backupData.manifest.checksum,
    startTime,
    endTime: startTime,
    mode,
    status: 'failed-before-write',
    expectedCounts,
    writtenCounts: { materials: 0, transactions: 0, users: 0, settings: 0, auditLogs: 0, generatorLogs: 0 },
    completedBatches: 0,
    totalBatches: calculateMigrationBatchCount(expectedCounts),
    errorMessage: undefined
  };

  try {
    const validation = await validateBackup(backupData);
    if (!validation.success) {
      fallbackLog.status = 'failed-before-write';
      throw new Error(`فشل التحقق من النسخة قبل الترحيل: ${validation.errors.join(' | ')}`);
    }
    const warehouseProjection = buildWarehouseBackupProjection({
      settings: backupData.settings,
      materials: backupData.materials,
      transactions: backupData.transactions,
      selectedStorehouse: backupData.manifest.selectedStorehouseId || backupData.manifest.selectedStorehouse,
    });
    if (warehouseProjection.errors.length) {
      fallbackLog.status = 'failed-before-write';
      throw new Error(warehouseProjection.errors.join(' | '));
    }
    const canonicalBackupData: BackupV2 = {
      ...backupData,
      settings: warehouseProjection.settings,
      materials: warehouseProjection.materials,
      transactions: warehouseProjection.transactions,
    };
    const userLinkValidation = validateMigrationUserLinks(canonicalBackupData.users);
    if (userLinkValidation.errors.length) {
      fallbackLog.status = 'failed-before-write';
      throw new Error(userLinkValidation.errors.join(' | '));
    }

    if (mode === 'execute') {
      fallbackLog.endTime = new Date().toISOString();
      fallbackLog.status = 'p7-audited-migration-required';
      fallbackLog.errorMessage = 'التنفيذ السحابي للترحيل متوقف بأمان؛ يمكنك استخدام استعادة النسخة الاحتياطية ثم الرفع المباشر للسحابة.';
      return fallbackLog;
    }

    const sbUser = getCurrentAuthUser();
    if (!isSupabaseConfigured() || !sbUser) {
      fallbackLog.status = 'not-authorized';
      throw new Error("يجب تسجيل الدخول في الحساب السحابي للمتابعة.");
    }

    const sbEmail = sbUser.email?.trim().toLowerCase();
    const localUsersStr = localStorage.getItem('remix_users_v1');
    const localUsers: SystemUser[] = localUsersStr ? JSON.parse(localUsersStr) : [];
    const localAdmin = localUsers.find(u => u.username.trim().toLowerCase() === sbEmail);

    if (!localAdmin || localAdmin.authUid !== sbUser.uid || !isSystemAdminRole(localAdmin.role)) {
      fallbackLog.status = 'not-authorized';
      throw new Error("الشرط مفقود: يجب أن يكون الحساب الحالي مدير نظام نشط.");
    }

    const tablesToCheck: SupabaseTableName[] = ['materials', 'transactions', 'users', 'settings', 'audit_logs', 'generator_logs'];
    for (const tableName of tablesToCheck) {
      const rows = await supabaseDb.getCollection(tableName);
      if (rows.length > 0) {
        fallbackLog.status = 'database-not-empty';
        fallbackLog.failedCollection = tableName;
        throw new Error('MIGRATION_TARGET_NOT_EMPTY');
      }
    }

    fallbackLog.endTime = new Date().toISOString();
    fallbackLog.status = 'validated';
    return fallbackLog;
  } catch (error: any) {
    fallbackLog.endTime = new Date().toISOString();
    if (fallbackLog.status === 'validated' || fallbackLog.status === 'completed') {
      fallbackLog.status = 'failed-before-write';
    }
    fallbackLog.errorMessage = safeUserMessage(error, 'import', { allowAppText: true });
    return fallbackLog;
  }
}

export const testFirestoreRbacReads = async (): Promise<RbacTestReport> => {
  const report: RbacTestReport = {
    userDocStatus: 'unexpected-error',
    collectionTests: []
  };

  const user = getCurrentAuthUser();
  if (!user) {
    report.userDocDetails = "لا يوجد مستخدم مسجل الدخول في السحابة.";
    return report;
  }

  try {
    const data = await supabaseDb.getDoc<SystemUser>('users', user.uid);
    if (data) {
      const isActive = data.active !== false;
      const isAuthUidMatch = (data.authUid || data.id) === user.uid;
      const isEmailMatch = typeof data.username === 'string' && user.email
        ? data.username.trim().toLowerCase() === user.email.trim().toLowerCase()
        : false;
      const isPermissionsArray = Array.isArray(data.permissions);

      if (isActive && isAuthUidMatch && isEmailMatch && isPermissionsArray) {
        report.userDocStatus = 'allowed';
        report.userDocDetails = {
          message: "تم التحقق من صلاحيات Supabase بنجاح.",
          active: isActive,
          authUidMatches: isAuthUidMatch,
          emailMatches: isEmailMatch,
          permissionsIsArray: isPermissionsArray
        };
      } else {
        report.userDocStatus = 'validation-failed';
        const failedConditions = [];
        if (!isActive) failedConditions.push('active === true');
        if (!isAuthUidMatch) failedConditions.push('authUid matches');
        if (!isEmailMatch) failedConditions.push('username matches email');
        if (!isPermissionsArray) failedConditions.push('permissions is array');
        report.userDocDetails = {
          message: "المستند موجود لكن فشل التحقق من بعض الشروط الأساسية.",
          failedConditions
        };
      }
    } else {
      report.userDocStatus = 'validation-failed';
      report.userDocDetails = { message: "مستند المستخدم السحابي غير موجود." };
    }
  } catch (err: any) {
    report.userDocStatus = 'unexpected-error';
    report.userDocDetails = safeUserMessage(err, 'diagnostics');
  }

  const testTable = async (tableName: SupabaseTableName, reqPerm: string): Promise<RbacTestResult> => {
    try {
      await supabaseDb.getCollection(tableName);
      return { path: tableName, requiredPermission: reqPerm, status: 'allowed' };
    } catch (err: any) {
      return {
        path: tableName,
        requiredPermission: reqPerm,
        status: 'unexpected-error',
        details: safeUserMessage(err, 'diagnostics')
      };
    }
  };

  report.collectionTests.push(await testTable('materials', 'materials_view'));
  report.collectionTests.push(await testTable('transactions', 'transactions_view'));
  report.collectionTests.push(await testTable('settings', 'settings_view'));
  report.collectionTests.push(await testTable('audit_logs', 'audit_view'));
  report.collectionTests.push(await testTable('generator_logs', 'generator_log'));

  return report;
};

import { AuditLogSyncDryRun, AuditLogSyncResult, DataComparisonReport } from '../types';

export const compareLocalAndCloudData = async (): Promise<DataComparisonReport> => {
  const report: DataComparisonReport = {
    status: 'matched',
    localCounts: { materials: 0, transactions: 0, users: 0, settings: 0, auditLogs: 0, generatorLogs: 0 },
    cloudCounts: { materials: 0, transactions: 0, users: 0, settings: 0, auditLogs: 0, generatorLogs: 0 },
    missingInCloud: { materials: [], transactions: [], users: [], settings: [], auditLogs: [], generatorLogs: [] },
    missingLocally: { materials: [], transactions: [], users: [], settings: [], auditLogs: [], generatorLogs: [] },
    mismatchedRecords: { materials: [], transactions: [], users: [], settings: [], auditLogs: [], generatorLogs: [] },
    duplicateIds: { materialsLocal: [], materialsCloud: [], transactionsLocal: [], transactionsCloud: [], usersLocal: [], usersCloud: [] },
    localStorehouses: [],
    cloudStorehouses: [],
    storehousesOnlyLocal: [],
    storehousesOnlyCloud: [],
    unknownWarehouseKeysLocal: [],
    unknownWarehouseKeysCloud: [],
    warehouseTotalsLocal: {},
    warehouseTotalsCloud: {},
    stockMismatchLocal: [],
    stockMismatchCloud: [],
    passwordFieldsCount: 0,
    orphanTransactionsCount: 0,
    currentStorehouseFilter: localStorage.getItem('inventory_app_storehouse_filter') || 'all',
  };

  try {
    const user = getCurrentAuthUser();
    if (!user) throw new Error("not_authenticated");

    const localMaterials: Material[] = JSON.parse(localStorage.getItem(K.materials) || '[]');
    const localTransactions: InventoryTransaction[] = JSON.parse(localStorage.getItem(K.transactions) || '[]');
    const localUsers: SystemUser[] = JSON.parse(localStorage.getItem(K.users) || '[]');
    const localSettings: AppSettings = JSON.parse(localStorage.getItem(K.settings) || '{}');
    const localAuditLogs: AuditLog[] = JSON.parse(localStorage.getItem(K.auditLogs) || '[]');
    const localGenLogs: GeneratorLogEntry[] = JSON.parse(localStorage.getItem(K.generatorLogs) || '[]');

    const hasLocalSettings = Object.keys(localSettings).length > 0;

    const [cloudMaterials, cloudTransactions, cloudUsers, cloudSettingsDoc, cloudAuditLogs, cloudGenLogs] = await Promise.all([
      supabaseDb.getCollection<Material>('materials'),
      supabaseDb.getCollection<InventoryTransaction>('transactions'),
      supabaseDb.getCollection<SystemUser>('users'),
      supabaseDb.getDoc<AppSettings>('settings', 'app_config'),
      supabaseDb.getCollection<AuditLog>('audit_logs'),
      supabaseDb.getCollection<GeneratorLogEntry>('generator_logs'),
    ]);

    report.localCounts = {
      materials: localMaterials.length,
      transactions: localTransactions.length,
      users: localUsers.length,
      settings: hasLocalSettings ? 1 : 0,
      auditLogs: localAuditLogs.length,
      generatorLogs: localGenLogs.length,
    };

    report.cloudCounts = {
      materials: cloudMaterials.length,
      transactions: cloudTransactions.length,
      users: cloudUsers.length,
      settings: cloudSettingsDoc ? 1 : 0,
      auditLogs: cloudAuditLogs.length,
      generatorLogs: cloudGenLogs.length,
    };

    const localStorehouses: string[] = localSettings.storehouses || [];
    const cloudStorehouses: string[] = cloudSettingsDoc?.storehouses || [];
    report.localStorehouses = localStorehouses;
    report.cloudStorehouses = cloudStorehouses;
    report.storehousesOnlyLocal = localStorehouses.filter(s => !cloudStorehouses.includes(s));
    report.storehousesOnlyCloud = cloudStorehouses.filter(s => !localStorehouses.includes(s));

    localStorehouses.forEach(s => { report.warehouseTotalsLocal[s] = 0; });
    cloudStorehouses.forEach(s => { report.warehouseTotalsCloud[s] = 0; });

    localMaterials.forEach((m: any) => {
      if (m.warehouseStocks) {
        Object.entries(m.warehouseStocks).forEach(([wh, qty]) => {
          report.warehouseTotalsLocal[wh] = (report.warehouseTotalsLocal[wh] || 0) + Number(qty || 0);
        });
      }
    });
    cloudMaterials.forEach((m: any) => {
      if (m.warehouseStocks) {
        Object.entries(m.warehouseStocks).forEach(([wh, qty]) => {
          report.warehouseTotalsCloud[wh] = (report.warehouseTotalsCloud[wh] || 0) + Number(qty || 0);
        });
      }
    });

    const diffIds = (localArr: Array<{ id: string }>, cloudArr: Array<{ id: string }>) => {
      const lSet = new Set(localArr.map(i => i.id));
      const cSet = new Set(cloudArr.map(i => i.id));
      return {
        missingInCloud: [...lSet].filter(id => !cSet.has(id)),
        missingLocally: [...cSet].filter(id => !lSet.has(id)),
      };
    };

    const matDiff = diffIds(localMaterials, cloudMaterials);
    report.missingInCloud.materials = matDiff.missingInCloud;
    report.missingLocally.materials = matDiff.missingLocally;

    const txDiff = diffIds(localTransactions, cloudTransactions);
    report.missingInCloud.transactions = txDiff.missingInCloud;
    report.missingLocally.transactions = txDiff.missingLocally;

    const genDiff = diffIds(localGenLogs, cloudGenLogs);
    report.missingInCloud.generatorLogs = genDiff.missingInCloud;
    report.missingLocally.generatorLogs = genDiff.missingLocally;

    const auditDiff = diffIds(localAuditLogs, cloudAuditLogs);
    report.missingInCloud.auditLogs = auditDiff.missingInCloud;
    report.missingLocally.auditLogs = auditDiff.missingLocally;

    if (hasLocalSettings && !cloudSettingsDoc) report.missingInCloud.settings.push('app_config');
    if (!hasLocalSettings && cloudSettingsDoc) report.missingLocally.settings.push('app_config');

    const hasBusinessDiff =
      report.missingInCloud.materials.length > 0 ||
      report.missingLocally.materials.length > 0 ||
      report.missingInCloud.transactions.length > 0 ||
      report.missingLocally.transactions.length > 0 ||
      report.missingInCloud.settings.length > 0 ||
      report.missingLocally.settings.length > 0 ||
      report.missingInCloud.generatorLogs.length > 0 ||
      report.missingLocally.generatorLogs.length > 0;

    const hasAuditDiff =
      report.missingInCloud.auditLogs.length > 0 ||
      report.missingLocally.auditLogs.length > 0;

    if (hasBusinessDiff) report.status = 'differences-found';
    else if (hasAuditDiff) report.status = 'audit-only-differences';
    else report.status = 'matched';
  } catch (err: any) {
    if (err.message === "not_authenticated") {
      report.status = 'permission-denied';
      report.errorDetails = "يجب تسجيل الدخول لإجراء المقارنة.";
    } else {
      report.status = 'unexpected-error';
      report.errorDetails = safeUserMessage(err, 'diagnostics');
    }
  }

  return report;
};

export const dryRunAuditLogSync = async (): Promise<AuditLogSyncDryRun> => {
  const rawLocalLogs: unknown[] = JSON.parse(localStorage.getItem(K.auditLogs) || '[]');
  const rawCloudLogs = await supabaseDb.getCollection<AuditLog>('audit_logs');

  let invalidRecords = 0;
  const hasPassword = hasForbiddenCredentialKey(rawLocalLogs) || hasForbiddenCredentialKey(rawCloudLogs);
  const normalize = (value: unknown, documentId?: string): AuditLog | null => {
    const result = normalizeAuditLog(value, documentId);
    if (!result) invalidRecords++;
    return result;
  };
  const localLogs = rawLocalLogs
    .map(value => normalize(value))
    .filter((value): value is AuditLog => !!value);
  const cloudLogs = rawCloudLogs
    .map(value => normalize(value, value.id))
    .filter((value): value is AuditLog => !!value);

  const localIds = new Map<string, number>();
  localLogs.forEach(l => localIds.set(l.id, (localIds.get(l.id) || 0) + 1));

  const cloudIds = new Map<string, number>();
  cloudLogs.forEach(l => cloudIds.set(l.id, (cloudIds.get(l.id) || 0) + 1));

  const duplicateLocalIds = Array.from(localIds.entries()).filter(([_, c]) => c > 1).map(([id]) => id);
  const duplicateCloudIds = Array.from(cloudIds.entries()).filter(([_, c]) => c > 1).map(([id]) => id);

  const localOnlyIds = localLogs.filter(l => !cloudIds.has(l.id)).map(l => l.id);
  const cloudOnlyIds = cloudLogs.filter(l => !localIds.has(l.id)).map(l => l.id);
  const localById = new Map(localLogs.map(log => [log.id, log]));
  const mismatchedIds = cloudLogs
    .filter(log => localById.has(log.id) && canonical(localById.get(log.id)) !== canonical(log))
    .map(log => log.id);

  const unionSet = new Set([...Array.from(localIds.keys()), ...Array.from(cloudIds.keys())]);

  return {
    localCount: rawLocalLogs.length,
    cloudCount: rawCloudLogs.length,
    localOnlyIds,
    cloudOnlyIds,
    unionCount: unionSet.size,
    duplicateLocalIds,
    duplicateCloudIds,
    mismatchedIds,
    noPasswordConfirmed: !hasPassword,
    invalidRecords
  };
};

export const executeAuditLogSync = async (
  assertSessionCurrent: () => void,
): Promise<AuditLogSyncResult> => {
  assertSessionCurrent();
  const dryRun = await dryRunAuditLogSync();
  assertSessionCurrent();

  if (
    dryRun.invalidRecords > 0 ||
    dryRun.duplicateLocalIds.length > 0 ||
    dryRun.duplicateCloudIds.length > 0 ||
    !dryRun.noPasswordConfirmed
  ) {
    return {
      localCountAfter: dryRun.localCount,
      cloudCountAfter: dryRun.cloudCount,
      missingInCloudAfter: dryRun.localOnlyIds,
      missingLocallyAfter: dryRun.cloudOnlyIds,
      duplicateIdsAfter: [...dryRun.duplicateLocalIds, ...dryRun.duplicateCloudIds],
      mismatchedIdsAfter: dryRun.mismatchedIds,
      failedIds: [],
      status: 'aborted'
    };
  }

  const rawLocal = localStorage.getItem(K.auditLogs) || '[]';
  const localLogs = (JSON.parse(rawLocal) as unknown[])
    .map(value => normalizeAuditLog(value))
    .filter((value): value is AuditLog => !!value);

  const rawCloud = await supabaseDb.getCollection<AuditLog>('audit_logs');
  assertSessionCurrent();
  const cloudLogs = rawCloud
    .map(d => normalizeAuditLog(d, d.id))
    .filter((value): value is AuditLog => !!value);

  const cloudById = new Map(cloudLogs.map(log => [log.id, log]));
  const localOnly = localLogs.filter(log => !cloudById.has(log.id));
  if (localOnly.length > 0) {
    await supabaseDb.upsertDocs(
      'audit_logs',
      localOnly.map(log => ({ id: log.id, payload: log as unknown as Record<string, unknown> })),
    );
  }

  const mergedLocal = [
    ...localLogs.map(log => cloudById.get(log.id) || log),
    ...cloudLogs.filter(log => !localLogs.some(local => local.id === log.id)),
  ];
  mergedLocal.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  localStorage.setItem(K.auditLogs, JSON.stringify(mergedLocal));

  const postDryRun = await dryRunAuditLogSync();
  return {
    localCountAfter: postDryRun.localCount,
    cloudCountAfter: postDryRun.cloudCount,
    missingInCloudAfter: postDryRun.localOnlyIds,
    missingLocallyAfter: postDryRun.cloudOnlyIds,
    duplicateIdsAfter: [...postDryRun.duplicateLocalIds, ...postDryRun.duplicateCloudIds],
    mismatchedIdsAfter: postDryRun.mismatchedIds,
    failedIds: [],
    status: postDryRun.localOnlyIds.length === 0 && postDryRun.cloudOnlyIds.length === 0 ? 'matched' : 'partial',
  };
};
