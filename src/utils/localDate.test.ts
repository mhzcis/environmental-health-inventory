import { describe, expect, it } from 'vitest';
import { daysUntilLocalDate, localDateOffset, localDateString, localMonthString, parseLocalDate } from './localDate';

describe('localDateString (QA-20261106 local-midnight boundary)', () => {
  it('uses the local calendar day, not the UTC day', () => {
    // 2026-11-06 01:33 local; with TZ=Asia/Jerusalem (UTC+2) the UTC date is 2026-11-05.
    const d = new Date(2026, 10, 6, 1, 33);
    expect(localDateString(d)).toBe('2026-11-06');
    expect(localMonthString(new Date(2026, 11, 1, 0, 30))).toBe('2026-12');
  });
  it('offsets by local calendar days across month and year ends', () => {
    expect(localDateOffset(-1, new Date(2026, 0, 1, 0, 30))).toBe('2025-12-31');
    expect(localDateOffset(-7, new Date(2026, 10, 6, 1, 0))).toBe('2026-10-30');
    expect(localDateOffset(-30, new Date(2026, 2, 1, 0, 15))).toBe('2026-01-30');
  });
  it('matches toISOString only when the local day equals the UTC day', () => {
    const noon = new Date(2026, 10, 6, 12, 0);
    expect(localDateString(noon)).toBe('2026-11-06');
  });
});

describe('daysUntilLocalDate (QA-20261106 expiry threshold off-by-one)', () => {
  const from = new Date(2026, 10, 6, 2, 50); // 02:50 local
  it('counts whole local calendar days (threshold day is exactly N)', () => {
    expect(daysUntilLocalDate('2026-11-06', from)).toBe(0);
    expect(daysUntilLocalDate('2026-11-07', from)).toBe(1);
    expect(daysUntilLocalDate('2026-11-05', from)).toBe(-1);
    expect(daysUntilLocalDate('2027-02-04', from)).toBe(90);
    expect(daysUntilLocalDate('2027-02-03', from)).toBe(89);
  });
  it('is stable across the DST change (2027-03-26 in Asia/Jerusalem)', () => {
    expect(daysUntilLocalDate('2027-04-01', new Date(2027, 2, 20, 23, 30))).toBe(12);
  });
  it('parses YYYY-MM-DD as local midnight', () => {
    const d = parseLocalDate('2026-12-31');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 11, 31, 0]);
  });
});
