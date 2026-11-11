#!/usr/bin/env node
/**
 * QA-20261109 R8 Item #8: Strict Pre-Merge Gate for Pull Requests.
 * Prevents the R7b PR #18 procedural failure where `mergeable=UNKNOWN` or a stale `baseRefOid`
 * was followed by `gh pr merge` because the assertion and merge command were not strictly chained.
 *
 * Usage:
 *   node scripts/verify-pr-merge-gate.mjs <pr-json-file-or-string> <expected-main-sha> <expected-head-sha>
 */
import fs from 'node:fs';

export function assertPrMergeGate(prData, expectedMainSha, expectedHeadSha) {
  if (!prData || typeof prData !== 'object') {
    throw new Error('PR_GATE_INVALID_INPUT: PR metadata object is required.');
  }
  if (prData.state !== 'OPEN') {
    throw new Error(`PR_GATE_NOT_OPEN: expected state=OPEN, got ${String(prData.state)}`);
  }
  if (prData.isDraft === true) {
    throw new Error('PR_GATE_IS_DRAFT: draft PR cannot be merged.');
  }
  if (prData.mergeable !== 'MERGEABLE') {
    throw new Error(`PR_GATE_NOT_MERGEABLE: expected mergeable=MERGEABLE, got ${String(prData.mergeable)}`);
  }
  if (expectedMainSha && prData.baseRefOid !== expectedMainSha) {
    throw new Error(`PR_GATE_STALE_BASE: expected baseRefOid=${expectedMainSha}, got ${String(prData.baseRefOid)}`);
  }
  if (expectedHeadSha && prData.headRefOid !== expectedHeadSha) {
    throw new Error(`PR_GATE_HEAD_MISMATCH: expected headRefOid=${expectedHeadSha}, got ${String(prData.headRefOid)}`);
  }
  return { ok: true, number: prData.number, baseRefOid: prData.baseRefOid, headRefOid: prData.headRefOid };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [rawOrFile, expectedMainSha, expectedHeadSha] = process.argv.slice(2);
  if (!rawOrFile || !expectedMainSha || !expectedHeadSha) {
    console.error('Usage: node scripts/verify-pr-merge-gate.mjs <pr.json> <expected-main-sha> <expected-head-sha>');
    process.exit(1);
  }
  const text = fs.existsSync(rawOrFile) ? fs.readFileSync(rawOrFile, 'utf8') : rawOrFile;
  const prData = JSON.parse(text);
  const res = assertPrMergeGate(prData, expectedMainSha, expectedHeadSha);
  console.log(JSON.stringify(res));
}
