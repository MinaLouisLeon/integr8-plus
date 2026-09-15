import type { GeoPoint, Option } from '@integr8/form-engine';
import { normaliseDigits } from './text.js';

/**
 * Turning what a person did with a control into an answer.
 *
 * Every renderer calls these, so a form filled on a phone and the same form
 * filled on a desktop store the same bytes: the same integer for "٤٢", the same
 * option order for a multi-select, the same six decimal places for a location.
 */

/**
 * A whole number as it is typed. The answer is an integer, but typing passes
 * through states that are not one — "-" on the way to "-5" — so a renderer keeps
 * the text until it is a number.
 *
 * `answer` is what to store (`''` clears), or undefined while unfinished.
 */
export function readInteger(typed: string): {
  text: string;
  answer: number | '' | undefined;
  unfinished: boolean;
} {
  const text = normaliseDigits(typed).trim();
  if (text === '') {
    return { text, answer: '', unfinished: false };
  }
  if (/^-?\d+$/u.test(text)) {
    return { text, answer: Number.parseInt(text, 10), unfinished: false };
  }
  return { text, answer: undefined, unfinished: true };
}

/** A decimal answer is decimal text, as typed with the engine's digits. */
export function readDecimal(typed: string): string {
  return normaliseDigits(typed).trim();
}

/** A multi-select after ticking or unticking one option: in the form's option order. */
export function toggleOption(
  options: readonly Pick<Option, 'value'>[],
  selected: readonly string[],
  value: string,
  checked: boolean,
): string[] {
  return checked
    ? options
        .map((candidate) => candidate.value)
        .filter((candidate) => candidate === value || selected.includes(candidate))
    : selected.filter((candidate) => candidate !== value);
}

export const GPS_DECIMALS = 6;

/**
 * A location answer from a device fix. Coordinates are decimal text at six
 * places (about 11 cm), accuracy at one; never floating-point numbers.
 */
export function geoPointFrom(coords: {
  latitude: number;
  longitude: number;
  accuracy: number | null | undefined;
}): GeoPoint {
  return {
    latitude: coords.latitude.toFixed(GPS_DECIMALS),
    longitude: coords.longitude.toFixed(GPS_DECIMALS),
    ...(coords.accuracy === null || coords.accuracy === undefined
      ? {}
      : { accuracyMeters: Math.max(0, coords.accuracy).toFixed(1) }),
  };
}

export type GeoPart = 'latitude' | 'longitude' | 'accuracyMeters';

/**
 * A location answer after typing into one of its boxes. Undefined means the
 * question is now empty and should be cleared.
 */
export function editGeoPoint(
  point: Partial<GeoPoint> | undefined,
  part: GeoPart,
  typed: string,
): Record<string, string> | undefined {
  const next: Record<string, string> = {
    latitude: point?.latitude ?? '',
    longitude: point?.longitude ?? '',
    ...(point?.accuracyMeters === undefined ? {} : { accuracyMeters: point.accuracyMeters }),
    [part]: normaliseDigits(typed).trim(),
  };
  if (next.accuracyMeters === '') {
    delete next.accuracyMeters;
  }
  return next.latitude === '' && next.longitude === '' ? undefined : next;
}
