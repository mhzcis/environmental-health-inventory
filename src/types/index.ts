export type Category = string;
export type Unit = string;
export type HazardLevel = 'منخفض' | 'متوسط' | 'مرتفع' | '';

export interface Storehouse {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Item {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  minimumStock: number;
  currentStock: number;
  initialStock?: number;
  storageLocation: string; // Legacy/display storage location. Warehouse identity is primaryStorehouseId.
  primaryStorehouseId?: string;
  storageLocationDetail?: string;
  warehouseStocks?: Record<string, number>; // Legacy/display projection keyed by warehouse name.
  warehouseStocksById?: Record<string, number>; // Canonical warehouse stock projection keyed by stable warehouse id.
  notes?: string;
  createdAt: string;
  updatedAt: string;
  type?: string; // Keep for backward compatibility or remove
}

export interface Material extends Item {
  manufacturer?: string;
  productionDate?: string;
  expiryDate?: string;
  hazardLevel?: HazardLevel;
}

export type TransactionType = 'وارد' | 'صادر' | 'مستهلك' | 'تحويل' | 'تسوية' | 'افتتاحي';

export interface InventoryTransaction {
  id: string;
  transactionNumber?: string;
  date: string;
  itemType?: string; // Kept for report generation compatibility
  itemId: string;
  itemCode: string;
  itemName: string;
  itemCategory?: string; // Extracted from items
  transactionType: TransactionType;
  transferType?: 'in' | 'out';
  operationId?: string; // Stable logical operation identity; required for new transfer pairs.
  pairedTransactionId?: string; // Reciprocal transfer-leg identity for atomic pair handling.
  quantity: number;
  unit?: string;
  storehouse?: string; // Legacy/display warehouse name.
  storehouseId?: string; // Canonical stable warehouse identity for this transaction.
  stockBefore: number;
  stockAfter: number;
  executedBy: string;
  supplierOrReceiver: string;
  notes?: string;
  attachment?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  details: string;
  itemType?: string;
  /** P7 structured audit fields. Optional only for backward-compatible reads of legacy records. */
  schemaVersion?: 3;
  actorUserId?: string;
  templateId?: AuditTemplateId;
  operationType?: 'create' | 'update' | 'delete' | 'batch' | 'login' | 'logout' | 'security' | 'backup' | 'settings' | 'system';
  /** New records contain exactly one rule-bound entity. */
  primaryEntity?: string;
  /** Legacy read compatibility only; schema-v3 writes never persist this field. */
  affectedEntities?: string;
  outcome?: 'success' | 'recorded_intent';
  /** Legacy records may contain an attachment; P7 never writes attachment payloads into audit logs. */
  attachment?: string;
}

export type AuditTemplateId =
  | 'domain_mutation'
  | 'login'
  | 'logout'
  | 'security_change'
  | 'password_reset'
  | 'backup_restore'
  | 'settings_change'
  | 'factory_reset'
  | 'legacy_audit_migration'
  | 'system_event';

export interface AuditEventContext {
  operationType: NonNullable<AuditLog['operationType']>;
  affectedEntities: string[];
  templateId?: AuditTemplateId;
  /** Fail the calling standalone security action if neither queue nor durable local audit succeeds. */
  requireDurable?: boolean;
  /** Require an acknowledged central receipt before the caller may perform destructive local work. */
  requireCentralAck?: boolean;
  /**
   * Optional restart-stable client audit document id. When provided, logAudit uses this id
   * instead of minting a random createAuditId() so crash retries confirm the same operation.
   */
  clientAuditId?: string;
  /**
   * Optional restart-stable ISO timestamp for the audit payload. When provided, logAudit uses
   * this instead of new Date().toISOString() so crash retries produce a byte-equivalent document.
   */
  clientAuditTimestamp?: string;
  /**
   * Optional restart-stable delivery/mutation identity for queueCloudMutation / AppSync handoff.
   * When provided, commitActiveOfflineMutation and queueAppSyncMutation reuse this id (and a
   * createdAt derived from clientAuditTimestamp) instead of minting a fresh domain id.
   */
  clientMutationId?: string;
}

export interface CategoryConfig {
  name: string;
  prefix: string;
  startRange: number;
  endRange: number;
}

export interface PartnerEntity {
  id: string;
  name: string;
  type: 'مورد' | 'جهة مستلمة' | 'أخرى';
  phone?: string;
  notes?: string;
}

export interface AppSettings {
  organizationName: string;
  departmentName: string;
  expiryWarningThresholdDays: number;
  categories: CategoryConfig[];
  units: string[];
  storehouses: string[]; // Compatibility projection of active warehouse names.
  storehouseEntities?: Storehouse[];
  /** P7 Rules projection of every stable warehouse id, in storehouseEntities order. */
  storehouseIds?: string[];
  warehouseSchemaVersion?: 2;
  cloudSyncEnabled?: boolean;
  firebaseInitialized?: boolean;
  storekeeperName?: string;
  systemManagerName?: string;
  healthDirectorName?: string;
  storekeeperRole?: string;
  systemManagerRole?: string;
  healthDirectorRole?: string;
  showStorekeeperSignature?: boolean;
  showSystemManagerSignature?: boolean;
  showHealthDirectorSignature?: boolean;
  transactionCounters?: {
    inbound: number;
    outbound: number;
    consumed: number;
    transfer?: number;
    adjustment?: number;
    opening?: number;
  };
  partners?: PartnerEntity[];
  openingStockAttachment?: string;
  openingStockAttachments?: Record<string, string>;
  /** P7 proof manifest: exact, sorted keys for bounded Rules validation of the dynamic map. */
  openingStockAttachmentKeys?: string[];
}

export interface SystemUser {
  id: string;
  username: string;
  fullName: string;
  role: string;
  permissions: string[];
  createdAt: string;
  authUid?: string;
  active?: boolean;
}

export interface GeneratorLogEntry {
  id: string;
  date: string; // YYYY-MM-DD
  dayName: string; // Arabic day name
  previousReading: number;
  currentReading: number;
  operatingHours: number; // currentReading - previousReading
  notes?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface GeneratorLogImpactItem {
  id: string;
  date: string;
  dayName: string;
  oldPreviousReading: number;
  newPreviousReading: number;
  oldCurrentReading: number;
  newCurrentReading: number;
  oldOperatingHours: number;
  newOperatingHours: number;
}

export interface GeneratorLogSimulationResult {
  actionType: 'add_old' | 'edit_old' | 'delete' | 'normal_save';
  affectedCount: number;
  lastAffectedRecordDate?: string;
  impactedItems: GeneratorLogImpactItem[];
  proposedLogs: GeneratorLogEntry[];
}

export interface MigrationLog {
  id: string;
  backupId: string;
  checksum: string;
  startTime: string;
  endTime: string;
  mode: 'dry-run' | 'execute';
  status: 'validated' | 'database-not-empty' | 'not-authorized' | 'failed-before-write' | 'partial-write' | 'verification-failed' | 'completed' | 'p7-audited-migration-required';
  failedCollection?: string;
  expectedCounts: {
    materials: number;
    transactions: number;
    users: number;
    settings: number;
    auditLogs: number;
    generatorLogs: number;
  };
  writtenCounts: {
    materials: number;
    transactions: number;
    users: number;
    settings: number;
    auditLogs: number;
    generatorLogs: number;
  };
  completedBatches: number;
  totalBatches: number;
  errorMessage?: string;
}





export interface RbacTestResult {
  path: string;
  requiredPermission: string;
  status: 'allowed' | 'permission-denied' | 'unexpected-error';
  details?: string;
}

export interface RbacTestReport {
  userDocStatus: 'allowed' | 'permission-denied' | 'unexpected-error' | 'validation-failed';
  userDocDetails?: any;
  collectionTests: RbacTestResult[];
}

export interface DataComparisonReport {
  status: 'matched' | 'audit-only-differences' | 'differences-found' | 'permission-denied' | 'unexpected-error';
  localCounts: Record<string, number>;
  cloudCounts: Record<string, number>;
  missingInCloud: Record<string, string[]>;
  missingLocally: Record<string, string[]>;
  mismatchedRecords: Record<string, any[]>;
  duplicateIds: Record<string, string[]>;
  localStorehouses: string[];
  cloudStorehouses: string[];
  storehousesOnlyLocal: string[];
  storehousesOnlyCloud: string[];
  unknownWarehouseKeysLocal: string[];
  unknownWarehouseKeysCloud: string[];
  warehouseTotalsLocal: Record<string, number>;
  warehouseTotalsCloud: Record<string, number>;
  stockMismatchLocal: any[];
  stockMismatchCloud: any[];
  passwordFieldsCount: number;
  orphanTransactionsCount: number;
  currentStorehouseFilter: string | null;
  errorDetails?: string;
}

export interface AuditLogSyncDryRun {
  localCount: number;
  cloudCount: number;
  localOnlyIds: string[];
  cloudOnlyIds: string[];
  unionCount: number;
  duplicateLocalIds: string[];
  duplicateCloudIds: string[];
  mismatchedIds: string[];
  noPasswordConfirmed: boolean;
  invalidRecords: number;
}

export interface AuditLogSyncResult {
  localCountAfter: number;
  cloudCountAfter: number;
  missingInCloudAfter: string[];
  missingLocallyAfter: string[];
  duplicateIdsAfter: string[];
  mismatchedIdsAfter: string[];
  failedIds: string[];
  status: 'matched' | 'partial' | 'failed' | 'aborted';
}
