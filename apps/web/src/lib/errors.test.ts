import { ApiRequestError } from '@integr8/api-client';
import { createI18n } from '@integr8/i18n';
import { describe, expect, it } from 'vitest';
import { messageForError } from './errors';

const { t } = createI18n();

function failure(code: string, status = 400): ApiRequestError {
  return new ApiRequestError(status, code, 'A message written for a log', 'req-1');
}

describe('turning an API failure into something a person reads', () => {
  it('never shows the server’s own message', () => {
    // It is written for a developer reading a log, and it is not translated.
    const shown = messageForError(failure('auth.invalid_credentials', 401), t);
    expect(shown).not.toContain('written for a log');
  });

  it('uses the app’s own words for a rejected sign-in', () => {
    expect(messageForError(failure('auth.invalid_credentials', 401), t)).toBe(
      t('auth.invalidCredentials'),
    );
  });

  it('distinguishes a lockout from a wrong password', () => {
    // The person can do something about one and only wait for the other.
    expect(messageForError(failure('auth.account_locked', 423), t)).toBe(t('auth.accountLocked'));
  });

  it('handles both rate-limit codes the stack can produce', () => {
    // The gateway limiter and the sign-in limiter use different codes.
    expect(messageForError(failure('rate_limited', 429), t)).toBe(t('auth.rateLimited'));
    expect(messageForError(failure('auth.rate_limited', 429), t)).toBe(t('auth.rateLimited'));
  });

  it('tells somebody on an old build to update', () => {
    expect(messageForError(failure('client_too_old', 503), t)).toBe(t('errors.clientTooOld'));
  });

  it('falls back for a code it has never seen', () => {
    // The API may add a code inside a version; an old client must still say
    // something sensible rather than rendering `undefined`.
    expect(messageForError(failure('some.future.code'), t)).toBe(t('errors.unexpected'));
  });

  it('falls back for something that is not an API error at all', () => {
    expect(messageForError(new TypeError('boom'), t)).toBe(t('errors.unexpected'));
    expect(messageForError(undefined, t)).toBe(t('errors.unexpected'));
  });
});
