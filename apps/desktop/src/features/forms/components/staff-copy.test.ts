import { describe, expect, it } from 'vitest';
import { suggestKey } from './staff-copy';

/** The library key the Save to library dialog suggests from a form's name. */
describe('suggestKey', () => {
  it('makes a key the library accepts from an English name', () => {
    expect(suggestKey('Gas Safety Certificate (2026)')).toBe('gas_safety_certificate_2026');
    expect(suggestKey('  Boiler   service ')).toBe('boiler_service');
  });

  it('starts with a letter and falls back when nothing usable is left', () => {
    expect(suggestKey('2026 inspection')).toBe('inspection');
    expect(suggestKey('شهادة السلامة')).toBe('form_template');
    expect(suggestKey('x'.repeat(100))).toHaveLength(64);
  });
});
