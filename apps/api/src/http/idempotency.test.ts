import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  fingerprintKeyFrom,
  fingerprintRequest,
  legacyFingerprint,
  withoutSecrets,
} from './idempotency.js';

const KEY = fingerprintKeyFrom('a-test-platform-secret');
const fingerprint = (method: string, path: string, body: unknown): string =>
  fingerprintRequest(KEY, method, path, body);

describe('request fingerprints', () => {
  it('is stable for the same request', () => {
    const a = fingerprint('POST', '/v1/members/invitations', { email: 'a@b.example' });
    const b = fingerprint('POST', '/v1/members/invitations', { email: 'a@b.example' });

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('ignores the order of object keys', () => {
    // A client that rebuilt its payload between retries would otherwise look
    // like it had changed the request, and be told it reused the key.
    const a = fingerprint('POST', '/v1/x', { email: 'a@b.example', role: 'engineer' });
    const b = fingerprint('POST', '/v1/x', { role: 'engineer', email: 'a@b.example' });

    expect(a).toBe(b);
  });

  it('ignores key order at any depth', () => {
    const a = fingerprint('POST', '/v1/x', { outer: { one: 1, two: 2 }, last: true });
    const b = fingerprint('POST', '/v1/x', { last: true, outer: { two: 2, one: 1 } });

    expect(a).toBe(b);
  });

  it('does not ignore the order of an array', () => {
    // Arrays are ordered data. `[a, b]` and `[b, a]` are different requests.
    const a = fingerprint('POST', '/v1/x', { items: [1, 2] });
    const b = fingerprint('POST', '/v1/x', { items: [2, 1] });

    expect(a).not.toBe(b);
  });

  it('changes when the body changes', () => {
    const a = fingerprint('POST', '/v1/x', { email: 'a@b.example' });
    const b = fingerprint('POST', '/v1/x', { email: 'c@d.example' });

    expect(a).not.toBe(b);
  });

  it('changes when the path changes', () => {
    const a = fingerprint('POST', '/v1/members/invitations', {});
    const b = fingerprint('POST', '/v1/members/removals', {});

    expect(a).not.toBe(b);
  });

  it('changes when the method changes', () => {
    expect(fingerprint('POST', '/v1/x', {})).not.toBe(fingerprint('DELETE', '/v1/x', {}));
  });

  it('treats the method case-insensitively', () => {
    expect(fingerprint('post', '/v1/x', {})).toBe(fingerprint('POST', '/v1/x', {}));
  });

  it('distinguishes a missing field from an explicit null', () => {
    // These mean different things to a handler, so they are different requests.
    expect(fingerprint('POST', '/v1/x', {})).not.toBe(fingerprint('POST', '/v1/x', { role: null }));
  });

  it('treats an explicitly undefined field as absent', () => {
    // `JSON.stringify` drops it on the wire, so the server never sees the
    // difference and the fingerprint should not invent one.
    expect(fingerprint('POST', '/v1/x', { role: undefined, email: 'a@b.example' })).toBe(
      fingerprint('POST', '/v1/x', { email: 'a@b.example' }),
    );
  });

  it('handles a body that is not an object', () => {
    expect(() => fingerprint('POST', '/v1/x', null)).not.toThrow();
    expect(() => fingerprint('POST', '/v1/x', 'text')).not.toThrow();
    expect(fingerprint('POST', '/v1/x', null)).not.toBe(fingerprint('POST', '/v1/x', {}));
  });

  it('is keyed: another server secret gives another fingerprint', () => {
    const other = fingerprintKeyFrom('another-platform-secret');
    expect(fingerprintRequest(other, 'POST', '/v1/x', { a: 1 })).not.toBe(
      fingerprint('POST', '/v1/x', { a: 1 }),
    );
    // And it is not the plain hash a reader of the table could recompute.
    expect(fingerprint('POST', '/v1/x', { a: 1 })).not.toBe(
      createHash('sha256').update('POST\n/v1/x\n{"a":1}', 'utf8').digest('hex'),
    );
  });

  it('leaves passwords out, so none can be guessed from a stored fingerprint', () => {
    const first = fingerprint('POST', '/v1/me/password', {
      currentPassword: 'old-secret',
      newPassword: 'first-choice',
      locale: 'en',
    });
    const second = fingerprint('POST', '/v1/me/password', {
      currentPassword: 'old-secret',
      newPassword: 'second-choice',
      locale: 'en',
    });
    expect(first).toBe(second);
    expect(first).toBe(fingerprint('POST', '/v1/me/password', { locale: 'en' }));
    // What is not a secret still counts.
    expect(first).not.toBe(fingerprint('POST', '/v1/me/password', { locale: 'ar' }));
  });

  it('strips secret fields at any depth, and codes only on sign-in paths', () => {
    expect(
      withoutSecrets('/v1/eta/settings/credentials', {
        clientId: 'id',
        clientSecret: 's',
        nested: [{ password: 'p', refreshToken: 't', keep: 1 }],
      }),
    ).toEqual({ clientId: 'id', nested: [{ keep: 1 }] });
    expect(withoutSecrets('/v1/me/anything', { code: '123456', other: 1 })).toEqual({ other: 1 });
    // An item's code elsewhere is data, not a secret.
    expect(withoutSecrets('/v1/inventory/items', { code: 'SKU-1' })).toEqual({ code: 'SKU-1' });
  });

  it('can still recognise a fingerprint the previous release stored', () => {
    expect(legacyFingerprint('POST', '/v1/x', { b: 2, a: 1 })).toBe(
      createHash('sha256').update('POST\n/v1/x\n{"a":1,"b":2}', 'utf8').digest('hex'),
    );
  });
});
