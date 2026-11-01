/**
 * Dates and times, without `Date`.
 *
 * `Date` parses loosely, formats by host time zone, and has historically parsed
 * the same string differently in different engines — `new Date('2026-03-04')` is
 * UTC midnight in one and local midnight in another. A form that asks "was the
 * inspection before the certificate expired?" cannot give two answers.
 *
 * So each kind has one strict text form, parsed here into a plain integer:
 *
 * | Kind       | Stored as                     | Compared as              |
 * | ---------- | ----------------------------- | ------------------------ |
 * | `date`     | `2026-09-13`                  | days since 1970-01-01    |
 * | `time`     | `14:05`                       | minutes since midnight   |
 * | `datetime` | `2026-09-13T14:05:00+03:00`   | seconds since the epoch  |
 *
 * A `datetime` must carry its offset. Without one, "14:05" means a different
 * instant on the phone in Cairo and on the server in Frankfurt.
 */

const DATE_TEXT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TIME_TEXT = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const DATETIME_TEXT =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9]))?(Z|[+-](?:0[0-9]|1[0-4]):[0-5][0-9])$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * Days from 1970-01-01 to a proleptic Gregorian date, in integer arithmetic.
 *
 * Howard Hinnant's `days_from_civil`. Every division below is on a non-negative
 * or explicitly floored value, so there is no rounding for two engines to do
 * differently.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const monthIndex = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilDay(yearText: string, monthText: string, dayText: string): number | undefined {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return undefined;
  }
  return daysFromCivil(year, month, day);
}

/** Days since the epoch, or `undefined` for anything that is not a real calendar date. */
export function parseDate(text: string): number | undefined {
  const match = DATE_TEXT.exec(text);
  if (match === null) {
    return undefined;
  }
  return civilDay(match[1] ?? '', match[2] ?? '', match[3] ?? '');
}

/** Minutes since midnight. */
export function parseTime(text: string): number | undefined {
  const match = TIME_TEXT.exec(text);
  if (match === null) {
    return undefined;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Seconds since the epoch, UTC, with the stated offset applied. */
export function parseDatetime(text: string): number | undefined {
  const match = DATETIME_TEXT.exec(text);
  if (match === null) {
    return undefined;
  }

  const day = civilDay(match[1] ?? '', match[2] ?? '', match[3] ?? '');
  if (day === undefined) {
    return undefined;
  }

  const localSeconds =
    day * 86_400 + Number(match[4]) * 3_600 + Number(match[5]) * 60 + Number(match[6] ?? '0');

  const offset = match[7] ?? 'Z';
  if (offset === 'Z') {
    return localSeconds;
  }

  const sign = offset.startsWith('-') ? -1 : 1;
  const offsetSeconds =
    (Number(offset.slice(1, 3)) * 3_600 + Number(offset.slice(4, 6)) * 60) * sign;
  return localSeconds - offsetSeconds;
}

// ---------------------------------------------------------------------------
// Date arithmetic (schema version 2)
// ---------------------------------------------------------------------------

const FIRST_DAY = daysFromCivil(1, 1, 1);
/** The latest date a calculation may produce: four-digit years only, like the text form. */
const LAST_DAY = daysFromCivil(9999, 12, 31);

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * The calendar date of a day count, `YYYY-MM-DD`: Howard Hinnant's
 * `civil_from_days`, the inverse of `daysFromCivil`, in the same integer
 * arithmetic. `undefined` outside the years 1 to 9999.
 */
export function formatDate(days: number): string | undefined {
  if (!Number.isSafeInteger(days) || days < FIRST_DAY || days > LAST_DAY) {
    return undefined;
  }
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * A date moved by a whole number of days, weeks or months.
 *
 * Days and weeks are plain day counts: a date has no time of day, so no time
 * zone and no daylight-saving change can move it. Months keep the day of the
 * month and clamp to the end of a shorter month — 31 January plus one month is
 * 28 February (29 in a leap year), and 31 March minus one month the same —
 * which is what a person counting on a calendar means by "a month later".
 * `undefined` past the years 1 to 9999.
 */
export function shiftDays(
  days: number,
  unit: 'days' | 'weeks' | 'months',
  amount: number,
): number | undefined {
  if (!Number.isSafeInteger(amount) || formatDate(days) === undefined) {
    return undefined;
  }
  if (unit !== 'months') {
    const moved = days + amount * (unit === 'weeks' ? 7 : 1);
    return formatDate(moved) === undefined ? undefined : moved;
  }
  const text = formatDate(days) ?? '';
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const monthsSinceYearOne = (year - 1) * 12 + (month - 1) + amount;
  const targetYear = Math.floor(monthsSinceYearOne / 12) + 1;
  const targetMonth = monthsSinceYearOne - (targetYear - 1) * 12 + 1;
  if (targetYear < 1 || targetYear > 9999) {
    return undefined;
  }
  return daysFromCivil(
    targetYear,
    targetMonth,
    Math.min(day, daysInMonth(targetYear, targetMonth)),
  );
}
