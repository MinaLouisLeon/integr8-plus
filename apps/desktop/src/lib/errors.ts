import { ApiRequestError } from '@integr8/api-client';
import { apiErrorMessage, type TFunction } from '@integr8/i18n';

/**
 * Maps an API failure to a message this app has written.
 *
 * The server's own message is deliberately never shown. It is written for a
 * developer reading a log, it is not translated, and for a failed sign-in it is
 * the same sentence whatever actually went wrong — correct for the server, and
 * useless for a person looking at a form.
 *
 * The `code` is the contract; the words are the catalogue's (ADR-0012): every
 * code the API can return has a message in English and Arabic, and a code
 * this build does not know yet gets the generic words for its status.
 */
export function messageForError(failure: unknown, t: TFunction): string {
  if (!(failure instanceof ApiRequestError)) {
    return t('errors.unexpected');
  }
  return apiErrorMessage(failure, t);
}
