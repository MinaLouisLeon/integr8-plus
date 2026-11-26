import { describe, expect, it } from 'vitest';
import { createLimiter, visitorAddress } from './request-limit';

describe('the update routes’ limiter', () => {
  it('lets the limit through, refuses the next and then everything until the window ends', () => {
    const limiter = createLimiter(60_000);
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.hit('miss:a', 3, 1_000)).toBeNull();
    }
    expect(limiter.blockedFor('miss:a', 1_000)).toBeNull();
    expect(limiter.hit('miss:a', 3, 2_000)).toBe(59);
    // Once over, even a lookup that would find something is refused, so the
    // refusal cannot tell names apart.
    expect(limiter.blockedFor('miss:a', 30_000)).toBe(31);
    expect(limiter.blockedFor('miss:a', 61_000)).toBeNull();
    expect(limiter.hit('miss:a', 3, 61_000)).toBeNull();
  });

  it('keeps addresses and files apart', () => {
    const limiter = createLimiter(60_000);
    expect(limiter.hit('download:a:acme/v1/app.exe', 1, 0)).toBeNull();
    expect(limiter.hit('download:a:acme/v1/app.exe', 1, 0)).not.toBeNull();
    expect(limiter.hit('download:a:acme/v1/app.msi', 1, 0)).toBeNull();
    expect(limiter.hit('download:b:acme/v1/app.exe', 1, 0)).toBeNull();
  });
});

describe('the visitor’s address', () => {
  const request = (headers: Record<string, string>) =>
    new Request('http://localhost:3001/desktop-updates/acme/windows/x86_64/1.0.0', { headers });

  it('is the first address Caddy forwards, or none without a proxy', () => {
    expect(visitorAddress(request({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
    expect(visitorAddress(request({ 'x-forwarded-for': '203.0.113.7, 10.0.0.2' }))).toBe(
      '203.0.113.7',
    );
    expect(visitorAddress(request({}))).toBeNull();
  });
});
