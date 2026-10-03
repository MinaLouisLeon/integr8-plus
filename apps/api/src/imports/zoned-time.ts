/**
 * Wall-clock times in a named time zone, to instants.
 *
 * An import says "due by 2026-10-01 17:00". That is 17:00 where the company
 * works, which the person importing told us by importing from their browser;
 * it is not 17:00 UTC. JavaScript can format an instant in a zone but not parse
 * a wall-clock time in one, so the offset is found by formatting a guess and
 * correcting it — twice, which settles across a daylight-saving change.
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

/** Whether the runtime knows this IANA zone name. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
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
 * Parses a date or date-time as written in a spreadsheet.
 *
 * - With an offset or `Z` (`2026-10-01T17:00:00+01:00`): that instant.
 * - Without (`2026-10-01 17:00`, `2026-10-01T17:00`): that wall-clock time in `timeZone`.
 * - A date alone (`2026-10-01`): `endOfDay` gives 23:59:59 that day, otherwise 00:00.
 *
 * Returns `undefined` for anything else, including dates that do not exist.
 */
export function parseZonedDateTime(
  text: string,
  timeZone: string,
  options: { endOfDay?: boolean } = {},
): Date | undefined {
  const trimmed = text.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/u.test(trimmed) && trimmed.includes('T')) {
    const instant = Date.parse(trimmed);
    return Number.isNaN(instant) ? undefined : new Date(instant);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match;
  const dateOnly = hour === undefined;
  const fields = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: dateOnly ? (options.endOfDay === true ? 23 : 0) : Number(hour),
    minute: dateOnly ? (options.endOfDay === true ? 59 : 0) : Number(minute),
    second: dateOnly ? (options.endOfDay === true ? 59 : 0) : Number(second ?? 0),
  };
  const wall = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== fields.year ||
    check.getUTCMonth() !== fields.month - 1 ||
    check.getUTCDate() !== fields.day ||
    fields.hour > 23 ||
    fields.minute > 59 ||
    fields.second > 59
  ) {
    return undefined;
  }
  let instant = wall - offsetAt(wall, timeZone);
  instant = wall - offsetAt(instant, timeZone);
  return new Date(instant);
}
