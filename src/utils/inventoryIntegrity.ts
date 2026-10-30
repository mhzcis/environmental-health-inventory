import type { InventoryTransaction, Material, Storehouse } from '../types';

export const MAX_ATOMIC_FIRESTORE_WRITES = 450;

export type InventoryIntegrityCode =
  | 'DUPLICATE_TRANSACTION_ID'
  | 'DUPLICATE_TRANSACTION_NUMBER'
  | 'TRANSACTION_ID_REQUIRED'
  | 'TRANSACTION_NUMBER_REQUIRED'
  | 'MATERIAL_REFERENCE_REQUIRED'
  | 'MATERIAL_REFERENCE_UNKNOWN'
  | 'WAREHOUSE_REFERENCE_REQUIRED'
  | 'WAREHOUSE_REFERENCE_UNKNOWN'
  | 'INVALID_QUANTITY'
  | 'INVALID_TRANSACTION_TYPE'
  | 'INVALID_TRANSFER_DIRECTION'
  | 'NEGATIVE_RUNNING_BALANCE'
  | 'TRANSFER_OPERATION_REQUIRED'
  | 'TRANSFER_PAIR_COUNT'
  | 'TRANSFER_PAIR_REFERENCE'
  | 'TRANSFER_PAIR_DIRECTION'
  | 'TRANSFER_PAIR_ITEM_MISMATCH'
  | 'TRANSFER_PAIR_QUANTITY_MISMATCH'
  | 'TRANSFER_PAIR_WAREHOUSE_MISMATCH'
  | 'ATOMIC_WRITE_LIMIT_EXCEEDED';

export interface InventoryIntegrityIssue {
  code: InventoryIntegrityCode;
  message: string;
  transactionId?: string;
  operationId?: string;
  itemId?: string;
  storehouseId?: string;
}

export interface InventoryIntegrityResult {
  valid: boolean;
  errors: InventoryIntegrityIssue[];
}

export interface IntegrityTransaction extends InventoryTransaction {
  operationId?: string;
  pairedTransactionId?: string;
}

export interface InventoryIntegrityContext {
  materials: Array<Pick<Material, 'id' | 'initialStock' | 'primaryStorehouseId'>>;
  storehouses: Array<Pick<Storehouse, 'id' | 'name' | 'active'>>;
}

const VALID_TRANSACTION_TYPES = new Set(['وارد', 'صادر', 'مستهلك', 'تحويل', 'تسوية', 'افتتاحي']);

const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const numericTimestamp = (value: string | undefined): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const compareInventoryTransactions = (a: IntegrityTransaction, b: IntegrityTransaction): number => {
  const dateA = clean(a.date);
  const dateB = clean(b.date);
  if (dateA !== dateB) return dateA.localeCompare(dateB);

  const createdA = numericTimestamp(a.createdAt);
  const createdB = numericTimestamp(b.createdAt);
  if (createdA !== createdB) return createdA - createdB;

  return clean(a.id).localeCompare(clean(b.id));
};

export const getInventoryTransactionDirection = (tx: IntegrityTransaction): 'in' | 'out' | null => {
  if (tx.transactionType === 'وارد' || tx.transactionType === 'افتتاحي') return 'in';
  if (tx.transactionType === 'صادر' || tx.transactionType === 'مستهلك') return 'out';
  if (tx.transactionType === 'تحويل') {
    return tx.transferType === 'in' || tx.transferType === 'out' ? tx.transferType : null;
  }
  if (tx.transactionType === 'تسوية') {
    if (tx.transferType === 'in' || tx.transferType === 'out') return tx.transferType;
    return null;
  }
  return null;
};

const push = (
  errors: InventoryIntegrityIssue[],
  code: InventoryIntegrityCode,
  message: string,
  tx?: IntegrityTransaction,
  operationId?: string,
): void => {
  errors.push({
    code,
    message,
    transactionId: tx?.id,
    operationId: operationId || tx?.operationId,
    itemId: tx?.itemId,
    storehouseId: tx?.storehouseId,
  });
};

