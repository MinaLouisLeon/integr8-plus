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
