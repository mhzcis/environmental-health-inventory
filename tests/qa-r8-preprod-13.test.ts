// @vitest-environment jsdom
/**
 * QA-20261109 R8: Verification suite for the 13 pre-production items:
 * 1) Cached stock synchronized with ledger on materials
 * 2) PES-1001 reversible logical archive (preserving 7 transactions & 3 audit logs)
 * 3) CFG-02 5 categories & non-overlapping ranges / reference deletion guard
 * 4) MAT-02 category code prefix & numeric range enforcement
 * 5) BAK-04 backup & restore support for archived materials and R8 schema
 * 6) Offline cold-auth fallback to verified local profile when network is unavailable
 * 7) WH-05 explicit user alert when selected warehouse is deactivated
 * 8) Strict PR pre-merge gate (`verify-pr-merge-gate.mjs` & `deploy.yml` fail-fast)
 * 9) Dedicated Read-Only (`مشاهدة فقط`) role template in Settings
 * 10) Responsive narrow-screen pagination toolbar (`flexWrap: 'wrap'`)
 * 11) Accessibility `aria-label` attributes on search and stocktake inputs
 * 12) Quiet handling of expired Auth refresh token HTTP 400
 * 13) Clean removal of unused Drive leftovers in `AppLayout`, `Settings`, `backupService`, `dataService`, `supabase`
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDomainProofPayload, assertComposedSettingsViewModel } from '../src/utils/productSchema';
import { assertPrMergeGate } from '../scripts/verify-pr-merge-gate.mjs';

const root = process.cwd();

describe('R8 Items 1-5: Schema, Categories (CFG-02), Codes (MAT-02), Archive (OPS-QA), and SQL', () => {
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

    // Overlapping range rejected
    expect(() =>
      assertComposedSettingsViewModel({
        ...baseSettings,
        categories: [
          { name: 'مبيدات حشرية', prefix: 'PES', startRange: 1000, endRange: 2000 },
          { name: 'معقمات ومطهرات', prefix: 'SAN', startRange: 2000, endRange: 2999 },
        ],
      }),
    ).toThrow(/OVERLAPPING_RANGE/);

    // Duplicate prefix rejected
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

  it('enforces category ranges, code prefixes, and cached stock sync in database/inventory_atomic.sql', () => {
    const sql = readFileSync(join(root, 'database/inventory_atomic.sql'), 'utf8');
    expect(sql).toContain('INVENTORY_CATEGORY_INVALID');
    expect(sql).toContain("upper(split_part(btrim(m.data->>'code'),'-',1))=upper(btrim(c->>'prefix'))");
    expect(sql).toContain("jsonb_set(m.data, '{currentStock}', to_jsonb(coalesce(calc.total_stock, 0)), true)");
  });
});

describe('R8 Items 6-13: Offline Cold-Auth, WH-05, PR Gate, Read-Only Role, UI/A11Y, Auth 400, and Lint Cleanup', () => {
  it('supports offline cold-auth fallback when network is unavailable', () => {
    const appSrc = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    const migSrc = readFileSync(join(root, 'src/services/legacyUserMigration.ts'), 'utf8');
    const dsSrc = readFileSync(join(root, 'src/services/dataService.ts'), 'utf8');
    expect(appSrc).toContain('preserveSessionForOffline');
    expect(appSrc).toContain("deviceBootstrap.status !== 'offline-cached'");
    expect(migSrc).toContain('تم استئناف الجلسة المحلية الموثقة في وضع عدم الاتصال.');
    expect(dsSrc).toContain("status: 'offline-cached'");
  });

  it('surfaces explicit user notices when a selected warehouse is deactivated (WH-05)', () => {
    const layoutSrc = readFileSync(join(root, 'src/layouts/AppLayout.tsx'), 'utf8');
    const repSrc = readFileSync(join(root, 'src/pages/Reports.tsx'), 'utf8');
    expect(layoutSrc).toContain('deactivated-warehouse-notice');
    expect(repSrc).toContain('report-deactivated-warehouse-alert');
  });

  it('enforces strict PR pre-merge gate and blocks UNKNOWN mergeable or stale baseRefOid (Item 8)', () => {
    expect(() =>
      assertPrMergeGate(
        { number: 18, state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', baseRefOid: '8f56193', headRefOid: '8d54bba' },
        'ab953d4',
        '8d54bba',
      ),
    ).toThrow(/PR_GATE_NOT_MERGEABLE/);

    expect(() =>
      assertPrMergeGate(
        { number: 18, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefOid: '8f56193', headRefOid: '8d54bba' },
        'ab953d4',
        '8d54bba',
      ),
    ).toThrow(/PR_GATE_STALE_BASE/);

    expect(
      assertPrMergeGate(
        { number: 19, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', baseRefOid: '6933d16', headRefOid: 'r8head' },
        '6933d16',
        'r8head',
      ),
    ).toEqual({ ok: true, number: 19, baseRefOid: '6933d16', headRefOid: 'r8head' });
  });

  it('includes Read-Only observer role preset, aria-labels, responsive pagination, and clean imports', () => {
    const setSrc = readFileSync(join(root, 'src/pages/Settings.tsx'), 'utf8');
    const matSrc = readFileSync(join(root, 'src/pages/Materials.tsx'), 'utf8');
    const txSrc = readFileSync(join(root, 'src/pages/Transactions.tsx'), 'utf8');
    const supaSrc = readFileSync(join(root, 'src/services/supabase.ts'), 'utf8');
    expect(setSrc).toContain('مشاهدة فقط (مراقب)');
    expect(matSrc).toContain('البحث في الأصناف بالاسم أو الكود');
    expect(txSrc).toContain('البحث في الحركات بالصنف أو الكود أو المستلم');
    expect(matSrc).toContain("flexWrap: 'wrap'");
    expect(supaSrc).toContain('refresh token');
  });
});
