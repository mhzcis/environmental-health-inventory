import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // P13: the former standalone Puppeteer executables are retired; the PDF identity behavior is
    // covered by tests/p13_pdf_preflight_identity.test.ts and scripts/p13_pdf_browser_gate.ts.
    exclude: [...configDefaults.exclude],
    // R8-R1 (R2-R8-09): the outbox send gate starts closed in the app; service-level suites that do not mount App
    // pre-open it here. tests/r8-client-integration.test.ts (R1-GATE-1) covers the closed default explicitly.
    setupFiles: ['tests/setup/outbox-gate.ts'],
  },
});
