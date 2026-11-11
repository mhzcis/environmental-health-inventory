// R8-OPS-01: fake-runner tests. Each failure mode must produce ZERO write (merge/deploy) calls; a valid pinned case
// performs exactly one, and only with --execute.
import { describe, expect, it } from 'vitest';
import { releaseGate, isWriteCall } from '../scripts/release-gate.mjs';
import { compare, normalize } from '../scripts/lint-baseline-gate.mjs';

const BASE = 'a'.repeat(40); const HEAD = 'b'.repeat(40); const OTHER = 'c'.repeat(40);
type Reply = { code: number; stdout?: string };
const fakeRunner = (over: { check?: Reply; views?: Record<string, unknown>[]; tip?: string; runs?: unknown[]; merge?: Reply; throwOn?: string } = {}) => {
  const calls: string[][] = []; let viewIndex = 0;
  const views = over.views || [{}, {}];
  const runner = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (over.throwOn && args.join(' ').includes(over.throwOn)) throw new Error('synthetic');
    if (cmd !== 'gh') return over.check || { code: 0, stdout: '' };
    if (args[0] === 'pr' && args[1] === 'view') {
      const view = { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main', baseRefOid: BASE, headRefOid: HEAD, ...views[Math.min(viewIndex++, views.length - 1)] };
      return { code: 0, stdout: JSON.stringify(view) };
    }
    if (args[0] === 'api') return { code: 0, stdout: `${over.tip ?? BASE}\n` };
    if (args[0] === 'run') return { code: 0, stdout: JSON.stringify(over.runs ?? [{ status: 'completed', conclusion: 'success', name: 'CI', headSha: HEAD }]) };
    if (args[0] === 'pr' && args[1] === 'merge') return over.merge || { code: 0, stdout: '' };
    return { code: 1, stdout: '' };
  };
  return { runner, calls, writes: () => calls.filter(c => isWriteCall(c[0], c.slice(1))).length };
};
const gate = (fake: ReturnType<typeof fakeRunner>, extra: Record<string, unknown> = {}) =>
  releaseGate({ runner: fake.runner, repo: 'o/r', pr: 7, expectedBase: BASE, expectedHead: HEAD, checks: [['npm', 'run', 'typecheck:app']], execute: true, ...extra });

describe('R8-OPS-01 release gate (fake runner)', () => {
  it('R8-OPS-T1 failed assertion -> zero merge/deploy calls', async () => {
    const fake = fakeRunner({ check: { code: 1 } }); const r = await gate(fake);
    expect(r.allowed).toBe(false); expect(r.reason).toMatch(/^ASSERTION_FAILED/); expect(fake.writes()).toBe(0);
    expect(fake.calls).toHaveLength(1);
  });
  it('R8-OPS-T2 UNKNOWN mergeability -> zero writes', async () => {
    const fake = fakeRunner({ views: [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }] }); const r = await gate(fake);
    expect(r.reason).toBe('MERGEABILITY_UNKNOWN'); expect(fake.writes()).toBe(0);
  });
  it('R8-OPS-T3 stale base (PR base moved or branch tip moved) -> zero writes', async () => {
    const a = fakeRunner({ views: [{ baseRefOid: OTHER }] }); expect((await gate(a)).reason).toBe('STALE_BASE'); expect(a.writes()).toBe(0);
    const b = fakeRunner({ tip: OTHER }); expect((await gate(b)).reason).toBe('STALE_BASE'); expect(b.writes()).toBe(0);
  });
  it('R8-OPS-T4 changed head (before or between checks and write) -> zero writes', async () => {
    const a = fakeRunner({ views: [{ headRefOid: OTHER }] }); expect((await gate(a)).reason).toBe('HEAD_CHANGED'); expect(a.writes()).toBe(0);
    const b = fakeRunner({ views: [{}, { headRefOid: OTHER }] }); expect((await gate(b)).reason).toBe('HEAD_CHANGED'); expect(b.writes()).toBe(0);
  });
  it('R8-OPS-T5 failed, pending, missing or foreign-tree CI -> zero writes', async () => {
    for (const runs of [[{ status: 'completed', conclusion: 'failure', headSha: HEAD }], [{ status: 'in_progress', conclusion: null, headSha: HEAD }], [], [{ status: 'completed', conclusion: 'success', headSha: OTHER }]]) {
      const fake = fakeRunner({ runs }); const r = await gate(fake);
      expect(r.allowed).toBe(false); expect(fake.writes()).toBe(0);
    }
  });
  it('R8-OPS-T6 runner error, draft/closed PR, wrong base branch, missing pins -> zero writes', async () => {
    const thrown = fakeRunner({ throwOn: 'run list' }); expect((await gate(thrown)).reason).toMatch(/^RUNNER_ERROR/); expect(thrown.writes()).toBe(0);
    const draft = fakeRunner({ views: [{ isDraft: true }] }); expect((await gate(draft)).allowed).toBe(false); expect(draft.writes()).toBe(0);
    const branch = fakeRunner({ views: [{ baseRefName: 'release' }] }); expect((await gate(branch)).allowed).toBe(false);
    const pins = fakeRunner(); expect((await gate(pins, { expectedHead: 'HEAD' })).reason).toBe('PINS_REQUIRED'); expect(pins.calls).toHaveLength(0);
  });
  it('R8-OPS-T7 valid pinned case performs exactly one write, pinned to the head; dry run performs none', async () => {
    const fake = fakeRunner(); const r = await gate(fake);
    expect(r).toMatchObject({ allowed: true, executed: true }); expect(fake.writes()).toBe(1);
    expect(fake.calls.find(c => c[1] === 'pr' && c[2] === 'merge')).toEqual(['gh', 'pr', 'merge', '7', '--repo', 'o/r', '--merge', '--match-head-commit', HEAD]);
    const dry = fakeRunner(); const d = await gate(dry, { execute: false });
    expect(d).toMatchObject({ allowed: true, executed: false, reason: 'DRY_RUN' }); expect(dry.writes()).toBe(0);
  });
});

describe('R8-LINT-01 baseline gate', () => {
  it('R8-LINT-T1 new diagnostics fail, fixed ones are reported, line moves do not matter', () => {
    const base = normalize("src/a.ts(1,1): error TS6133: 'x' is declared but its value is never read.\n");
    const moved = normalize("src/a.ts(40,7): error TS6133: 'x' is declared but its value is never read.\n");
    expect(compare(base, moved)).toEqual({ added: [], fixed: [] });
    const extra = normalize("src/a.ts(40,7): error TS6133: 'x' is declared but its value is never read.\nsrc/b.ts(2,2): error TS2554: Expected 2 arguments, but got 1.\n");
    expect(compare(base, extra).added).toHaveLength(1);
    expect(compare(base, []).fixed).toHaveLength(1);
  });
});
