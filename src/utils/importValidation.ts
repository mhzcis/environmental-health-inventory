// Spreadsheet values must never silently become zero or today's date.
export function importNumber(value: unknown, label: string): number {
  const text = String(value ?? '').trim();
  const number = Number(text);
  if (!text || !Number.isFinite(number) || number < 0) throw new Error(`${label}: يلزم رقم صالح غير سالب.`);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('التاريخ مطلوب بصيغة YYYY-MM-DD أو يوم/شهر/سنة.');
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error('التاريخ غير موجود في التقويم.');
  return text;
}

export async function importTransactionId(fields: unknown[], occurrence: number): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([fields, occurrence]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `tx-import-${Array.from(hash, n => n.toString(16).padStart(2, '0')).join('')}`;
}
