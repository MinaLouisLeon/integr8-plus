import { ApiRequestError } from '@integr8/api-client';
import type { TFunction } from '@integr8/i18n';

/**
 * Maps an API failure to a message this app has written.
 *
 * The server's own message is deliberately never shown. It is written for a
 * developer reading a log, it is not translated, and for a failed sign-in it is
 * the same sentence whatever actually went wrong — correct for the server, and
 * useless for a person looking at a form.
 *
 * The `code` is the contract; the words are ours.
 */
export function messageForError(failure: unknown, t: TFunction): string {
  if (!(failure instanceof ApiRequestError)) {
    return t('errors.unexpected');
  }

  switch (failure.code) {
    case 'auth.invalid_credentials':
      return t('auth.invalidCredentials');
    case 'auth.account_locked':
      return t('auth.accountLocked');
    case 'auth.rate_limited':
    case 'rate_limited':
      return t('auth.rateLimited');
    case 'client_too_old':
      return t('errors.clientTooOld');
    case 'forbidden':
      return t('errors.forbidden');
    case 'not_found':
      return t('errors.notFound');
    default:
      return t('errors.unexpected');
  }
}