export const validateAtomicWriteCount = (writeCount: number, limit = MAX_ATOMIC_FIRESTORE_WRITES): InventoryIntegrityResult => {
  const errors: InventoryIntegrityIssue[] = [];
  if (!Number.isInteger(writeCount) || writeCount < 0 || !Number.isInteger(limit) || limit <= 0 || writeCount > limit) {
    push(
      errors,
      'ATOMIC_WRITE_LIMIT_EXCEEDED',
      `تتطلب العملية ${writeCount} كتابة ذرية بينما الحد الآمن المسموح هو ${limit}.`,
    );
  }
  return { valid: errors.length === 0, errors };
};

export const validateTransferOperation = (
  operationTransactions: IntegrityTransaction[],
  operationId: string,
): InventoryIntegrityResult => {
  const errors: InventoryIntegrityIssue[] = [];
  const normalizedOperationId = clean(operationId);
  if (!normalizedOperationId) {
    push(errors, 'TRANSFER_OPERATION_REQUIRED', 'معرف عملية التحويل مطلوب.');
    return { valid: false, errors };
  }

  if (operationTransactions.length !== 2) {
    push(errors, 'TRANSFER_PAIR_COUNT', `عملية التحويل ${normalizedOperationId} يجب أن تحتوي على ساقين فقط.`, undefined, normalizedOperationId);
    return { valid: false, errors };
  }

  const [first, second] = operationTransactions;
  const directions = new Set(operationTransactions.map(getInventoryTransactionDirection));
  if (!directions.has('in') || !directions.has('out') || directions.size !== 2) {
    push(errors, 'TRANSFER_PAIR_DIRECTION', `عملية التحويل ${normalizedOperationId} يجب أن تحتوي على ساق واردة وساق صادرة.`, undefined, normalizedOperationId);
  }

  if (clean(first.operationId) !== normalizedOperationId || clean(second.operationId) !== normalizedOperationId) {
    push(errors, 'TRANSFER_OPERATION_REQUIRED', `ساقا التحويل لا تحملان معرف العملية نفسه.`, undefined, normalizedOperationId);
  }

  if (clean(first.pairedTransactionId) !== clean(second.id) || clean(second.pairedTransactionId) !== clean(first.id)) {
    push(errors, 'TRANSFER_PAIR_REFERENCE', `مراجع زوج التحويل غير متبادلة أو ناقصة.`, undefined, normalizedOperationId);
  }

  if (clean(first.itemId) !== clean(second.itemId)) {
    push(errors, 'TRANSFER_PAIR_ITEM_MISMATCH', `ساقا التحويل مرتبطتان بصنفين مختلفين.`, undefined, normalizedOperationId);
  }

  if (!Number.isFinite(Number(first.quantity)) || !Number.isFinite(Number(second.quantity)) || Number(first.quantity) !== Number(second.quantity)) {
    push(errors, 'TRANSFER_PAIR_QUANTITY_MISMATCH', `كميتا ساقي التحويل غير متطابقتين.`, undefined, normalizedOperationId);
  }

  if (!clean(first.storehouseId) || !clean(second.storehouseId) || clean(first.storehouseId) === clean(second.storehouseId)) {
    push(errors, 'TRANSFER_PAIR_WAREHOUSE_MISMATCH', `مصدر ووجهة التحويل يجب أن يكونا مستودعين مختلفين ومعرفين.`, undefined, normalizedOperationId);
  }

  return { valid: errors.length === 0, errors };
};

