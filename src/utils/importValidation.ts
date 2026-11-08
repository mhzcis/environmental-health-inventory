// Spreadsheet values must never silently become zero or today's date.
/** QA-20261108 IMP-02: application-authored Arabic validation text that is safe to show with its row number. */
export class ImportValidationError extends Error {}
/** A rejection mapped to a spreadsheet row (1-based, header = row 1). Rendered verbatim: it is built only from app text and the user's own file values. */
export class ImportRowError extends Error {
  constructor(readonly row: number, reason: string) { super(`السطر ${row}، ${reason}`); }
}
export function importNumber(value: unknown, label: string): number {
  const text = String(value ?? '').trim();
  const number = Number(text);
  if (!text || !Number.isFinite(number) || number < 0) throw new ImportValidationError(`قيمة «${label}» يجب أن تكون رقمًا صالحًا غير سالب.`);
  return number;
}

export function importDate(value: unknown): string {
  let text = String(value ?? '').trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Math.round((value - 25569) * 86400000));
    if (!Number.isNaN(date.getTime())) text = date.toISOString().slice(0, 10);
  }
  const parts = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (parts) text = `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ImportValidationError('التاريخ مطلوب بصيغة سنة-شهر-يوم أو يوم-شهر-سنة.');
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new ImportValidationError('التاريخ غير موجود في التقويم.');
  return text;
}

export async function importTransactionId(fields: unknown[], occurrence: number): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([fields, occurrence]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `tx-import-${Array.from(hash, n => n.toString(16).padStart(2, '0')).join('')}`;
}
