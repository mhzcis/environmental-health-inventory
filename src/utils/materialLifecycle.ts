import type { Material } from '../types';

/** R8-ARC-01: an archived material is retained (ledger, audit, reserved code, history) but hidden from active work. */
export const isMaterialArchived = (material: Pick<Material, 'lifecycleStatus'> | null | undefined): boolean =>
  material?.lifecycleStatus === 'archived';

export const activeMaterialsOnly = <T extends Pick<Material, 'lifecycleStatus'>>(materials: T[]): T[] =>
  materials.filter(material => !isMaterialArchived(material));

/** R8-R1 (R2-R8-02): label carried by every archived-item row that is explicitly included in a report or export. */
export const ARCHIVED_ROW_LABEL = '(مؤرشف)';
/**
 * R8-R1 (R2-R8-02): movement reports, their Excel/PDF exports and the dashboard exclude the movements of archived
 * materials by default. With includeArchived they are appended AFTER all active rows, flagged archivedMaterial and
 * labelled in the item name, so they are always separated and visibly marked.
 */
export const scopeTransactionsByArchive = <T extends { itemId: string; itemName?: string }>(
  transactions: T[], materials: Pick<Material, 'id' | 'lifecycleStatus'>[], includeArchived: boolean,
): (T & { archivedMaterial?: true })[] => {
  const archived = new Set(materials.filter(isMaterialArchived).map(material => material.id));
  const active = transactions.filter(tx => !archived.has(tx.itemId));
  if (!includeArchived || archived.size === 0) return active;
  const labelled = transactions.filter(tx => archived.has(tx.itemId)).map(tx => ({
    ...tx, archivedMaterial: true as const,
    itemName: `${tx.itemName || ''} ${ARCHIVED_ROW_LABEL}`.trim(),
  }));
  return [...active, ...labelled];
};
/** Keeps archived rows after active rows (a ledger re-sorts by date). */
export const archivedRowsLast = <T extends { archivedMaterial?: boolean }>(rows: T[]): T[] =>
  [...rows.filter(row => !row.archivedMaterial), ...rows.filter(row => row.archivedMaterial)];
