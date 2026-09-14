import { describe, expect, it } from 'vitest';
import { formatBytes, normaliseDigits, say, withLocalOffset } from './text.js';

describe('text helpers', () => {
  it('shows the language asked for, then English, then anything', () => {
    expect(say({ en: 'Result', ar: 'النتيجة' }, 'ar')).toBe('النتيجة');
    expect(say({ en: 'Result' }, 'ar')).toBe('Result');
    expect(say({ fr: 'Résultat' }, 'ar')).toBe('Résultat');
    expect(say(undefined, 'en')).toBe('');
  });

  it('turns Arabic and Persian digits into the ones the engine stores', () => {
    expect(normaliseDigits('٣٫٥')).toBe('3.5');
    expect(normaliseDigits('۱۲۰')).toBe('120');
    expect(normaliseDigits('−4')).toBe('-4');
    expect(normaliseDigits('12.50')).toBe('12.50');
  });

  it('gives a local date-time the offset the engine requires', () => {
    expect(withLocalOffset('2026-09-13T14:05')).toMatch(/^2026-09-13T14:05:00[+-]\d{2}:\d{2}$/u);
  });

  it('writes sizes a person can read', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(120_000, 'en')).toBe('117.2 KB');
    expect(formatBytes(5 * 1024 * 1024, 'en')).toBe('5 MB');
  });
});