const validateIdentityAndReferences = (
  transactions: IntegrityTransaction[],
  context: InventoryIntegrityContext,
): InventoryIntegrityIssue[] => {
  const errors: InventoryIntegrityIssue[] = [];
  const materialIds = new Set(context.materials.map((material) => clean(material.id)).filter(Boolean));
  const storehouseIds = new Set(context.storehouses.map((warehouse) => clean(warehouse.id)).filter(Boolean));
  const ids = new Set<string>();
  const numbers = new Set<string>();

  for (const tx of transactions) {
    const id = clean(tx.id);
    const transactionNumber = clean(tx.transactionNumber);
    const itemId = clean(tx.itemId);
    const storehouseId = clean(tx.storehouseId);

    if (!id) push(errors, 'TRANSACTION_ID_REQUIRED', 'معرف الحركة مطلوب.', tx);
    else if (ids.has(id)) push(errors, 'DUPLICATE_TRANSACTION_ID', `معرف الحركة مكرر: ${id}.`, tx);
    else ids.add(id);

    if (!transactionNumber) push(errors, 'TRANSACTION_NUMBER_REQUIRED', 'رقم السند مطلوب للحركة.', tx);
    else if (numbers.has(transactionNumber)) push(errors, 'DUPLICATE_TRANSACTION_NUMBER', `رقم السند مكرر: ${transactionNumber}.`, tx);
    else numbers.add(transactionNumber);

    if (!itemId) push(errors, 'MATERIAL_REFERENCE_REQUIRED', 'مرجع الصنف مطلوب للحركة.', tx);
    else if (!materialIds.has(itemId)) push(errors, 'MATERIAL_REFERENCE_UNKNOWN', `الحركة مرتبطة بصنف غير موجود: ${itemId}.`, tx);

    if (!storehouseId) push(errors, 'WAREHOUSE_REFERENCE_REQUIRED', 'مرجع المستودع مطلوب للحركة.', tx);
    else if (!storehouseIds.has(storehouseId)) push(errors, 'WAREHOUSE_REFERENCE_UNKNOWN', `الحركة مرتبطة بمستودع غير معروف: ${storehouseId}.`, tx);

    if (!Number.isFinite(Number(tx.quantity)) || Number(tx.quantity) <= 0) {
      push(errors, 'INVALID_QUANTITY', 'كمية الحركة يجب أن تكون رقمًا موجبًا محدودًا.', tx);
    }

    if (!VALID_TRANSACTION_TYPES.has(tx.transactionType)) {
      push(errors, 'INVALID_TRANSACTION_TYPE', `نوع الحركة غير مدعوم: ${String(tx.transactionType)}.`, tx);
    }

    if ((tx.transactionType === 'تحويل' || tx.transactionType === 'تسوية') && getInventoryTransactionDirection(tx) === null) {
      push(errors, 'INVALID_TRANSFER_DIRECTION', 'الحركة تتطلب اتجاه in/out صريحًا.', tx);
    }

    if (tx.transactionType === 'تحويل' && (!clean(tx.operationId) || !clean(tx.pairedTransactionId))) {
      push(errors, 'TRANSFER_OPERATION_REQUIRED', 'حركة التحويل الجديدة يجب أن تحمل operationId وpairedTransactionId.', tx);
    }
  }

  return errors;
};

const validateTransferGroups = (transactions: IntegrityTransaction[]): InventoryIntegrityIssue[] => {
  const errors: InventoryIntegrityIssue[] = [];
  const groups = new Map<string, IntegrityTransaction[]>();

  for (const tx of transactions) {
    if (tx.transactionType !== 'تحويل') continue;
    const operationId = clean(tx.operationId);
    if (!operationId) continue;
    const group = groups.get(operationId) || [];
    group.push(tx);
    groups.set(operationId, group);
  }

  for (const [operationId, group] of groups.entries()) {
    errors.push(...validateTransferOperation(group, operationId).errors);
  }

  return errors;
};

const getLegacyBaseStock = (
  material: Pick<Material, 'id' | 'initialStock' | 'primaryStorehouseId'>,
  transactions: IntegrityTransaction[],
  storehouseId: string,
): number => {
  const hasOpeningTransaction = transactions.some(
    (tx) => clean(tx.itemId) === clean(material.id) && tx.transactionType === 'افتتاحي',
  );
  if (hasOpeningTransaction) return 0;
  if (clean(material.primaryStorehouseId) !== storehouseId) return 0;
  const initial = Number(material.initialStock || 0);
  return Number.isFinite(initial) && initial > 0 ? initial : 0;
};

