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
