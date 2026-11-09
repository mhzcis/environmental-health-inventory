import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// QA 2026-11-06 (WK-OBS-01): the printed voucher claimed to be "encrypted and electronically archived".
// There is no voucher-level encryption or signature in the implementation (only TLS transport and an
// idempotency digest of the mutation payload), and vouchers can be deleted by authorised users, so the
// claim is unsupported. The footer must describe the document without security claims.
describe('printed voucher footer wording', () => {
  const src = readFileSync('src/pages/Transactions.tsx', 'utf8');
  it('does not claim encryption or archiving', () => {
    expect(src).not.toMatch(/مشفر/);
    expect(src).not.toMatch(/مؤرشف/);
  });
  it('still prints the voucher number in the footer', () => {
    expect(src).toMatch(/سند صادر من نظام إدارة المخزون - رقم \{transactionToPrint\.transactionNumber \|\| transactionToPrint\.id\}/);
  });
});
