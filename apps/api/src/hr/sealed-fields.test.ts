import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lastFour, openField, sealField } from './sealed-fields.js';

const key = randomBytes(32);
const context = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  employeeId: '00000000-0000-4000-8000-000000000002',
  field: 'nationalId' as const,
};

describe('sealed HR fields', () => {
  it('opens what it sealed, and never repeats a ciphertext', () => {
    const first = sealField('29001011234567', key, context);
    const second = sealField('29001011234567', key, context);
    expect(first).toMatch(/^hr1\.[\w-]+\.[\w-]+$/u);
    expect(first).not.toBe(second);
    expect(openField(first, key, context)).toBe('29001011234567');
  });

  it('refuses another key, another employee, another field and another company', () => {
    const sealed = sealField('EG380019000500000000263180002', key, context);
    expect(() => openField(sealed, randomBytes(32), context)).toThrow();
    expect(() =>
      openField(sealed, key, { ...context, employeeId: '00000000-0000-4000-8000-000000000003' }),
    ).toThrow();
    expect(() => openField(sealed, key, { ...context, field: 'bankAccount' })).toThrow();
    expect(() =>
      openField(sealed, key, { ...context, tenantId: '00000000-0000-4000-8000-000000000009' }),
    ).toThrow();
  });

  it('keeps the last four, without spaces or dashes', () => {
    expect(lastFour('EG38 0019 0005 0000 0000 2631 8000 2')).toBe('0002');
    expect(lastFour('123')).toBe('123');
  });
});
