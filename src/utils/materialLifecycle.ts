import type { Material } from '../types';

/** R8-ARC-01: an archived material is retained (ledger, audit, reserved code, history) but hidden from active work. */
export const isMaterialArchived = (material: Pick<Material, 'lifecycleStatus'> | null | undefined): boolean =>
  material?.lifecycleStatus === 'archived';

export const activeMaterialsOnly = <T extends Pick<Material, 'lifecycleStatus'>>(materials: T[]): T[] =>
  materials.filter(material => !isMaterialArchived(material));
