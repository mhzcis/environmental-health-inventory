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
