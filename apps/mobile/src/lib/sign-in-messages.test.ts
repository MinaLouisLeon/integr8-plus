import { ApiRequestError } from '@integr8/api-client';
import { createI18n } from '@integr8/i18n';
import { describe, expect, it } from 'vitest';
import { codeRequestFailureMessage, signInFailureMessage } from './sign-in-messages';

const english = createI18n({ locale: 'en' }).t;
const arabic = createI18n({ locale: 'ar' }).t;

const refusal = (status: number, code: string) => new ApiRequestError(status, code, 'x', 'req');

describe('sign-in failures (P36)', () => {
  it('says one thing for every refused code, so no address is confirmed', () => {
    const options = { companyName: 'Northwind', withCode: true };
    const wrong = signInFailureMessage(refusal(401, 'auth.invalid_credentials'), english, options);
    const other = signInFailureMessage(refusal(403, 'auth.not_a_member'), english, options);
    expect(wrong).toBe(english('auth.code.failed'));
    expect(other).toBe(wrong);
  });

  it('keeps a locked account and another company’s account distinct', () => {
    const options = { companyName: 'Northwind', withCode: true };
    expect(signInFailureMessage(refusal(423, 'auth.account_locked'), english, options)).toBe(
      english('auth.accountLocked'),
    );
    expect(signInFailureMessage(refusal(403, 'wrong_company'), english, options)).toContain(
      'Northwind',
    );
  });

  it('keeps the password wording for a password sign-in', () => {
    expect(
      signInFailureMessage(refusal(401, 'auth.invalid_credentials'), arabic, { companyName: '' }),
    ).toBe(arabic('auth.invalidCredentials'));
  });

  it('asks to wait when too many codes were asked for, and nothing more', () => {
    expect(codeRequestFailureMessage(refusal(429, 'auth.rate_limited'), english)).toBe(
      english('auth.code.wait'),
    );
    expect(codeRequestFailureMessage(new Error('offline'), english)).toBe(
      english('errors.unexpected'),
    );
  });
});
