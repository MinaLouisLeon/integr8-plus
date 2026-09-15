/**
 * Dates as a person on the phone reads them, in the phone's own time zone.
 *
 * Hermes ships `Intl`, so these follow the app's language — an Arabic reader
 * gets Arabic month names and digits without a formatting library.
 */

export function formatWhen(value: string | Date, locale: string, now = new Date()): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        },
  ).format(date);
}

export function formatBytes(bytes: number, locale: string): string {
  const megabytes = bytes / (1024 * 1024);
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: megabytes < 10 ? 1 : 0 }).format(megabytes)} MB`;
}

/** "2 h 05 min", "25 min": how long something took, rounded down to the minute. */
export function formatDuration(ms: number, locale: string): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const number = new Intl.NumberFormat(locale, { minimumIntegerDigits: hours > 0 ? 2 : 1 });
  return hours > 0
    ? `${new Intl.NumberFormat(locale).format(hours)} h ${number.format(minutes)} min`
    : `${number.format(minutes)} min`;
}
