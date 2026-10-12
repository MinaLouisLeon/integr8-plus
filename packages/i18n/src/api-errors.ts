import type { TFunction } from 'i18next';
import { API_ERROR_CODES, type ApiErrorCode } from './api-error-codes.js';

export { API_ERROR_CODES, type ApiErrorCode } from './api-error-codes.js';

/**
 * Refusals in the reader's language (ADR-0012).
 *
 * Every failed API request carries a stable `code`, and the catalogue has a
 * message for each code the API can return (`apiErrors.*`). The server's own
 * `message` is English written for a log, and is never shown: a person reads
 * the catalogue's words for the code, or — for a code this build does not know
 * — the generic words for the HTTP status.
 *
 * Nothing here imports `@integr8/api-client`: a failure is recognised by its
 * shape (`status` and `code`, as `ApiRequestError` has them), so the helper
 * works on the phone's stored sync refusals too.
 */

/** A failure as the API reports it, or as the phone stored it. */
export interface ApiFailureLike {
  readonly status?: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: readonly { readonly field?: string; readonly code: string }[];
}

/**
 * Codes whose message lives under another key, because that key was there
 * first and is used for more than this code — the one sentence stays in one
 * place. Every other code's message is `apiErrors.<code>`.
 */
export const API_ERROR_MESSAGE_KEYS = {
  forbidden: 'errors.forbidden',
  not_found: 'errors.notFound',
  feature_disabled: 'errors.featureDisabled',
  client_too_old: 'errors.clientTooOld',
  rate_limited: 'auth.rateLimited',
  'auth.rate_limited': 'auth.rateLimited',
  'auth.invalid_credentials': 'auth.invalidCredentials',
  'auth.account_locked': 'auth.accountLocked',
  // The same refusal under two names, from two routes.
  customer_unknown: 'apiErrors.customer_not_found',
  unknown_time_zone: 'apiErrors.unknown_timezone',
  page_invalid: 'apiErrors.cursor_invalid',
} as const satisfies Partial<Record<ApiErrorCode, string>>;

const KNOWN: ReadonlySet<string> = new Set(API_ERROR_CODES);

export function isApiErrorCode(code: string): code is ApiErrorCode {
  return KNOWN.has(code);
}

/** The catalogue key holding a code's message. */
export function apiErrorKey(code: ApiErrorCode): string {
  return (API_ERROR_MESSAGE_KEYS as Partial<Record<string, string>>)[code] ?? `apiErrors.${code}`;
}

/** True for anything shaped like an API refusal: a string code, and a number status if any. */
export function isApiFailure(failure: unknown): failure is ApiFailureLike {
  if (typeof failure !== 'object' || failure === null) {
    return false;
  }
  const { code, status } = failure as { code?: unknown; status?: unknown };
  return typeof code === 'string' && (status === undefined || typeof status === 'number');
}

/** A catalogue key for `t`; the keys here are checked by this package's tests. */
type AnyKey = 'errors.unexpected';
const say = (t: TFunction, key: string): string => t(key as AnyKey);

/**
 * The message for a code this build knows, or `undefined`. `overrides` lets a
 * screen keep a richer message of its own for a code (a ledger's "you drafted
 * this journal" for `self_approval`).
 */
export function apiErrorCodeMessage(
  code: string,
  t: TFunction,
  overrides?: Readonly<Partial<Record<string, string>>>,
): string | undefined {
  const override = overrides?.[code];
  if (override !== undefined) {
    return override;
  }
  return isApiErrorCode(code) ? say(t, apiErrorKey(code)) : undefined;
}

/**
 * What to tell a person about a failed request, in their language.
 *
 * The code's own message where this build has one; otherwise the generic
 * words for the status — not signed in, not allowed, not found, too many
 * requests — and for anything else, or our own fault, the request id to quote. Never the
 * server's English `message`. Anything that is not an API failure at all
 * (no response, a bug) is "an unexpected error".
 */
export function apiErrorMessage(
  failure: unknown,
  t: TFunction,
  overrides?: Readonly<Partial<Record<string, string>>>,
): string {
  if (!isApiFailure(failure)) {
    return t('errors.unexpected');
  }
  const reference =
    failure.requestId === undefined || failure.requestId === '' ? '—' : failure.requestId;
  // Our own fault: what helps is the reference to quote, when there is one.
  if (
    failure.code === 'internal_error' &&
    reference !== '—' &&
    overrides?.internal_error === undefined
  ) {
    return t('errors.body', { requestId: reference });
  }
  const known = apiErrorCodeMessage(failure.code, t, overrides);
  if (known !== undefined) {
    return known;
  }
  switch (failure.status) {
    case 401:
      return say(t, apiErrorKey('unauthorised'));
    case 403:
      return t('errors.forbidden');
    case 404:
      return t('errors.notFound');
    case 429:
      return say(t, apiErrorKey('rate_limited'));
    default:
      return t('errors.body', { requestId: reference });
  }
}

/**
 * The lines a failure's details add under its message, in this language: one
 * per detail whose code this build knows and which says more than the
 * failure's own code, each once. A detail with an unknown code is left out
 * rather than shown in the server's words.
 */
export function apiErrorDetailMessages(
  failure: unknown,
  t: TFunction,
  overrides?: Readonly<Partial<Record<string, string>>>,
): string[] {
  if (!isApiFailure(failure) || failure.details === undefined) {
    return [];
  }
  const lines = new Set<string>();
  for (const detail of failure.details) {
    if (detail.code === failure.code) {
      continue;
    }
    const line = apiErrorCodeMessage(detail.code, t, overrides);
    if (line !== undefined) {
      lines.add(line);
    }
  }
  return [...lines];
}
