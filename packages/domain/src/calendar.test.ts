import { OffsetTimestamp, UtcTimestamp } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import { addCalendarMonths, addDays, compareIsoDates, daysInMonth, instantOf, isLeapYear, parseIsoDate, utcInstantOn } from './calendar.js';

describe('calendar-month addition (convention C01)', () => {
  it.each([
    ['2026-08-20', 6, '2027-02-20'],
    ['2026-03-31', 6, '2026-09-30'],
    ['2027-08-31', 6, '2028-02-29'],
    ['2025-08-31', 6, '2026-02-28'],
    ['2023-08-29', 6, '2024-02-29'],
    ['2023-08-30', 6, '2024-02-29'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2024-02-29', 48, '2028-02-29'],
    ['2026-07-31', 6, '2027-01-31'],
    ['2026-12-15', 6, '2027-06-15'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2026-01-31', 0, '2026-01-31'],
  ])('%s plus %i months is %s', (date, months, expected) => {
    expect(addCalendarMonths(date, months)).toBe(expected);
  });

  it('rejects fractional months and invalid dates', () => {
    expect(() => addCalendarMonths('2026-01-01', 1.5)).toThrow(RangeError);
    expect(() => addCalendarMonths('2026-02-29', 6)).toThrow(RangeError);
  });
});

describe('Gregorian calendar', () => {
  it('knows leap years and month lengths', () => {
    expect([1900, 2000, 2024, 2026, 2028, 2100].map(isLeapYear)).toEqual([false, true, true, false, true, false]);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(() => daysInMonth(2026, 13)).toThrow(RangeError);
  });

  it('parses only real calendar dates', () => {
    expect(parseIsoDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    for (const invalid of ['2027-02-29', '2026-13-01', '2026-04-31', '2026-4-01', '20260401']) {
      expect(() => parseIsoDate(invalid)).toThrow(RangeError);
    }
  });

  it('compares dates as calendar values', () => {
    expect(compareIsoDates('2026-09-02', '2026-08-20')).toBeGreaterThan(0);
    expect(compareIsoDates('2026-08-20', '2026-08-20')).toBe(0);
    expect(compareIsoDates('2025-12-31', '2026-01-01')).toBeLessThan(0);
  });

  it.each([
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-01', -1, '2025-12-31'],
    ['2026-01-31', 31, '2026-03-03'],
  ])('%s plus %i days is %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe('instants from explicit offsets', () => {
  it('compares timestamps across offsets without assuming a zone', () => {
    expect(instantOf('2026-09-10T09:00:00-07:00')).toBe(instantOf('2026-09-10T16:00:00Z'));
    expect(instantOf('2026-09-10T00:30:00+14:00')).toBe(instantOf('2026-09-09T10:30:00Z'));
    expect(instantOf('2026-09-10T16:00:00.5Z')! > instantOf('2026-09-10T16:00:00.499999Z')!).toBe(true);
    expect(instantOf('1970-01-01T00:00:00Z')).toBe(0n);
    expect(instantOf('1970-01-02T00:00:00Z')).toBe(86_400n * 10n ** 12n);
  });

  it('handles leap days and year ends', () => {
    expect(instantOf('2028-03-01T00:00:00Z')! - instantOf('2028-02-28T00:00:00Z')!).toBe(2n * 86_400n * 10n ** 12n);
    expect(instantOf('2027-01-01T00:00:00+01:00')).toBe(instantOf('2026-12-31T23:00:00Z'));
    expect(utcInstantOn('2026-09-01', '12:00:00')).toBe(instantOf('2026-09-01T12:00:00Z'));
  });

  it('refuses anything that is not an exact instant', () => {
    for (const text of ['2026-09-10T16:00Z', '2026-09-10T16:00:00', '2026-09-10 16:00:00Z', '2026-02-30T00:00:00Z', '2026-09-10T24:00:00Z', '2026-09-10T16:00:00+0700']) {
      expect(instantOf(text)).toBeUndefined();
    }
  });
});

describe('instants accept exactly the contract timestamp forms', () => {
  // Every combination of these parts, valid or not, against the installed Zod.
  const dates = ['2026-09-10', '2028-02-29', '2027-02-29', '2100-02-29', '2000-02-29', '0000-02-29', '2026-02-30', '2026-13-01'];
  const times = ['16:00', '16:00:00', '00:00:00', '23:59:59', '24:00:00', '23:60:00', '23:59:60', '9:00:00'];
  const fractions = ['', '.5', '.123', '.123456789', '.123456789012345', '.'];
  const zones = ['Z', 'z', '', '+00:00', '-07:00', '+05:30', '+23:59', '-23:59', '+24:00', '+07:60', '+0700', '+07'];
  const forms = dates.flatMap((date) => times.flatMap((time) => fractions.flatMap((fraction) => zones.map((zone) => `${date}T${time}${fraction}${zone}`))));
  forms.push('2026-09-10 16:00:00Z', '2026-09-10t16:00:00Z', ' 2026-09-10T16:00:00Z', '2026-09-10T16:00:00Z ');

  it('reads every offset timestamp the contract accepts, and nothing it refuses', () => {
    const disagreements = forms.filter((text) => (instantOf(text) !== undefined) !== OffsetTimestamp.safeParse(text).success);
    expect(disagreements).toEqual([]);
    expect(forms.filter((text) => OffsetTimestamp.safeParse(text).success).length).toBeGreaterThan(100);
  });

  it('reads every UTC timestamp the contract accepts', () => {
    const accepted = forms.filter((text) => UtcTimestamp.safeParse(text).success);
    expect(accepted.length).toBeGreaterThan(20);
    expect(accepted.filter((text) => instantOf(text) === undefined)).toEqual([]);
  });
});
