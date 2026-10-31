import { describe, expect, it } from 'vitest';

import { forwardedClientHeaders } from './api';

function request(headers: Record<string, string>): Request {
  return new Request('https://app.example/api/auth/sign-in', { method: 'POST', headers });
}

describe('forwardedClientHeaders', () => {
  it('passes on the visitor address Caddy set, and the browser', () => {
    expect(
      forwardedClientHeaders(
        request({
          'x-forwarded-for': '203.0.113.7',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0)',
        }),
      ),
    ).toEqual({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' });
  });

  it('keeps only the first address when something appended its own', () => {
    expect(
      forwardedClientHeaders(request({ 'x-forwarded-for': '203.0.113.7, 172.18.0.5' })),
    ).toEqual({ 'x-forwarded-for': '203.0.113.7' });
  });

  it('adds nothing it was not given', () => {
    expect(forwardedClientHeaders(request({}))).toEqual({});
  });
});
