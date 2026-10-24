// Pure calendar arithmetic on ISO local dates and offset timestamps. Nothing
// here reads a clock or a time zone database: dates are compared as calendar
// values and timestamps as exact instants from their stated offsets.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// The timestamp forms the contracts accept (`z.iso.datetime()` in Zod 4.6.7,
// optionally with offsets): seconds are required, as RFC 3339 requires with a
// zone, a fraction of any length is optional, and the zone is `Z` or an
// explicit `+HH:MM` / `-HH:MM` offset. calendar.test.ts ties the two together.
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/** Fractional-second digits kept when comparing instants (picoseconds). */
const FRACTION_DIGITS = 12;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  const days = MONTH_DAYS[month - 1];
  if (days === undefined) {
    throw new RangeError(`month ${month} is outside 1 to 12`);
  }
  return days;
}

/** Parses a valid calendar date; throws on anything else (inputs are contract-validated). */
export function parseIsoDate(value: string): CalendarDate {
  const match = ISO_DATE.exec(value);
  if (match === null) {
    throw new RangeError(`${value} is not an ISO calendar date`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`${value} is not a valid calendar date`);
  }
  return { year, month, day };
}

export const formatIsoDate = ({ year, month, day }: CalendarDate) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** Negative, zero or positive as `a` is before, equal to or after `b`. */
export function compareIsoDates(a: string, b: string): number {
  const [x, y] = [parseIsoDate(a), parseIsoDate(b)];
  return x.year - y.year || x.month - y.month || x.day - y.day;
}

/**
 * Calendar-month addition with end-of-month clamping (pack convention C01): the
 * day is kept when the target month has it, otherwise it becomes that month's
 * last day. 2026-03-31 plus six months is 2026-09-30; 2027-08-31 plus six
 * months is 2028-02-29.
 */
export function addCalendarMonths(date: string, months: number): string {
  if (!Number.isInteger(months)) {
    throw new RangeError('months must be an integer');
  }
  const { year, month, day } = parseIsoDate(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = index - targetYear * 12 + 1;
  return formatIsoDate({ year: targetYear, month: targetMonth, day: Math.min(day, daysInMonth(targetYear, targetMonth)) });
}

export function addDays(date: string, days: number): string {
  let { year, month, day } = parseIsoDate(date);
  day += days;
  while (day > daysInMonth(year, month)) {
    day -= daysInMonth(year, month);
    [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
  }
  while (day < 1) {
    [year, month] = month === 1 ? [year - 1, 12] : [year, month - 1];
    day += daysInMonth(year, month);
  }
  return formatIsoDate({ year, month, day });
}

/** Days from 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's days_from_civil). */
function daysFromCivil({ year, month, day }: CalendarDate): bigint {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return BigInt(era * 146097 + dayOfEra - 719468);
}

/**
 * The exact instant of a timestamp with a `Z` or explicit offset, as
 * picoseconds since the Unix epoch, or `undefined` when the text is not such a
 * timestamp. No zone or time is ever assumed.
 */
export function instantOf(timestamp: string): bigint | undefined {
  const match = TIMESTAMP.exec(timestamp);
  if (match === null) {
    return undefined;
  }
  const [, y, mo, d, h, mi, s, fraction = '', zulu, sign, offsetHours, offsetMinutes] = match;
  const date = { year: Number(y), month: Number(mo), day: Number(d) };
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > daysInMonth(date.year, date.month)) {
    return undefined;
  }
  const [hours, minutes, seconds] = [Number(h), Number(mi), Number(s)];
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return undefined;
  }
  let offsetSeconds = 0;
  if (zulu === undefined) {
    const [oh, om] = [Number(offsetHours), Number(offsetMinutes)];
    if (oh > 23 || om > 59) {
      return undefined;
    }
    offsetSeconds = (sign === '-' ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const wholeSeconds = daysFromCivil(date) * 86400n + BigInt(hours * 3600 + minutes * 60 + seconds - offsetSeconds);
  const picoseconds = BigInt(fraction.slice(0, FRACTION_DIGITS).padEnd(FRACTION_DIGITS, '0'));
  return wholeSeconds * 10n ** BigInt(FRACTION_DIGITS) + picoseconds;
}

/** The instant of `HH:MM:SS` UTC on an ISO date. */
export function utcInstantOn(date: string, time: string): bigint {
  const instant = instantOf(`${date}T${time}Z`);
  if (instant === undefined) {
    throw new RangeError(`${date}T${time}Z is not a valid UTC timestamp`);
  }
  return instant;
}
