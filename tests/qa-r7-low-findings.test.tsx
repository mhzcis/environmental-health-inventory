// @vitest-environment jsdom
/**
 * QA-20261109 R7 low findings:
 * 1) unknown hash routes show Arabic not-found (not a blank main area)
 * 2) web manifest ships installable icons (192/512 + maskable)
 * 3) PDF success toast does not claim a completed download (cancel is undetectable)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import NotFound from '../src/pages/NotFound';

const root = process.cwd();

describe('R7 low-01: unknown route not-found page', () => {
  afterEach(() => cleanup());

  it('renders Arabic not-found copy and a home link', () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('not-found-page')).toBeTruthy();
    expect(screen.getByText('الصفحة غير موجودة')).toBeTruthy();
    expect(screen.getByRole('link', { name: /العودة إلى الصفحة الرئيسية/ })).toBeTruthy();
  });

  it('Router registers a catch-all route to NotFound without altering known paths', () => {
    const src = readFileSync(join(root, 'src/app/Router.tsx'), 'utf8');
    expect(src).toMatch(/path="\*"/);
    expect(src).toMatch(/NotFound/);
    for (const path of ['/', '/materials', '/transactions', '/reports', '/settings', '/audit', '/generator-log', '/pesticides']) {
      expect(src).toContain(`path="${path}"`);
    }
  });

  it('AppLayout still gates known routes by permission (unknown routes stay out of that map)', () => {
    const src = readFileSync(join(root, 'src/layouts/AppLayout.tsx'), 'utf8');
    expect(src).toMatch(/routePermissions/);
    expect(src).toMatch(/لا تمتلك صلاحية|لا تمتلك الصلاحية الكافية/);
    expect(src).not.toMatch(/NotFound/);
  });
});

describe('R7 low-02: installable manifest icons', () => {
  it('manifest declares 192, 512 any, and 512 maskable icons', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
    expect(Array.isArray(manifest.icons)).toBe(true);
    const byPurpose = Object.fromEntries(
      manifest.icons.map((icon: { purpose: string; sizes: string; src: string }) => [`${icon.purpose}:${icon.sizes}`, icon]),
    );
    expect(byPurpose['any:192x192']?.src).toContain('icon-192.png');
    expect(byPurpose['any:512x512']?.src).toContain('icon-512.png');
    expect(byPurpose['maskable:512x512']?.src).toContain('icon-512-maskable.png');
    for (const icon of manifest.icons) {
      const rel = String(icon.src).replace(/^\.\//, '');
      expect(existsSync(join(root, 'public', rel))).toBe(true);
    }
  });

  it('service worker shell caches icons and bumps cache to v4', () => {
    const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');
    expect(sw).toMatch(/CACHE_VERSION = `\$\{CACHE_PREFIX\}v4`/);
    expect(sw).toContain('./icons/icon-192.png');
    expect(sw).toContain('./icons/icon-512.png');
    expect(sw).toContain('./icons/icon-512-maskable.png');
    // activate still drops only older prefixes so v3→v4 updates cleanly
    expect(sw).toMatch(/key\.startsWith\(CACHE_PREFIX\) && key !== CACHE_VERSION/);
    expect(sw).toMatch(/self\.skipWaiting/);
    expect(sw).toMatch(/clients\.claim/);
  });
});

const fake = vi.hoisted(() => ({
  materials: [] as any[],
  transactions: [] as any[],
  logs: [] as any[],
  warehouse: 'all',
  permissions: true,
  denied: [] as string[],
  pdf: vi.fn(),
  save: vi.fn(),
  retry: vi.fn(),
}));

vi.mock('../src/services/dataService', () => ({
  dataService: {
    getSettings: () => ({
      organizationName: 'QA معزول',
      departmentName: 'QA فحص',
      expiryWarningThresholdDays: 30,
      categories: [{ name: 'QA-C1' }],
      units: ['قطعة'],
      storehouses: ['QA-A'],
      partners: [],
    }),
    getMaterials: () => fake.materials,
    getTransactions: () => fake.transactions,
    getGeneratorLogs: () => fake.logs,
    subscribe: () => () => {},
    hasPermission: (p: string) => fake.permissions && !fake.denied.includes(p),
    listPendingInventoryMutations: async () => [],
    retryPendingInventoryMutations: () => fake.retry(),
    getOpeningStockAttachment: () => null,
    getStorehouseInitialStock: () => 0,
  },
}));
vi.mock('../src/context/StorehouseContext', () => ({
  useStorehouse: () => ({ selectedStorehouse: fake.warehouse, activeStorehouses: ['QA-A'] }),
}));
vi.mock('../src/utils/printHtml', () => ({
  requireStableStringPart: (s: any) => {
    if (typeof s !== 'string' || !s.trim()) throw new Error('invalid id');
    return s.trim();
  },
  exportToPDF: (...a: any[]) => fake.pdf(...a),
}));
vi.mock('file-saver', () => ({ saveAs: (...a: any[]) => fake.save(...a) }));
vi.mock('../src/components/CreateTransactionModal', () => ({ default: () => null }));
vi.mock('../src/services/supabaseOutbox', () => ({
  subscribeInventoryOutbox: () => () => {},
  inventoryRequestLabelAr: () => 'طلب محفوظ',
  rejectedGroup: (rows: any[]) => rows.filter((r: any) => r.status === 'blocked'),
  InventoryPendingError: class extends Error {
    constructor(readonly mutationId: string, readonly blocked: boolean) {
      super('QA pending');
    }
  },
}));

import Reports from '../src/pages/Reports';

describe('R7 low-03: PDF toast does not claim completed download', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows prepared-for-download wording after PDF export succeeds', async () => {
    fake.permissions = true;
    fake.denied = [];
    fake.pdf.mockReset().mockResolvedValue(undefined);
    fake.materials = [
      {
        id: 'qa-r0',
        code: 'QA-1000',
        name: 'QA صنف',
        category: 'QA-C1',
        type: 'مادة',
        unit: 'قطعة',
        minimumStock: 5,
        currentStock: 10,
        initialStock: 10,
        initialStocks: { 'QA-A': 10 },
        warehouseStocks: { 'QA-A': 10 },
        storageLocation: 'QA-A',
      },
    ];
    fake.transactions = [];
    fake.logs = [];
    render(<Reports />);
    fireEvent.click(screen.getByRole('button', { name: 'طباعة pdf' }));
    await waitFor(() => expect(fake.pdf).toHaveBeenCalledOnce());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/تم تجهيز الملف للتنزيل/);
    expect(alert.textContent).not.toMatch(/تم توليد وتنزيل/);
    expect(alert.textContent).not.toMatch(/وتنزيل.*بنجاح/);
  });

  it('printHtml documents that browser download cancel cannot be detected', () => {
    const src = readFileSync(join(root, 'src/utils/printHtml.ts'), 'utf8');
    expect(src).toMatch(/must not claim the file was saved/);
  });
});


import { downloadPreparedMessage, isDownloadAbortError, DOWNLOAD_PREPARED_MESSAGE } from '../src/utils/downloadFeedback';

describe('R7 low-03 helper: downloadFeedback wording', () => {
  it('builds accurate prepared-for-download messages', () => {
    expect(downloadPreparedMessage()).toBe(DOWNLOAD_PREPARED_MESSAGE);
    expect(downloadPreparedMessage('تقرير.pdf')).toBe(`${DOWNLOAD_PREPARED_MESSAGE}: تقرير.pdf`);
    expect(DOWNLOAD_PREPARED_MESSAGE).toBe('تم تجهيز الملف للتنزيل');
    expect(DOWNLOAD_PREPARED_MESSAGE).not.toMatch(/تم تنزيل|تم توليد وتنزيل/);
  });

  it('detects AbortError so callers can skip success toasts', () => {
    expect(isDownloadAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isDownloadAbortError(new Error('network failed'))).toBe(false);
    expect(isDownloadAbortError(null)).toBe(false);
  });

  it('download/export call sites no longer claim completed download', () => {
    const files = [
      'src/pages/Reports.tsx',
      'src/pages/Transactions.tsx',
      'src/pages/Materials.tsx',
      'src/pages/Settings.tsx',
      'src/pages/GeneratorLog.tsx',
    ];
    for (const rel of files) {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).not.toMatch(/تم توليد وتنزيل/);
      expect(src).not.toMatch(/تم تنزيل/);
      expect(src).toMatch(/downloadPreparedMessage/);
    }
  });
});
