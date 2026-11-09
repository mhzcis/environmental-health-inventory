// QA-20261108 TX-03: correction link (cancel + replacement) is accepted by the client schema and preserved for the audit view.
import { describe, expect, it } from 'vitest';
import { assertDomainProofPayload } from './productSchema';
import { normalizeAuditLog } from './auditPolicy';

const base = { id: 'tr-new', date: '2026-11-08', itemId: 'm1', quantity: 3, transactionNumber: 'W-0005', transactionType: 'وارد' };
describe('TX-03 correction link', () => {
  it('accepts a replacement carrying the cancelled original values', () => {
    expect(() => assertDomainProofPayload('transactions', { ...base, correctionOf: { id: 'tr-old', transactionNumber: 'W-0004', quantity: 5, reason: 'كمية خاطئة' } })).not.toThrow();
  });
  it('rejects a malformed or incomplete link', () => {
    expect(() => assertDomainProofPayload('transactions', { ...base, correctionOf: 'tr-old' })).toThrow(/PRODUCT_SCHEMA_REJECTED/);
    expect(() => assertDomainProofPayload('transactions', { ...base, correctionOf: { id: 'tr-old', transactionNumber: 'W-0004', reason: 'x' } })).toThrow(/REQUIRED/);
    expect(() => assertDomainProofPayload('transactions', { ...base, correctionOf: { id: 'tr-old', transactionNumber: 'W-0004', quantity: 5, reason: 'x', extra: 1 } })).toThrow(/UNAUTHORIZED_FIELD/);
  });
  it('keeps the server receipt link for the audit page', () => {
    const log = normalizeAuditLog({ id: 'r1', timestamp: '2026-11-08T10:00:00Z', user: 'u', action: 'تصحيح حركة مخزنية (إلغاء وبديل)', details: 'd',
      corrections: [{ originalNumber: 'W-0004', originalQuantity: 5, replacementNumber: 'W-0005', replacementQuantity: 3, reason: 'كمية خاطئة' }] });
    expect(log?.corrections).toEqual([{ originalNumber: 'W-0004', originalQuantity: 5, replacementNumber: 'W-0005', replacementQuantity: 3, reason: 'كمية خاطئة' }]);
  });
});
