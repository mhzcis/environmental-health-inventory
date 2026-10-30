import type { AppSettings } from '../types';
import { canonicalizeWarehouseSettings } from '../utils/warehouseSettings';
import { stripSyncMetadata } from '../utils/syncProtocol';

/** Convert the Supabase app_config row into the strictly validated local view model. */
export function composeSupabaseAppSettings(
  remote: Record<string, unknown>,
  defaults: AppSettings,
): AppSettings {
  const { id: _documentId, ...settings } = stripSyncMetadata(remote);
  // The initial direct-Supabase schema stores the composed document with this legacy
  // cloud-only marker. A slim document or an unknown version must still fail validation.
  if (settings.settingsSchemaVersion === 3 && Array.isArray(settings.categories)) {
    delete settings.settingsSchemaVersion;
  }
  return canonicalizeWarehouseSettings({
    ...defaults,
    ...settings,
    cloudSyncEnabled: true,
    firebaseInitialized: true,
  } as AppSettings);
}
