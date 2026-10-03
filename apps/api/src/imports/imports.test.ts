import { describe, expect, it } from 'vitest';
import { CsvSyntaxError, csvLine, normaliseHeader, parseCsv } from './csv.js';
import { IMPORT_COLUMNS, importTemplate } from './definitions.js';
import { isKnownTimeZone, parseZonedDateTime } from './zoned-time.js';

describe('reading CSV as spreadsheets write it', () => {
  it('handles quotes, doubled quotes, commas and line breaks inside fields, CRLF and a byte-order mark', () => {
    const text = `${String.fromCharCode(0xfeff)}name,notes\r\n"Smith, J","Said ""hello""\r\nthen left"\r\nPlain,\r\n`;
    expect(parseCsv(text)).toEqual([
      { row: 1, cells: ['name', 'notes'] },
      { row: 2, cells: ['Smith, J', 'Said "hello"\r\nthen left'] },
      // The record above spans two lines, so this one starts on row 4.
      { row: 4, cells: ['Plain', ''] },
    ]);
  });

  it('skips blank lines but keeps counting them, and accepts LF and a missing final newline', () => {
    expect(parseCsv('a\n\nb\nc')).toEqual([
      { row: 1, cells: ['a'] },
      { row: 3, cells: ['b'] },
      { row: 4, cells: ['c'] },
    ]);
  });

  it('names the row of a quote that never closes, or one in the middle of a field', () => {
    expect(() => parseCsv('a\n"open')).toThrow(CsvSyntaxError);
    try {
      parseCsv('a\nb\n"open\nmore');
    } catch (error) {
      expect((error as CsvSyntaxError).row).toBe(3);
    }
    expect(() => parseCsv('ab"c')).toThrow(/middle of an unquoted field/u);
  });

  it('matches headers however they are written, and round-trips a template', () => {
    expect(normaliseHeader(' Account Number ')).toBe('account_number');
    expect(normaliseHeader('site-name')).toBe('site_name');
    expect(csvLine(['a,b', 'say "x"', 'plain'])).toBe('"a,b","say ""x""",plain');
    for (const kind of ['customers', 'sites', 'work_orders'] as const) {
      const [header] = parseCsv(importTemplate(kind));
      expect(header?.cells).toEqual(IMPORT_COLUMNS[kind].map((column) => column.name));
    }
  });
});

describe('dates in the importer’s time zone', () => {
  it('reads a wall-clock time in the zone, across a daylight-saving change', () => {
    expect(parseZonedDateTime('2026-10-01 09:00', 'Europe/London')?.toISOString()).toBe(
      '2026-10-01T08:00:00.000Z',
    );
    expect(parseZonedDateTime('2026-12-01T09:00', 'Europe/London')?.toISOString()).toBe(
      '2026-12-01T09:00:00.000Z',
    );
    expect(parseZonedDateTime('2026-10-01 09:00', 'Asia/Dubai')?.toISOString()).toBe(
      '2026-10-01T05:00:00.000Z',
    );
    // British Summer Time ends at 02:00 on Sunday 25 October 2026; 00:30 that morning is still BST.
    expect(parseZonedDateTime('2026-10-25 00:30', 'Europe/London')?.toISOString()).toBe(
      '2026-10-24T23:30:00.000Z',
    );
  });

  it('keeps an explicit offset, and ends a bare date at the end of the day when asked', () => {
    expect(parseZonedDateTime('2026-10-01T09:00:00+02:00', 'Europe/London')?.toISOString()).toBe(
      '2026-10-01T07:00:00.000Z',
    );
    expect(parseZonedDateTime('2026-10-01', 'UTC', { endOfDay: true })?.toISOString()).toBe(
      '2026-10-01T23:59:59.000Z',
    );
    expect(parseZonedDateTime('2026-10-01', 'UTC')?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('refuses dates that do not exist and text that is not a date', () => {
    for (const text of ['2026-02-30', '2026-13-01', '01/10/2026', 'tomorrow', '2026-10-01 25:00']) {
      expect(parseZonedDateTime(text, 'UTC'), text).toBeUndefined();
    }
    expect(isKnownTimeZone('Europe/London')).toBe(true);
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false);
  });
});
