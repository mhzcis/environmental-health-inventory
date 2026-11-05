import { describe, expect, it } from 'vitest';
import { localDateOffset, localDateString, localMonthString } from './localDate';

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