const validateRunningBalances = (
  transactions: IntegrityTransaction[],
  context: InventoryIntegrityContext,
): InventoryIntegrityIssue[] => {
  const errors: InventoryIntegrityIssue[] = [];
  const byMaterial = new Map(context.materials.map((material) => [clean(material.id), material] as const));
  const groups = new Map<string, IntegrityTransaction[]>();

  for (const tx of transactions) {
    const itemId = clean(tx.itemId);
    const storehouseId = clean(tx.storehouseId);
    if (!itemId || !storehouseId || !byMaterial.has(itemId)) continue;
    const key = `${itemId}\u0000${storehouseId}`;
    const group = groups.get(key) || [];
    group.push(tx);
    groups.set(key, group);
  }

  for (const [key, group] of groups.entries()) {
    const [itemId, storehouseId] = key.split('\u0000');
    const material = byMaterial.get(itemId);
    if (!material) continue;
    let running = getLegacyBaseStock(material, transactions, storehouseId);
    const ordered = [...group].sort(compareInventoryTransactions);

    for (const tx of ordered) {
      const direction = getInventoryTransactionDirection(tx);
      if (!direction) continue;
      const quantity = Number(tx.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      running += direction === 'in' ? quantity : -quantity;
      if (running < -1e-9) {
        push(
          errors,
          'NEGATIVE_RUNNING_BALANCE',
          `الرصيد أصبح سالبًا للصنف ${itemId} في المستودع ${storehouseId} عند الحركة ${tx.id}.`,
          tx,
        );
        break;
      }
    }
  }

  return errors;
};

export const validateInventoryDataset = (
  transactions: IntegrityTransaction[],
  context: InventoryIntegrityContext,
): InventoryIntegrityResult => {
  const errors = [
    ...validateIdentityAndReferences(transactions, context),
    ...validateTransferGroups(transactions),
    ...validateRunningBalances(transactions, context),
  ];
  return { valid: errors.length === 0, errors };
};

export const validateInventoryMutation = (
  currentTransactions: IntegrityTransaction[],
  nextTransactions: IntegrityTransaction[],
  context: InventoryIntegrityContext,
): InventoryIntegrityResult => {
  const currentIds = new Set(currentTransactions.map((tx) => clean(tx.id)).filter(Boolean));
  const nextIds = new Set(nextTransactions.map((tx) => clean(tx.id)).filter(Boolean));
  const changedIds = new Set<string>();

  for (const id of currentIds) if (!nextIds.has(id)) changedIds.add(id);
  for (const id of nextIds) if (!currentIds.has(id)) changedIds.add(id);

  const full = validateInventoryDataset(nextTransactions, context);
  if (!full.valid) return full;

  // A no-op mutation is valid. Callers may use this to make idempotent retries safe.
  return { valid: true, errors: [] };
};

export const getTransferCompanion = (
  transaction: IntegrityTransaction,
  transactions: IntegrityTransaction[],
): IntegrityTransaction | undefined => {
  if (transaction.transactionType !== 'تحويل') return undefined;

  const pairedId = clean(transaction.pairedTransactionId);
  if (pairedId) return transactions.find((candidate) => clean(candidate.id) === pairedId);

  const operationId = clean(transaction.operationId);
  if (operationId) {
    const matches = transactions.filter(
      (candidate) => candidate.transactionType === 'تحويل' && clean(candidate.operationId) === operationId && clean(candidate.id) !== clean(transaction.id),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  // Legacy compatibility: infer only when the old OUT/IN numbering yields one unambiguous peer.
  const number = clean(transaction.transactionNumber);
  const baseNumber = number.replace(/-(OUT|IN)$/i, '');
  if (!baseNumber || baseNumber === number) return undefined;
  const expectedDirection = transaction.transferType === 'out' ? 'in' : transaction.transferType === 'in' ? 'out' : null;
  if (!expectedDirection) return undefined;
  const matches = transactions.filter((candidate) => {
    if (candidate.transactionType !== 'تحويل' || clean(candidate.id) === clean(transaction.id)) return false;
    const candidateBase = clean(candidate.transactionNumber).replace(/-(OUT|IN)$/i, '');
    return candidateBase === baseNumber
      && candidate.transferType === expectedDirection
      && clean(candidate.itemId) === clean(transaction.itemId)
      && Number(candidate.quantity) === Number(transaction.quantity);
  });
  return matches.length === 1 ? matches[0] : undefined;
};

export const attachTransferPairMetadata = (
  source: IntegrityTransaction,
  destination: IntegrityTransaction,
  operationId: string,
): [IntegrityTransaction, IntegrityTransaction] => {
  const normalized = clean(operationId);
  if (!normalized) throw new Error('TRANSFER_OPERATION_REQUIRED');
  return [
    { ...source, operationId: normalized, pairedTransactionId: destination.id },
    { ...destination, operationId: normalized, pairedTransactionId: source.id },
  ];
};
