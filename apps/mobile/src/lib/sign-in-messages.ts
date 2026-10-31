import { ApiRequestError } from '@integr8/api-client';
import type { TFunction } from '@integr8/i18n';

/**
 * What the sign-in screen says when signing in fails, by the API's code.
 *
 * The server's message is written for a log; this is the one a person reads.
 * Signing in with a password and with an emailed code share the cases that
 * mean the same thing — a locked account, another company's account, an app
 * too old — and differ in one: any other refusal of a code is "that code did
 * not work", whatever the reason, so the screen never says whether an address
 * has an account (P36).
 */
export function signInFailureMessage(
  failure: unknown,
  t: TFunction,
  options: { companyName: string; withCode?: boolean },
): string {
  if (!(failure instanceof ApiRequestError)) {
    return t('errors.unexpected');
  }

  switch (failure.code) {
    case 'auth.account_locked':
      return t('auth.accountLocked');
    case 'wrong_company':
      return t('auth.wrongCompany', { company: options.companyName });
    case 'client_too_old':
      return t('errors.clientTooOld');
    case 'auth.rate_limited':
    case 'rate_limited':
      return options.withCode === true ? t('auth.code.wait') : t('auth.rateLimited');
    case 'auth.invalid_credentials':
      return options.withCode === true ? t('auth.code.failed') : t('auth.invalidCredentials');
    default:
      return options.withCode === true ? t('auth.code.failed') : t('errors.unexpected');
  }
}

/** What asking for a code says when it is refused: only "wait" is worth saying. */
export function codeRequestFailureMessage(failure: unknown, t: TFunction): string {
  if (failure instanceof ApiRequestError && failure.status === 429) {
    return t('auth.code.wait');
  }
  if (failure instanceof ApiRequestError && failure.code === 'client_too_old') {
    return t('errors.clientTooOld');
  }
  return t('errors.unexpected');
}
