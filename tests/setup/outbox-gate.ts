// R8-R1 (R2-R8-09): App opens the outbox send gate only after the live profile check. Suites that drive dataService
// directly (no App) start with it open; a suite can delete this flag + vi.resetModules() to test the real default.
(globalThis as { __R8_OUTBOX_GATE_TEST_OPEN__?: boolean }).__R8_OUTBOX_GATE_TEST_OPEN__ = true;
