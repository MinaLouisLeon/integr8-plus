import { addDays } from './finance.js';

export { daysBetween } from './ledger.js';

/**
 * Calendar days and wall-clock times in a company's time zone (P27).
 *
 * Days are `YYYY-MM-DD` strings throughout: a maintenance plan is due on a
 * day, not at an instant, and a day does not move when the clocks change.
 * Instants are only made at the edge, from a day and a time of day in the
 * company's zone.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time falls at in a zone: `minutes` after midnight
 * on `day`. The offset is found by guessing and correcting twice, which
 * settles across a daylight-saving change. A time the clocks skip lands just
 * after the gap.
 */
export function zonedInstant(day: string, minutes: number, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, date) + minutes * 60_000;
  let instant = wall - offsetAt(wall, timeZone);
  instant = wall - offsetAt(instant, timeZone);
  return new Date(instant);
}

/** ISO weekday of a day: 1 is Monday, 7 is Sunday. */
export function isoWeekday(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * `months` calendar months after `day`, kept on the same day of the month, or
 * the month's last day when it is shorter: 31 January plus one month is
 * 28 (or 29) February.
 */
export function addMonths(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const target = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(target / 12);
  const targetMonth = target - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const result = new Date(Date.UTC(targetYear, targetMonth, Math.min(date, lastDay)));
  return result.toISOString().slice(0, 10);
}

/** The later of two days. */
export function laterDay(a: string, b: string): string {
  return a >= b ? a : b;
}

/** The earlier of two days. */
export function earlierDay(a: string, b: string): string {
  return a <= b ? a : b;
}

/** The day before. */
export function dayBefore(day: string): string {
  return addDays(day, -1);
}
