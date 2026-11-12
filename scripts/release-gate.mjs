#!/usr/bin/env node
// R8-OPS-01: one fail-closed gate around the release write. Every precondition must pass in order; any non-zero
// exit, UNKNOWN/conflicting mergeability, stale base, changed head, missing or failed CI, or runner error stops the
// gate with ZERO write calls. The only write is `gh pr merge --match-head-commit <pinned head>` (deploy on this repo
// is triggered only by that push to main). Default is a dry run; `--execute` is required for the single write.
//
// Usage: node scripts/release-gate.mjs --repo owner/name --pr N --base <sha> --head <sha> [--check "npm run x"]... [--execute]
import { spawnSync } from 'node:child_process';

const WRITE_COMMANDS = new Set(['merge']);
export const isWriteCall = (cmd, args) => cmd === 'gh' && args[0] === 'pr' && WRITE_COMMANDS.has(args[1]);

const fail = (reason, calls) => ({ allowed: false, executed: false, reason, calls });

export async function releaseGate({ runner, repo, pr, expectedBase, expectedHead, checks = [], execute = false, baseBranch = 'main' }) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const result = await runner(cmd, args);
    if (!result || typeof result.code !== 'number') throw new Error('RUNNER_INVALID_RESULT');
    return result;
  };
  const json = (result) => { try { return JSON.parse(result.stdout); } catch { return undefined; } };
  try {
    if (!repo || !pr || !/^[0-9a-f]{40}$/.test(expectedBase || '') || !/^[0-9a-f]{40}$/.test(expectedHead || '')) return fail('PINS_REQUIRED', calls);
    for (const check of checks) {
      const [cmd, ...args] = check;
      const result = await run(cmd, args);
      if (result.code !== 0) return fail(`ASSERTION_FAILED:${check.join(' ')}`, calls);
    }
    const viewArgs = ['pr', 'view', String(pr), '--repo', repo, '--json', 'state,isDraft,mergeable,mergeStateStatus,baseRefName,baseRefOid,headRefOid'];
    const first = await run('gh', viewArgs);
    const view = first.code === 0 ? json(first) : undefined;
    if (!view) return fail('PR_VIEW_FAILED', calls);
    if (view.state !== 'OPEN' || view.isDraft) return fail(`PR_NOT_OPEN:${view.state}`, calls);
    if (view.baseRefName !== baseBranch) return fail(`BASE_BRANCH_MISMATCH:${view.baseRefName}`, calls);
    if (view.mergeable !== 'MERGEABLE') return fail(`MERGEABILITY_${view.mergeable || 'MISSING'}`, calls);
    if (!['CLEAN', 'HAS_HOOKS'].includes(view.mergeStateStatus)) return fail(`MERGE_STATE_${view.mergeStateStatus || 'MISSING'}`, calls);
    if (view.headRefOid !== expectedHead) return fail('HEAD_CHANGED', calls);
    if (view.baseRefOid !== expectedBase) return fail('STALE_BASE', calls);
    const tip = await run('gh', ['api', `repos/${repo}/commits/${baseBranch}`, '--jq', '.sha']);
    if (tip.code !== 0 || tip.stdout.trim() !== expectedBase) return fail('STALE_BASE', calls);
    const ci = await run('gh', ['run', 'list', '--repo', repo, '--commit', expectedHead, '--json', 'status,conclusion,name,headSha']);
    const runs = ci.code === 0 ? json(ci) : undefined;
    if (!Array.isArray(runs) || runs.length === 0) return fail('CI_MISSING', calls);
    if (runs.some(r => r.headSha && r.headSha !== expectedHead)) return fail('CI_FOR_OTHER_TREE', calls);
    if (runs.some(r => r.status !== 'completed' || r.conclusion !== 'success')) return fail('CI_NOT_GREEN', calls);
    // Re-pin immediately before the write: any change in the meantime stops the gate.
    const second = await run('gh', viewArgs);
    const again = second.code === 0 ? json(second) : undefined;
    if (!again || again.headRefOid !== expectedHead) return fail('HEAD_CHANGED', calls);
    if (again.baseRefOid !== expectedBase) return fail('STALE_BASE', calls);
    if (again.mergeable !== 'MERGEABLE') return fail(`MERGEABILITY_${again.mergeable || 'MISSING'}`, calls);
    if (!execute) return { allowed: true, executed: false, reason: 'DRY_RUN', calls };
    const merge = await run('gh', ['pr', 'merge', String(pr), '--repo', repo, '--merge', '--match-head-commit', expectedHead]);
    if (merge.code !== 0) return { allowed: true, executed: false, reason: 'MERGE_FAILED', calls };
    return { allowed: true, executed: true, reason: 'MERGED', calls };
  } catch (error) {
    return fail(`RUNNER_ERROR:${error instanceof Error ? error.message : String(error)}`, calls);
  }
}

const parseArgs = (argv) => {
  const out = { checks: [], execute: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--execute') out.execute = true;
    else if (key === '--check') out.checks.push(argv[++i].split(' ').filter(Boolean));
    else if (key.startsWith('--')) out[key.slice(2)] = argv[++i];
  }
  return out;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const runner = (cmd, args) => {
    const result = spawnSync(cmd, args, { encoding: 'utf8' });
    return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
  };
  const result = await releaseGate({ runner, repo: options.repo, pr: options.pr, expectedBase: options.base, expectedHead: options.head, checks: options.checks, execute: options.execute, baseBranch: options.branch || 'main' });
  console.log(JSON.stringify({ ...result, calls: result.calls.map(c => c.join(' ')) }, null, 1));
  process.exit(result.allowed && (result.executed || !options.execute) ? 0 : 1);
}
