// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDomainProofPayload, assertComposedSettingsViewModel } from '../src/utils/productSchema';
import { assertPrMergeGate } from '../scripts/verify-pr-merge-gate.mjs';

const root = process.cwd();

describe('R8 Pre-Production 13 Items Verification', () => {
  it('accepts archived, archivedAt, and archivedReason on materials in productSchema', () => {
    expect(() =>
      assertDomainProofPayload('materials', {
        id: 'mat-1793795662160',
        code: 'PES-1001',
        name: 'QA_ACCEPTANCE_20261104 — صنف اختبار قبل التشغيل',
        category: 'مبيدات حشرية',
        unit: 'لتر',
        minimumStock: 2,
        currentStock: 10,
        initialStock: 10,
        primaryStorehouseId: 'wh-0ulyoh6',
        storageLocation: 'المخزن الرئيسي',
        warehouseStocks: { 'المخزن الرئيسي': 9, 'مخزن ب': 1 },
        archived: true,
        archivedAt: '2026-11-09T07:00:00.000Z',
        archivedReason: 'أرشفة صنف تجريبي قبل الإدخال الفعلي',
      }),
    ).not.toThrow();
  });

  it('enforces non-overlapping category ranges and unique prefixes in assertComposedSettingsViewModel (CFG-02)', () => {
    const baseSettings = {
      organizationName: 'مكتب صحة البيئة - خان يونس',
      departmentName: 'دائرة البنى التحتية',
      expiryWarningThresholdDays: 90,
      units: ['لتر', 'كجم'],
      storehouses: ['المخزن الرئيسي'],
      categories: [
        { name: 'مبيدات حشرية', prefix: 'PES', startRange: 1000, endRange: 1999 },
        { name: 'معقمات ومطهرات', prefix: 'SAN', startRange: 2000, endRange: 2999 },
      ],
    };
    expect(() => assertComposedSettingsViewModel(baseSettings)).not.toThrow();
    expect(() =>
      assertComposedSettingsViewModel({
        ...baseSettings,
        categories: [
          { name: 'مبيدات حشرية', prefix: 'PES', startRange: 1000, endRange: 2000 },
          { name: 'معقمات ومطهرات', prefix: 'SAN', startRange: 2000, endRange: 2999 },
        ],
      }),
    ).toThrow(/OVERLAPPING_RANGE/);
    expect(() =>
      assertComposedSettingsViewModel({
        ...baseSettings,
        categories: [
          { name: 'مبيدات حشرية', prefix: 'PES', startRange: 1000, endRange: 1999 },
          { name: 'معقمات ومطهرات', prefix: 'pes', startRange: 2000, endRange: 2999 },
        ],
      }),
    ).toThrow(/INVALID_OR_DUPLICATE_PREFIX/);
  });

  it('enforces strict PR pre-merge gate and blocks UNKNOWN mergeable or stale baseRefOid (Item 8)', () => {
    expect(() =>
      assertPrMergeGate(
        { number: 18, state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', baseRefOid: '8f56193', headRefOid: '8d54bba' },
        'ab953d4',
        '8d54bba',
      ),
    ).toThrow(/PR_GATE_NOT_MERGEABLE/);
    expect(
      assertPrMergeGate(
        { number: 19, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefOid: '6933d16', headRefOid: 'r8head' },
        '6933d16',
        'r8head',
      ),
    ).toEqual({ ok: true, number: 19, baseRefOid: '6933d16', headRefOid: 'r8head' });
  });

  it('verifies R8 SQL, offline cold-auth, WH-05 alerts, observer role, and a11y/responsive attributes', () => {
    const sql = readFileSync(join(root, 'database/inventory_atomic.sql'), 'utf8');
    expect(sql).toContain('INVENTORY_CATEGORY_INVALID');
    expect(sql).toContain("jsonb_set(m.data, '{currentStock}', to_jsonb(coalesce(calc.total_stock, 0)), true)");
    expect(readFileSync(join(root, 'src/App.tsx'), 'utf8')).toContain('preserveSessionForOffline');
    expect(readFileSync(join(root, 'src/layouts/AppLayout.tsx'), 'utf8')).toContain('deactivated-warehouse-notice');
    expect(readFileSync(join(root, 'src/pages/Reports.tsx'), 'utf8')).toContain('report-deactivated-warehouse-alert');
    expect(readFileSync(join(root, 'src/pages/Settings.tsx'), 'utf8')).toContain('مشاهدة فقط (مراقب)');
    expect(readFileSync(join(root, 'src/pages/Materials.tsx'), 'utf8')).toContain('البحث في الأصناف بالاسم أو الكود');
  });
});
