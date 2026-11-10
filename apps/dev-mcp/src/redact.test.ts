import { describe, expect, it } from 'vitest';
import { HIDDEN, isAuthPath, redact, redactHeaders } from './redact.js';

const JWT =
  'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwic2lkIjoiYWJjIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU';

describe('hiding secrets', () => {
  it('hides tokens, passwords and the tokens object wherever they are', () => {
    expect(
      redact({
        email: 'dev@example.com',
        password: 'correct horse',
        refreshToken: 'i8p1.abcdefghijklmnopqrstuvwxyz',
        tokens: { accessToken: JWT, refreshToken: 'x' },
        nested: [{ accessToken: JWT, name: 'kept' }],
      }),
    ).toEqual({
      email: 'dev@example.com',
      password: HIDDEN,
      refreshToken: HIDDEN,
      tokens: HIDDEN,
      nested: [{ accessToken: HIDDEN, name: 'kept' }],
    });
  });

  it('hides a token inside any string, and signed links', () => {
    expect(redact(`Bearer ${JWT}`)).toBe(`Bearer ${HIDDEN}`);
    expect(redact('accept: https://app.example.com/invite?token=i8i1.abcdefghijklmnopqrstuv')).toBe(
      `accept: ${HIDDEN}`,
    );
    expect(
      redact({
        url: 'https://bucket.r2.example/file.pdf?X-Amz-Algorithm=AWS4&X-Amz-Signature=deadbeef',
      }),
    ).toEqual({ url: HIDDEN });
  });

  it('hides a sign-in code on sign-in routes, and keeps error codes elsewhere', () => {
    expect(redact({ code: '123456', email: 'a@b.c' }, { authPath: true })).toEqual({
      code: HIDDEN,
      email: 'a@b.c',
    });
    expect(redact({ error: { code: 'session_scope' } })).toEqual({
      error: { code: 'session_scope' },
    });
    expect(isAuthPath('/v1/platform/auth/sign-in')).toBe(true);
    expect(isAuthPath('/v1/customers')).toBe(false);
  });

  it('hides Authorization and cookie headers', () => {
    expect(
      redactHeaders({ authorization: `Bearer ${JWT}`, cookie: 'a=b', 'x-client-app': 'api' }),
    ).toEqual({ authorization: HIDDEN, cookie: HIDDEN, 'x-client-app': 'api' });
  });
});
