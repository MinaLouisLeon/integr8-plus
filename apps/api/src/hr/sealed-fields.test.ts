import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hrKeyId,
  hrKeyring,
  lastFour,
  openField,
  openWithKeyring,
  sealField,
} from './sealed-fields.js';

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

describe('changing the HR key', () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const ring = hrKeyring(newKey.toString('base64'), [oldKey.toString('base64')]);

  it('opens what an older key sealed, and says it was not the current one', () => {
    const before = sealField('29001011234567', oldKey, context);
    expect(openWithKeyring(before, ring, context)).toEqual({
      plaintext: '29001011234567',
      keyId: hrKeyId(oldKey),
      current: false,
    });

    const after = sealField('29001011234567', ring.current.key, context);
    expect(openWithKeyring(after, ring, context)).toMatchObject({ current: true });
    // The stored shape does not change, so a rollback still reads it.
    expect(after).toMatch(/^hr1\.[\w-]+\.[\w-]+$/u);
  });

  it('refuses a value no configured key sealed', () => {
    const lost = sealField('29001011234567', randomBytes(32), context);
    expect(() => openWithKeyring(lost, ring, context)).toThrow(/No configured HR key/u);
    expect(() =>
      openWithKeyring(
        sealField('x', oldKey, context),
        hrKeyring(newKey.toString('base64')),
        context,
      ),
    ).toThrow();
  });

  it('names a key by a fingerprint that is stable and reveals nothing', () => {
    expect(hrKeyId(newKey)).toBe(hrKeyId(Buffer.from(newKey)));
    expect(hrKeyId(newKey)).toHaveLength(12);
    expect(hrKeyId(newKey)).not.toBe(hrKeyId(oldKey));
    expect(ring.current.id).toBe(hrKeyId(newKey));
    // The current key listed again among the old ones is dropped.
    expect(hrKeyring(newKey.toString('base64'), [newKey.toString('base64')]).previous).toEqual([]);
  });
});
