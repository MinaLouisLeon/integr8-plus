import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { credentialHint, etaKey, openCredential, sealCredential } from './credentials.js';

const key = etaKey(randomBytes(32).toString('base64'));
const tenant = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

describe('ETA credential sealing', () => {
  it('opens what it sealed, for the same company and field', () => {
    const sealed = sealCredential('client-secret-value', key, tenant, 'clientSecret');
    expect(sealed.startsWith('eta1.')).toBe(true);
    expect(sealed).not.toContain('client-secret-value');
    expect(openCredential(sealed, key, tenant, 'clientSecret')).toBe('client-secret-value');
  });

  it('uses a fresh nonce every time', () => {
    expect(sealCredential('x', key, tenant, 'clientId')).not.toBe(
      sealCredential('x', key, tenant, 'clientId'),
    );
  });

  it('refuses another company, another field, another key and a tampered value', () => {
    const sealed = sealCredential('id-1234', key, tenant, 'clientId');
    expect(() => openCredential(sealed, key, other, 'clientId')).toThrow();
    expect(() => openCredential(sealed, key, tenant, 'clientSecret')).toThrow();
    const otherKey = etaKey(randomBytes(32).toString('base64'));
    expect(() => openCredential(sealed, otherKey, tenant, 'clientId')).toThrow();
    const [prefix, nonce, payload] = sealed.split('.');
    // One bit of the ciphertext flipped, so the tag no longer matches. Editing
    // a base64 character instead failed about one run in 64: the character
    // swapped in was sometimes the one already there.
    const bytes = Buffer.from(payload!, 'base64url');
    bytes[0] = bytes[0]! ^ 0x01;
    const flipped = bytes.toString('base64url');
    expect(() =>
      openCredential(`${prefix!}.${nonce!}.${flipped}`, key, tenant, 'clientId'),
    ).toThrow();
    expect(() => openCredential('hr1.a.b', key, tenant, 'clientId')).toThrow();
  });

  it('refuses a key of the wrong length', () => {
    expect(() => etaKey(randomBytes(16).toString('base64'))).toThrow();
  });

  it('hints with the last four characters only', () => {
    expect(credentialHint('  abcdef123456 ')).toBe('3456');
  });
});
