import { describe, it, expect } from 'vitest';
import { buildMaterialWarehouseView, buildTransactionLedger } from './inventoryLogic';
import { Material } from '../types';

describe('Inventory Logic - buildMaterialWarehouseView', () => {
  const mockMaterials: Material[] = [
    {
      id: 'm1',
      code: 'ITEM01',
      name: 'Item 1',
      category: 'Cat A',
      unit: 'pcs',
      minimumStock: 50,
      currentStock: 100, // Total 100
      storageLocation: 'جميع المستودعات',
      warehouseStocks: {
        'مخزن خانيونس': 60,
        'مخزن رفح': 40
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'm2',
      code: 'ITEM02',
      name: 'Item 2',
      category: 'Cat B',
      unit: 'pcs',
      minimumStock: 20,
      currentStock: 30, // Total 30
      storageLocation: 'مخزن خانيونس',
      warehouseStocks: {
        'مخزن خانيونس': 30
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'm3',
      code: 'ITEM03',
      name: 'Item 3',
      category: 'Cat C',
      unit: 'pcs',
      minimumStock: 10,
      currentStock: 5, // Total 5
      storageLocation: 'مخزن رفح', // Stored directly in storageLocation, no explicit warehouseStocks
      warehouseStocks: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  ];

  const activeStorehouses = ['المخزن الرئيسي', 'مخزن خانيونس', 'مخزن رفح'];

  describe('Global Scope (all warehouses)', () => {
    it('should aggregate stock for all items', () => {
      const view = buildMaterialWarehouseView(mockMaterials, 'all', activeStorehouses);
      const uniqueItems = view.filter(m => !m.isSubRow);
      
      expect(uniqueItems.length).toBe(3);
      
      const totalStock = uniqueItems.reduce((sum, item) => sum + item.currentStock, 0);
      expect(totalStock).toBe(100 + 30 + 5);
      
      const criticalCount = uniqueItems.filter(m => m.currentStock <= m.minimumStock).length;
      expect(criticalCount).toBe(1); // ITEM03 is 5 <= 10
    });
  });

  describe('Khan Younis Scope', () => {
    it('should only show items and stock in Khan Younis', () => {
      const view = buildMaterialWarehouseView(mockMaterials, 'مخزن خانيونس', activeStorehouses);
      const uniqueItems = view.filter(m => !m.isSubRow);
      
      expect(uniqueItems.length).toBe(2); // ITEM01 and ITEM02
      
      const item1 = uniqueItems.find(i => i.id === 'm1');
      expect(item1?.currentStock).toBe(60);
      
      const item2 = uniqueItems.find(i => i.id === 'm2');
      expect(item2?.currentStock).toBe(30);

      const totalStock = uniqueItems.reduce((sum, item) => sum + item.currentStock, 0);
      expect(totalStock).toBe(90);

      const criticalCount = uniqueItems.filter(m => m.currentStock <= m.minimumStock).length;
      expect(criticalCount).toBe(0); // ITEM01: 60 > 50, ITEM02: 30 > 20
    });
  });

  describe('Rafah Scope', () => {
    it('should only show items and stock in Rafah', () => {
      const view = buildMaterialWarehouseView(mockMaterials, 'مخزن رفح', activeStorehouses);
      const uniqueItems = view.filter(m => !m.isSubRow);
      
      expect(uniqueItems.length).toBe(2); // ITEM01 and ITEM03
      
      const item1 = uniqueItems.find(i => i.id === 'm1');
      expect(item1?.currentStock).toBe(40);
      
      const item3 = uniqueItems.find(i => i.id === 'm3');
      expect(item3?.currentStock).toBe(5);

      const totalStock = uniqueItems.reduce((sum, item) => sum + item.currentStock, 0);
      expect(totalStock).toBe(45);

      const criticalCount = uniqueItems.filter(m => m.currentStock <= m.minimumStock).length;
      expect(criticalCount).toBe(2); // ITEM01: 40 <= 50, ITEM03: 5 <= 10
    });
  });

  describe('Transfer Behavior', () => {
    it('Transfer should preserve global invariant stock before and after', () => {
      // Simulate transferring 10 from Khan Younis to Rafah for ITEM01
      const materialsAfterTransfer: Material[] = [
        {
          ...mockMaterials[0],
          warehouseStocks: {
            'مخزن خانيونس': 50,
            'مخزن رفح': 50
          }
        },
        mockMaterials[1],
        mockMaterials[2]
      ];

      const viewBefore = buildMaterialWarehouseView(mockMaterials, 'all', activeStorehouses);
      const uniqueBefore = viewBefore.filter(m => !m.isSubRow);
      const totalBefore = uniqueBefore.reduce((sum, item) => sum + item.currentStock, 0);

      const viewAfter = buildMaterialWarehouseView(materialsAfterTransfer, 'all', activeStorehouses);
      const uniqueAfter = viewAfter.filter(m => !m.isSubRow);
      const totalAfter = uniqueAfter.reduce((sum, item) => sum + item.currentStock, 0);

      expect(totalBefore).toBe(totalAfter); // 135 == 135
    });
  });
});


describe('Inactive Warehouse Semantics', () => {
  it('excludes an item that only exists in an inactive warehouse from all active views', () => {
    const inactiveOnly: Material = { id: 'inactive-only', code: 'I-1', name: 'Inactive only', category: 'C', unit: 'u', minimumStock: 0, currentStock: 25, storageLocation: 'مخزن متوقف', warehouseStocks: { 'مخزن متوقف': 25 }, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
    expect(buildMaterialWarehouseView([inactiveOnly], 'all', ['مخزن فعال'])).toEqual([]);
  });
  it('global ledger excludes inactive warehouse rows and balances', () => {
    const txs: any[] = [
      { id: 'a', itemId: 'm', date: '2026-01-01', createdAt: '2026-01-01T00:00:00Z', storehouse: 'مخزن فعال', transactionType: 'افتتاحي', quantity: 10 },
      { id: 'b', itemId: 'm', date: '2026-01-02', createdAt: '2026-01-02T00:00:00Z', storehouse: 'مخزن متوقف', transactionType: 'افتتاحي', quantity: 99 },
      { id: 'c', itemId: 'm', date: '2026-01-03', createdAt: '2026-01-03T00:00:00Z', storehouse: 'مخزن فعال', transactionType: 'صادر', quantity: 3 },
    ];
    const ledger = buildTransactionLedger(txs, 'all', ['مخزن فعال']);
    expect(ledger.map((tx) => tx.id)).toEqual(['c', 'a']);
    expect(ledger[0].displayStockAfter).toBe(7);
    expect(ledger[1].displayStockAfter).toBe(10);
  });
});
