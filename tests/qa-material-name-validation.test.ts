import { describe, it, expect } from 'vitest';
import { materialSchema } from '../src/components/MaterialFormDialog';

// QA 2026-11-06: a whitespace-only material name passed client validation (min(3) on the raw string),
// the server rejected it (INVENTORY_MATERIAL_INVALID) and the rejected mutation blocked the device outbox.
const base = { category: 'CX', code: '', initialStock: 0, minimumStock: 0, storageLocation: 'CX-A', unit: 'لتر', isEditMode: false };

describe('material form name validation (trim before length check)', () => {
  it('rejects whitespace-only names', () => {
    expect(materialSchema.safeParse({ ...base, name: '    ' }).success).toBe(false);
    expect(materialSchema.safeParse({ ...base, name: ' \t  \u00a0 ' }).success).toBe(false);
  });
  it('rejects names shorter than 3 characters after trimming', () => {
    expect(materialSchema.safeParse({ ...base, name: '  ab  ' }).success).toBe(false);
  });
  it('trims surrounding spaces from accepted names', () => {
    const r = materialSchema.safeParse({ ...base, name: '  CX padded name  ' });
    expect(r.success).toBe(true);
    expect(r.success && r.data.name).toBe('CX padded name');
  });
  it('accepts Arabic, English and mixed names', () => {
    for (const name of ['صنف عربي', 'CX English Name', 'مبيد ABC-12 بتركيز 2.5%']) expect(materialSchema.safeParse({ ...base, name }).success).toBe(true);
  });
  it('rejects whitespace-only category/unit/storehouse', () => {
    expect(materialSchema.safeParse({ ...base, name: 'CX ok', category: '  ' }).success).toBe(false);
    expect(materialSchema.safeParse({ ...base, name: 'CX ok', unit: ' ' }).success).toBe(false);
    expect(materialSchema.safeParse({ ...base, name: 'CX ok', storageLocation: ' ' }).success).toBe(false);
  });
});
