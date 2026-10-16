import type { Field, GeoPoint } from '@integr8/form-engine';
import { formatCalendarDate, formatDateTime, formatList, formatNumber } from '@integr8/i18n/core';
import { type DocumentLocale, fill, type RenderWords } from './words.js';

/**
 * An answer as the document prints it: option labels rather than their
 * stored values, dates in the document's language, units after numbers.
 * The same reading the apps give an answer (form-renderer-dom's AnswerValue),
 * as plain text. Photos and signatures are images and are drawn by the
 * renderer; here they count.
 */

export interface FormatContext {
  locale: DocumentLocale;
  words: RenderWords;
  /** The company's time zone, for a date-and-time answer. */
  timeZone: string;
}

/** True when there is nothing to show: no answer, an empty text, an empty list. */
export function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function labelOf(field: Field, value: string, locale: DocumentLocale): string {
  if (!('options' in field)) {
    return value;
  }
  const option = field.options.find((candidate) => candidate.value === value);
  return option === undefined ? value : say(option.label, locale);
}

/** A localised text in the document's language, or the first one there is. */
export function say(text: Readonly<Record<string, string>> | undefined, locale: string): string {
  if (text === undefined) {
    return '';
  }
  return text[locale] ?? text.en ?? Object.values(text)[0] ?? '';
}

function decimalText(value: string, locale: DocumentLocale, places?: number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return value;
  }
  return places === undefined
    ? formatNumber(number, { locale, maximumFractionDigits: 6 })
    : new Intl.NumberFormat(locale, {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
      }).format(number);
}

function withUnit(text: string, unit: string | undefined): string {
  return unit === undefined || unit === '' ? text : `${text} ${unit}`;
}

/** The answer to one field as text, or the "unanswered" mark. */
export function formatAnswer(field: Field, value: unknown, context: FormatContext): string {
  const { locale, words } = context;
  if (isBlank(value)) {
    return words.unanswered;
  }
  switch (field.type) {
    case 'text':
    case 'long_text':
    case 'barcode':
      return typeof value === 'string' ? value : String(value);
    case 'number':
      return withUnit(
        typeof value === 'number' ? formatNumber(value, { locale }) : String(value),
        field.unit,
      );
    case 'decimal':
      return withUnit(decimalText(String(value), locale, field.decimalPlaces), field.unit);
    case 'rating':
      return fill(words.rating, {
        value: typeof value === 'number' ? formatNumber(value, { locale }) : String(value),
        scale: formatNumber(field.scale, { locale }),
      });
    case 'date':
      return typeof value === 'string' ? formatCalendarDate(value, { locale }) : String(value);
    case 'time':
      return String(value);
    case 'datetime':
      return typeof value === 'string'
        ? formatDateTime(value, { locale, timeZone: context.timeZone })
        : String(value);
    case 'dropdown':
    case 'radio':
      return labelOf(field, String(value), locale);
    case 'multi_select':
      return Array.isArray(value)
        ? formatList(
            value.map((item) => labelOf(field, String(item), locale)),
            { locale },
          )
        : String(value);
    case 'checkbox':
      return value === true ? words.ticked : words.notTicked;
    case 'yes_no':
      return value === 'yes' ? words.yes : value === 'no' ? words.no : words.notApplicable;
    case 'gps': {
      const point = value as Partial<GeoPoint>;
      if (typeof point.latitude !== 'string' || typeof point.longitude !== 'string') {
        return words.unanswered;
      }
      const latitude = decimalText(point.latitude, locale, 6);
      const longitude = decimalText(point.longitude, locale, 6);
      return point.accuracyMeters === undefined
        ? fill(words.location, { latitude, longitude })
        : fill(words.locationWithin, {
            latitude,
            longitude,
            accuracy: decimalText(point.accuracyMeters, locale, 0),
          });
    }
    case 'photo':
    case 'file':
      return fill(words.files, {
        count: formatNumber(Array.isArray(value) ? value.length : 1, { locale }),
      });
    case 'signature':
      return words.ticked;
    default:
      return String(value);
  }
}

/** The media ids an answer holds: a signature's one, a photo field's several. */
export function mediaIdsOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item === 'object' && item !== null && 'mediaId' in item) {
      const id = (item as { mediaId: unknown }).mediaId;
      if (typeof id === 'string') {
        ids.push(id);
      }
    }
  }
  return ids;
}
