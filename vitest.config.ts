import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // P13: the former standalone Puppeteer executables are retired; the PDF identity behavior is
    // covered by tests/p13_pdf_preflight_identity.test.ts and scripts/p13_pdf_browser_gate.ts.
    exclude: [...configDefaults.exclude],
  },
});
