// @vitest-environment jsdom
// R8-WH-01: a disabled/missing warehouse selection still resolves to the all-warehouse VIEW filter (never a
// permission), but the fallback is recorded and shown until the user explicitly chooses a scope.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
const fake = vi.hoisted(() => ({ settings: null as any, listeners: new Set<() => void>() }));
vi.mock('../src/services/dataService', () => ({
  dataService: { getSettings: () => fake.settings, subscribe: (fn: () => void) => { fake.listeners.add(fn); return () => fake.listeners.delete(fn); } },
}));
vi.mock('../src/services/offlineDomainStore', () => ({ offlineProjectionStorage: { getItem: () => null, setItem: () => {} } }));
import { StorehouseProvider, useStorehouse } from '../src/context/StorehouseContext';

const settings = (bActive: boolean) => ({
  storehouses: ['QA-A', 'QA-B'], storehouseIds: ['qa-a', 'qa-b'], warehouseSchemaVersion: 2,
  storehouseEntities: [{ id: 'qa-a', name: 'QA-A', active: true }, { id: 'qa-b', name: 'QA-B', active: bActive }],
});
let ctx: ReturnType<typeof useStorehouse>;
const Probe = () => { ctx = useStorehouse(); return null; };
const mount = async () => { const view = render(<StorehouseProvider><Probe /></StorehouseProvider>); await act(async () => { await Promise.resolve(); }); return view; };
beforeEach(() => { localStorage.clear(); fake.listeners.clear(); fake.settings = settings(true); });
afterEach(() => cleanup());

describe('R8-WH-01 warehouse scope fallback is explicit', () => {
  it('R8-WH-C1 a stable active selection stays selected with no notice', async () => {
    localStorage.setItem('inventory_app_storehouse_scope_v2', 'qa-b');
    await mount();
    expect(ctx.selectedStorehouseId).toBe('qa-b'); expect(ctx.scopeFallback).toBeNull();
  });
  it('R8-WH-C2 selection disabled in another session -> all + persistent notice (survives refresh/deep link) until explicit choice', async () => {
    localStorage.setItem('inventory_app_storehouse_scope_v2', 'qa-b');
    const first = await mount();
    expect(ctx.selectedStorehouseId).toBe('qa-b');
    fake.settings = settings(false);
    await act(async () => { for (const fn of fake.listeners) fn(); });
    expect(ctx.selectedStorehouseId).toBe('all');
    expect(ctx.scopeFallback).toMatchObject({ previousId: 'qa-b', previousName: 'QA-B' });
    first.unmount();
    await mount(); // refresh / deep link
    expect(ctx.selectedStorehouse).toBe('all');
    expect(ctx.scopeFallback).toMatchObject({ previousId: 'qa-b' });
    await act(async () => { await ctx.setSelectedStorehouse('qa-a'); });
    expect(ctx.selectedStorehouseId).toBe('qa-a'); expect(ctx.scopeFallback).toBeNull();
  });
  it('R8-WH-C3 cold start with a disabled persisted selection records the fallback; explicit "all" confirmation clears it', async () => {
    fake.settings = settings(false);
    localStorage.setItem('inventory_app_storehouse_scope_v2', 'qa-b');
    await mount();
    expect(ctx.selectedStorehouseId).toBe('all'); expect(ctx.scopeFallback?.previousId).toBe('qa-b');
    await act(async () => { ctx.confirmAllWarehousesScope(); });
    expect(ctx.scopeFallback).toBeNull(); expect(localStorage.getItem('inventory_app_storehouse_scope_fallback_v1')).toBeNull();
  });
});
