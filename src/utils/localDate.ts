/**
 * Calendar date (YYYY-MM-DD) in the device's local time zone.
 *
 * `new Date().toISOString().split('T')[0]` returns the UTC date, which is the previous
 * calendar day between local midnight and the UTC offset (00:00–02:00 / 03:00 in
 * Asia/Jerusalem). Ledger dates, "today" filters and dashboard counts must use the
 * local calendar day instead (QA-20261106 FORM-03 / TAB-03).
 */
export const localDateString = (date: Date = new Date()): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** Local calendar month (YYYY-MM). */
export const localMonthString = (date: Date = new Date()): string => localDateString(date).slice(0, 7);

/** Local calendar date shifted by whole days (DST-safe because it moves the local calendar day). */
export const localDateOffset = (days: number, from: Date = new Date()): string => {
  const shifted = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, 12);
  return localDateString(shifted);
};

/**
 * Parses a stored date-only value (YYYY-MM-DD) as a LOCAL calendar date (midnight local time).
 * `new Date('YYYY-MM-DD')` parses as UTC midnight, which in Asia/Jerusalem is 02:00/03:00 local and
 * made day-difference math (Math.ceil) off by one: an item expiring in exactly N days showed N+1.
 */
export const parseLocalDate = (value: string): Date => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return new Date(value);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

/** Whole calendar days from today's local date to `value` (0 = today, negative = past). */
export const daysUntilLocalDate = (value: string, from: Date = new Date()): number => {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((parseLocalDate(value).getTime() - today.getTime()) / 86400000);
};
