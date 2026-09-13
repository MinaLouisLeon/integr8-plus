import { describe, expect, it } from 'vitest';
import { fingerprintRequest } from './idempotency.js';

describe('request fingerprints', () => {
  it('is stable for the same request', () => {
    const a = fingerprintRequest('POST', '/v1/members/invitations', { email: 'a@b.example' });
    const b = fingerprintRequest('POST', '/v1/members/invitations', { email: 'a@b.example' });

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('ignores the order of object keys', () => {
    // A client that rebuilt its payload between retries would otherwise look
    // like it had changed the request, and be told it reused the key.
    const a = fingerprintRequest('POST', '/v1/x', { email: 'a@b.example', role: 'engineer' });
    const b = fingerprintRequest('POST', '/v1/x', { role: 'engineer', email: 'a@b.example' });

    expect(a).toBe(b);
  });

  it('ignores key order at any depth', () => {
    const a = fingerprintRequest('POST', '/v1/x', { outer: { one: 1, two: 2 }, last: true });
    const b = fingerprintRequest('POST', '/v1/x', { last: true, outer: { two: 2, one: 1 } });

    expect(a).toBe(b);
  });

  it('does not ignore the order of an array', () => {
    // Arrays are ordered data. `[a, b]` and `[b, a]` are different requests.
    const a = fingerprintRequest('POST', '/v1/x', { items: [1, 2] });
    const b = fingerprintRequest('POST', '/v1/x', { items: [2, 1] });

    expect(a).not.toBe(b);
  });

  it('changes when the body changes', () => {
    const a = fingerprintRequest('POST', '/v1/x', { email: 'a@b.example' });
    const b = fingerprintRequest('POST', '/v1/x', { email: 'c@d.example' });

    expect(a).not.toBe(b);
  });

  it('changes when the path changes', () => {
    const a = fingerprintRequest('POST', '/v1/members/invitations', {});
    const b = fingerprintRequest('POST', '/v1/members/removals', {});

    expect(a).not.toBe(b);
  });

  it('changes when the method changes', () => {
    expect(fingerprintRequest('POST', '/v1/x', {})).not.toBe(
      fingerprintRequest('DELETE', '/v1/x', {}),
    );
  });

  it('treats the method case-insensitively', () => {
    expect(fingerprintRequest('post', '/v1/x', {})).toBe(fingerprintRequest('POST', '/v1/x', {}));
  });

  it('distinguishes a missing field from an explicit null', () => {
    // These mean different things to a handler, so they are different requests.
    expect(fingerprintRequest('POST', '/v1/x', {})).not.toBe(
      fingerprintRequest('POST', '/v1/x', { role: null }),
    );
  });

  it('treats an explicitly undefined field as absent', () => {
    // `JSON.stringify` drops it on the wire, so the server never sees the
    // difference and the fingerprint should not invent one.
    expect(fingerprintRequest('POST', '/v1/x', { role: undefined, email: 'a@b.example' })).toBe(
      fingerprintRequest('POST', '/v1/x', { email: 'a@b.example' }),
    );
  });

  it('handles a body that is not an object', () => {
    expect(() => fingerprintRequest('POST', '/v1/x', null)).not.toThrow();
    expect(() => fingerprintRequest('POST', '/v1/x', 'text')).not.toThrow();
    expect(fingerprintRequest('POST', '/v1/x', null)).not.toBe(
      fingerprintRequest('POST', '/v1/x', {}),
    );
  });
});
