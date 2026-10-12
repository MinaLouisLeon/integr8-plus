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

/**
 * A quantity as the server sends it — a decimal string — in the reader's
 * language, with its unit's word when given. Like amounts, the string goes to
 * `Intl` as a string.
 */
export function formatQuantity(quantity: string, locale: string, unit?: string): string {
  let number: string;
  try {
    number = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(
      quantity as unknown as number,
    );
  } catch {
    number = quantity;
  }
  return unit === undefined ? number : `${number} ${unit}`;
}

/**
 * An amount, as the server sends it — a decimal string — in the reader's
 * language, with its currency when known. The string goes to `Intl` as a
 * string, so no digit is lost to a JavaScript number on the way.
 */
export function formatMoney(amount: string, currency: string | null, locale: string): string {
  const format = (options: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, options).format(amount as unknown as number);
  try {
    return currency === null
      ? format({ maximumFractionDigits: 4 })
      : format({ style: 'currency', currency, maximumFractionDigits: 4 });
  } catch {
    return currency === null ? amount : `${amount} ${currency}`;
  }
}
