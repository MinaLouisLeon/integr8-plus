import {
  DEFINITION_SCHEMA_VERSION,
  type Field,
  formatDecimal,
  type Information,
  type InformationStyle,
  parseDecimal,
} from '@integr8/form-engine';
import { offsetText, say } from './text.js';

/**
 * What schema version 2 (1.3.0) asks of every filler: knowing when a form is
 * too new for this app, the moment `now` reads, a calculated date written the
 * way the language writes dates, and an Information block's parts.
 */

/**
 * Whether a definition is written in a newer format than this app's engine
 * reads. Such a form is not broken: the person is asked to update the app to
 * open it, before anything is started on the phone.
 */
export function needsNewerApp(definition: unknown): boolean {
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return false;
  }
  const declared = (definition as { schemaVersion?: unknown }).schemaVersion;
  return (
    typeof declared === 'number' &&
    Number.isInteger(declared) &&
    declared > DEFINITION_SCHEMA_VERSION
  );
}

/**
 * This device's clock as the engine's `now` reads it: a date and time to the
 * second, with the offset in force here — `2026-09-13T14:05:09+03:00`.
 */
export function localNow(at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const local = `${String(at.getFullYear()).padStart(4, '0')}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return `${local}${offsetText(-at.getTimezoneOffset())}`;
}

/**
 * A calculated answer as a person reads it: a decimal without padding noise, a
 * whole number as is, and a date (schema version 2) the way the language
 * writes one. Empty while there is nothing to show.
 */
export function calculatedText(field: Field, value: unknown, locale: string): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (field.type === 'decimal' && typeof value === 'string') {
    const parsed = parseDecimal(value);
    return parsed === undefined ? value : formatDecimal(parsed);
  }
  if (field.type === 'date' && typeof value === 'string') {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
  }
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '';
}

/** An Information block, ready to show: its heading (or none), its paragraph's lines and its style. */
export interface InformationText {
  heading: string | undefined;
  /** The paragraph split at its line breaks. Plain text: nothing in it is markup. */
  lines: string[];
  style: InformationStyle;
}

export function informationText(item: Information, locale: string): InformationText {
  const heading = say(item.heading, locale).trim();
  return {
    heading: heading === '' ? undefined : heading,
    lines: say(item.body, locale).replace(/\r\n?/gu, '\n').split('\n'),
    style: item.style ?? 'plain',
  };
}
