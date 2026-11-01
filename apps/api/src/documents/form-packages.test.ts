import { describe, expect, it } from 'vitest';
import { importTitle } from '../routes/v1/form-package.js';
import { keyFromTitle } from '../routes/v1/platform/template-packages.js';
import { packageFilename } from './form-packages.js';

/** Names an exported or imported `.integr8form` file gives things (decision 14, 1.3.0). */
describe('packageFilename', () => {
  it('keeps the title, Arabic included, without what a file name cannot hold', () => {
    expect(packageFilename('Gas safety certificate')).toBe('Gas safety certificate.integr8form');
    expect(packageFilename('شهادة سلامة الغاز')).toBe('شهادة سلامة الغاز.integr8form');
    expect(packageFilename('Check: A/B "test" <1>?.')).toBe('Check AB test 1.integr8form');
    expect(packageFilename('  \u0000 ')).toBe('form.integr8form');
    expect(packageFilename('x'.repeat(300))).toHaveLength(100 + '.integr8form'.length);
  });
});

describe('importTitle', () => {
  it('uses the English title, or the Arabic when there is no English', () => {
    expect(importTitle({ en: 'Boiler service', ar: 'صيانة' }, [])).toBe('Boiler service');
    expect(importTitle({ ar: 'صيانة الغلاية' }, [])).toBe('صيانة الغلاية');
  });

  it('marks an import whose name is taken, in the title’s language', () => {
    expect(importTitle({ en: 'Boiler service' }, ['boiler service '])).toBe(
      'Boiler service (imported)',
    );
    expect(
      importTitle({ en: 'Boiler service' }, ['Boiler service', 'Boiler service (imported)']),
    ).toBe('Boiler service (imported 2)');
    expect(importTitle({ ar: 'صيانة' }, ['صيانة'])).toBe('صيانة (مستورد)');
  });
});

describe('keyFromTitle', () => {
  it('makes a library key from the English title', () => {
    expect(keyFromTitle({ en: 'Gas Safety Certificate (2026)' })).toBe(
      'gas_safety_certificate_2026',
    );
    expect(keyFromTitle({ ar: 'شهادة' })).toBe('form_template');
    expect(keyFromTitle({ en: 'x'.repeat(100) }).length).toBeLessThanOrEqual(56);
  });
});
