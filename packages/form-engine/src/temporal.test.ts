import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseDate, parseDatetime, parseTime } from './temporal.js';

describe('dates', () => {
  it('counts days from the epoch', () => {
    expect(parseDate('1970-01-01')).toBe(0);
    expect(parseDate('1970-01-02')).toBe(1);
    expect(parseDate('1969-12-31')).toBe(-1);
    expect(parseDate('2000-03-01')).toBe(11_017);
  });

  it('knows which years are leap years, including the century rules', () => {
    expect(parseDate('2024-02-29')).toBeDefined();
    expect(parseDate('2023-02-29')).toBeUndefined();
    expect(parseDate('2000-02-29')).toBeDefined();
    expect(parseDate('1900-02-29')).toBeUndefined();
  });

  it.each([
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-01-00',
    '0000-01-01',
    '26-01-01',
    '2026-1-1',
    '2026/01/01',
    ' 2026-01-01',
    '2026-01-01T00:00',
  ])('refuses %j', (text) => {
    expect(parseDate(text)).toBeUndefined();
  });

  // The test is allowed a Date; the engine is not. This is how the hand-rolled
  // calendar arithmetic is checked against the one every engine agrees on for
  // UTC dates.
  it('agrees with Date.UTC for every date from year 1 to 9999', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date(Date.UTC(1, 0, 1)),
          max: new Date(Date.UTC(9999, 11, 31)),
          noInvalidDate: true,
        }),
        (moment) => {
          const year = String(moment.getUTCFullYear()).padStart(4, '0');
          const month = String(moment.getUTCMonth() + 1).padStart(2, '0');
          const day = String(moment.getUTCDate()).padStart(2, '0');
          const midnight = Date.UTC(
            moment.getUTCFullYear(),
            moment.getUTCMonth(),
            moment.getUTCDate(),
          );
          // Date.UTC maps years 0–99 to 1900–1999; setUTCFullYear does not.
          const exact = new Date(midnight);
          exact.setUTCFullYear(moment.getUTCFullYear());

          expect(parseDate(`${year}-${month}-${day}`)).toBe(
            Math.round(exact.getTime() / 86_400_000),
          );
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe('times', () => {
  it('counts minutes from midnight', () => {
    expect(parseTime('00:00')).toBe(0);
    expect(parseTime('23:59')).toBe(1_439);
    expect(parseTime('09:05')).toBe(545);
  });

  it.each(['24:00', '12:60', '9:05', '09:05:00', '0905', '09.05'])('refuses %j', (text) => {
    expect(parseTime(text)).toBeUndefined();
  });
});

describe('datetimes', () => {
  it('applies the offset, so the same instant compares equal from any zone', () => {
    const cairo = parseDatetime('2026-09-13T14:05:00+03:00');
    const utc = parseDatetime('2026-09-13T11:05:00Z');
    const newYork = parseDatetime('2026-09-13T07:05-04:00');

    expect(cairo).toBe(utc);
    expect(newYork).toBe(utc);
  });

  it('carries seconds when given', () => {
    expect(
      (parseDatetime('1970-01-01T00:00:59Z') ?? 0) - (parseDatetime('1970-01-01T00:00Z') ?? 0),
    ).toBe(59);
  });

  it.each([
    '2026-09-13T14:05:00', // no offset: a different instant on every device
    '2026-09-13 14:05:00Z',
    '2026-02-30T10:00Z',
    '2026-09-13T14:05:00+15:00',
    '2026-09-13T14:05:00.123Z',
    '2026-09-13T25:00Z',
  ])('refuses %j', (text) => {
    expect(parseDatetime(text)).toBeUndefined();
  });

  it('agrees with Date for any instant and any valid offset', () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date('1900-01-01T00:00:00Z'),
          max: new Date('2200-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.integer({ min: -14 * 60, max: 14 * 60 }),
        (moment, offsetMinutes) => {
          const shifted = new Date(
            Math.floor(moment.getTime() / 1_000) * 1_000 + offsetMinutes * 60_000,
          );
          const pad = (value: number, width = 2) => String(value).padStart(width, '0');
          const sign = offsetMinutes < 0 ? '-' : '+';
          const magnitude = Math.abs(offsetMinutes);
          const text =
            `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
            `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
            `${sign}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`;

          expect(parseDatetime(text)).toBe(Math.floor(moment.getTime() / 1_000));
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
