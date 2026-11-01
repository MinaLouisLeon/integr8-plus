import {
  ar,
  type Catalogue,
  en,
  formatCalendarDate,
  formatDate,
  type Messages,
} from '@integr8/i18n/core';

/**
 * The words the server writes to people on its own, in the reader's language.
 *
 * No language is stored per person: each app picks one per device. So a push
 * notification is written in the language its phone registered with (English
 * when it did not say), and a reminder email or banner, which goes to people
 * rather than to a device, in the company's own language setting
 * (`tenant_settings.locale`). The texts are in the i18n catalogues under
 * `notifications`, where a parity test keeps English and Arabic in step.
 */

/** The languages a message can be written in. */
export type MessageLocale = 'en' | 'ar';

export type NotificationWords = Catalogue<Messages['notifications']>;

/** A stored or sent language tag as one this product writes in: Arabic, or English. */
export function messageLocale(tag: string | null | undefined): MessageLocale {
  return tag?.trim().toLowerCase().startsWith('ar') === true ? 'ar' : 'en';
}

export function wordsFor(locale: MessageLocale): NotificationWords {
  return locale === 'ar' ? ar.notifications : en.notifications;
}

/** `{{name}}` in a catalogue string, replaced by the values given; unknown names are left as they are. */
export function fill(template: string, values: Readonly<Record<string, string>> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (whole, name: string) => values[name] ?? whole);
}

/**
 * The locale dates are written in. British English for English, which is what
 * these messages have always used (`2 March 2026`), and plain Arabic for Arabic,
 * as the apps do.
 */
export function dateLocale(locale: MessageLocale): string {
  return locale === 'ar' ? 'ar' : 'en-GB';
}

/** `2 March 2026`, in UTC. A deadline in the reader's time zone is a guess. */
export function dayWords(at: Date, locale: MessageLocale): string {
  return formatDate(at, { locale: dateLocale(locale), timeZone: 'UTC' });
}

/** `14 January 2028` for a calendar day, which has no time zone to get wrong. */
export function calendarDayWords(value: string, locale: MessageLocale): string {
  return formatCalendarDate(value, { locale: dateLocale(locale) });
}

/** A moment in the company's time zone: `2 Mar 2026, 14:30`. */
export function momentFormatter(locale: MessageLocale, timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(dateLocale(locale), {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
