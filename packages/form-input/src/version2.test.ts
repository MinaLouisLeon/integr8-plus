import type { Field } from '@integr8/form-engine';
import { describe, expect, it } from 'vitest';
import { calculatedText, informationText, localNow, needsNewerApp } from './version2.js';

describe('schema version 2 in a filler', () => {
  it('knows a form written for a newer app from one it reads', () => {
    expect(needsNewerApp({ schemaVersion: 1 })).toBe(false);
    expect(needsNewerApp({ schemaVersion: 2 })).toBe(false);
    expect(needsNewerApp({ schemaVersion: 3 })).toBe(true);
    expect(needsNewerApp({ schemaVersion: '3' })).toBe(false);
    expect(needsNewerApp(null)).toBe(false);
    expect(needsNewerApp([])).toBe(false);
  });

  it('reads the clock as a date and time with this device’s offset', () => {
    expect(localNow(new Date(2026, 8, 13, 14, 5, 9))).toMatch(
      /^2026-09-13T14:05:09[+-][0-9]{2}:[0-9]{2}$/u,
    );
  });

  it('writes a calculated date the way the language writes dates', () => {
    const due: Field = { id: 'due', type: 'date', label: { en: 'Due' } };
    expect(calculatedText(due, '2026-02-28', 'en')).toBe('Feb 28, 2026');
    expect(calculatedText(due, 'nonsense', 'en')).toBe('nonsense');
    expect(calculatedText(due, undefined, 'en')).toBe('');
    const total: Field = { id: 'total', type: 'decimal', label: { en: 'Total' }, decimalPlaces: 2 };
    expect(calculatedText(total, '12.50', 'en')).toBe('12.50');
    expect(calculatedText({ id: 'n', type: 'number', label: { en: 'N' } }, 4, 'en')).toBe('4');
  });

  it('splits an Information paragraph at its line breaks and keeps it plain', () => {
    expect(
      informationText(
        {
          id: 'note',
          type: 'information',
          heading: { en: ' ', ar: 'تنبيه' },
          body: { en: 'One\r\n<b>Two</b>', ar: 'واحد\nاثنان' },
        },
        'en',
      ),
    ).toEqual({ heading: undefined, lines: ['One', '<b>Two</b>'], style: 'plain' });
    expect(
      informationText(
        {
          id: 'note',
          type: 'information',
          heading: { en: 'Careful', ar: 'تنبيه' },
          body: { en: 'One', ar: 'واحد\nاثنان' },
          style: 'warning',
        },
        'ar',
      ),
    ).toEqual({ heading: 'تنبيه', lines: ['واحد', 'اثنان'], style: 'warning' });
  });
});
