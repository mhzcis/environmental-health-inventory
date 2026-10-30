import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Storehouse } from '../types';
import { dataService } from '../services/dataService';
import { offlineProjectionStorage } from '../services/offlineDomainStore';
import { getActiveStorehouses, getStorehouseByReference, resolveWarehouseScope } from '../utils/warehouseDomain';

const LEGACY_SCOPE_KEY = 'inventory_app_storehouse_filter';
const V2_SCOPE_KEY = 'inventory_app_storehouse_scope_v2';

type WarehouseScopeId = 'all' | string;

interface StorehouseContextType {
  selectedStorehouse: string;
  selectedStorehouseId: WarehouseScopeId;
  activeStorehouses: Storehouse[];
  setSelectedStorehouse: (storehouse: string) => Promise<void>;
}

const StorehouseContext = createContext<StorehouseContextType>({
  selectedStorehouse: 'all',
  selectedStorehouseId: 'all',
  activeStorehouses: [],
  setSelectedStorehouse: async () => {},
});

const readRawScope = (): string => {
  return (
    offlineProjectionStorage.getItem(V2_SCOPE_KEY) ||
    globalThis.localStorage?.getItem(V2_SCOPE_KEY) ||
    offlineProjectionStorage.getItem(LEGACY_SCOPE_KEY) ||
    globalThis.localStorage?.getItem(LEGACY_SCOPE_KEY) ||
    'all'
  );
};

const persistResolvedScope = (id: WarehouseScopeId, name: string): void => {
  try {
    offlineProjectionStorage.setItem(V2_SCOPE_KEY, id);
    offlineProjectionStorage.setItem(LEGACY_SCOPE_KEY, name);
    globalThis.localStorage?.setItem(V2_SCOPE_KEY, id);
    globalThis.localStorage?.setItem(LEGACY_SCOPE_KEY, name);
  } catch {
    // Ignore storage quota errors
  }
};

export const StorehouseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const durableScopeRef = useRef<string | null>(null);
  const [settings, setSettings] = useState(() => dataService.getSettings());
  const [selectedStorehouseId, setSelectedStorehouseId] = useState<WarehouseScopeId>(() => {
    const currentSettings = dataService.getSettings();
    const raw = readRawScope();
    const resolved = resolveWarehouseScope(currentSettings, raw);
    return resolved.selectedStorehouseId;
  });

  useEffect(() => dataService.subscribe(() => setSettings(dataService.getSettings())), []);

  const activeStorehouses = useMemo(() => getActiveStorehouses(settings), [settings]);
  const selectedEntity = selectedStorehouseId === 'all'
    ? undefined
    : getStorehouseByReference(settings, selectedStorehouseId, false);
  const selectedStorehouse = selectedEntity?.name || 'all';

  useEffect(() => {
    const durableKey = `${selectedStorehouseId}\u0000${selectedStorehouse}`;
    if (durableScopeRef.current === durableKey) return;
    durableScopeRef.current = durableKey;
    if (selectedStorehouseId !== 'all' && !selectedEntity) {
      persistResolvedScope('all', 'all');
      durableScopeRef.current = 'all\u0000all';
      setSelectedStorehouseId('all');
      return;
    }
    persistResolvedScope(selectedStorehouseId, selectedStorehouse);
  }, [selectedStorehouseId, selectedStorehouse, selectedEntity]);

  const setSelectedStorehouse = async (reference: string): Promise<void> => {
    const resolved = resolveWarehouseScope(settings, reference);
    persistResolvedScope(resolved.selectedStorehouseId, resolved.selectedStorehouseName);
    durableScopeRef.current = `${resolved.selectedStorehouseId}\u0000${resolved.selectedStorehouseName}`;
    setSelectedStorehouseId(resolved.selectedStorehouseId);
  };

  return (
    <StorehouseContext.Provider value={{ selectedStorehouse, selectedStorehouseId, activeStorehouses, setSelectedStorehouse }}>
      {children}
    </StorehouseContext.Provider>
  );
};

export const useStorehouse = () => useContext(StorehouseContext);
