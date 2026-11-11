/**
 * R8-RBAC-01: least-privilege observer preset. Read-only views; no create/edit/delete/archive, settings, users,
 * reset, generator or audit. Viewing is not exporting: export/print are an explicit, separate opt-in.
 */
export const READER_PERMISSION_PRESET: readonly string[] = Object.freeze(['dashboard_view', 'materials_view', 'transactions_view', 'reports_view']);
export const READER_EXPORT_OPT_IN: readonly string[] = Object.freeze(['reports_export', 'reports_print']);
export const READER_FORBIDDEN_PERMISSIONS: readonly string[] = Object.freeze([
  'materials_create', 'materials_edit', 'materials_delete', 'materials_stocktake', 'materials_archive',
  'transactions_create', 'transactions_delete', 'audit_view', 'generator_log', 'settings_view', 'settings_edit',
  'users_manage', 'system_reset',
]);
export const readerPermissions = (options: { allowExport?: boolean } = {}): string[] =>
  [...READER_PERMISSION_PRESET, ...(options.allowExport ? READER_EXPORT_OPT_IN : [])];
