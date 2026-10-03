import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatWhen,
  isValidSlug,
  pickMessage,
  suggestSlug,
} from './platform-format';

describe('formatBytes', () => {
  it('uses powers of 1000, because that is what storage is billed in', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1.0 kB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(formatBytes(9_900_000_000)).toBe('9.9 GB');
    expect(formatBytes(812_000_000_000)).toBe('812 GB');
  });

  it('answers a dash rather than NaN for nonsense', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('uses the coarsest unit that is still true', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(150)).toBe('2m 30s');
    expect(formatDuration(7_500)).toBe('2h 5m');
  });

  it('is undefined while something is still running', () => {
    expect(formatDuration(null)).toBeUndefined();
  });
});

describe('formatWhen', () => {
  it('never renders an empty cell, because an empty cell reads as a bug', () => {
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen('not a date')).toBe('—');
    expect(formatWhen('')).toBe('—');
  });
});

describe('suggestSlug', () => {
  it('makes something the API will accept out of a company name', () => {
    expect(suggestSlug('Northwind Facilities Ltd')).toBe('northwind-facilities-ltd');
    expect(suggestSlug('  Smith & Sons  ')).toBe('smith-sons');
    expect(suggestSlug('Ålesund Rør AS')).toBe('alesund-ror-as');
  });

  it('never ends in a hyphen, even after being cut to length', () => {
    const long = suggestSlug(`${'a'.repeat(62)} bcdef`);
    expect(long.endsWith('-')).toBe(false);
    expect(isValidSlug(long)).toBe(true);
  });
});

describe('isValidSlug', () => {
  it('matches what the API accepts, so the form can say so first', () => {
    expect(isValidSlug('northwind')).toBe(true);
    expect(isValidSlug('north-wind-2')).toBe(true);
    expect(isValidSlug('a')).toBe(false);
    expect(isValidSlug('-northwind')).toBe(false);
    expect(isValidSlug('northwind-')).toBe(false);
    expect(isValidSlug('North')).toBe(false);
  });
});

describe('pickMessage', () => {
  const message = { en: 'Maintenance at 22:00', 'pt-BR': 'Manutenção às 22:00' };

  it('prefers the exact tag, then the language, then English', () => {
    expect(pickMessage(message, 'pt-BR')).toBe('Manutenção às 22:00');
    expect(pickMessage(message, 'en-GB')).toBe('Maintenance at 22:00');
    expect(pickMessage(message, 'fr')).toBe('Maintenance at 22:00');
  });

  it('shows whatever is there rather than nothing', () => {
    // Usually the message saying the system is about to go down.
    expect(pickMessage({ ar: 'صيانة' }, 'en')).toBe('صيانة');
    expect(pickMessage({}, 'en')).toBe('');
  });
});
