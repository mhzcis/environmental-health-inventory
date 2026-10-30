/**
 * P10 Security Authority Contract helpers.
 *
 * Server authority for durable cloud mutations is Firestore Rules exclusively.
 * Client hasPermission / UI hide / localStorage are NEVER cloud authority (G-C2).
 * UX-only permissions control feature eligibility only and must not broaden cloud access.
 */

/** Permissions that exist for application/UX eligibility only — no Rules collection predicate. */
export const UX_ONLY_PERMISSION_IDS = [
  'dashboard_view',
  'reports_view',
  'reports_export',
  'reports_print',
  'materials_stocktake',
] as const;

export type UxOnlyPermissionId = (typeof UX_ONLY_PERMISSION_IDS)[number];

export const isUxOnlyPermission = (permission: string): boolean =>
  (UX_ONLY_PERMISSION_IDS as readonly string[]).includes(permission);

/**
 * Stocktake (POL-1): materials_stocktake = UX/feature-eligibility ONLY.
 * Cloud/business effects MUST satisfy transactions_create at Firestore Rules.
 * hasPermission('materials_stocktake') MUST NOT substitute for server auth.
 */
export const STOCKTAKE_UX_PERMISSION = 'materials_stocktake' as const;
export const STOCKTAKE_CLOUD_EFFECT_PERMISSION = 'transactions_create' as const;

/** Error codes thrown when a new protected enqueue is refused (POL-4). Prior durable work is untouched. */
export const PROTECTED_ENQUEUE_REFUSED_PREFIX = 'PROTECTED_ENQUEUE_REFUSED:' as const;

export type ProtectedEnqueueBlockReason =
  | 'NO_AUTH'
  | 'SESSION_TERMINATED'
  | 'INACTIVE_OR_MISSING_PROFILE'
  | 'AUTH_UID_MISMATCH'
  | 'PROFILE_REVOKED';

let protectedEnqueueBlockReason: ProtectedEnqueueBlockReason | null = null;

export function blockProtectedCloudEnqueue(reason: ProtectedEnqueueBlockReason): void {
  protectedEnqueueBlockReason = reason;
}

export function clearProtectedCloudEnqueueBlock(): void {
  protectedEnqueueBlockReason = null;
}

export function getProtectedCloudEnqueueBlockReason(): ProtectedEnqueueBlockReason | null {
  return protectedEnqueueBlockReason;
}

export function protectedEnqueueRefusedError(reason: ProtectedEnqueueBlockReason): Error {
  return new Error(`${PROTECTED_ENQUEUE_REFUSED_PREFIX}${reason}`);
}

export function isProtectedEnqueueRefusedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.startsWith(PROTECTED_ENQUEUE_REFUSED_PREFIX);
}
