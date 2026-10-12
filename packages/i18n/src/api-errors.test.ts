import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  API_ERROR_MESSAGE_KEYS,
  apiErrorDetailMessages,
  apiErrorKey,
  apiErrorMessage,
} from './api-errors.js';
import { createI18n } from './index.js';
import { ar } from './messages/ar.js';
import { en } from './messages/en.js';

/**
 * The API's error codes are a contract with this catalogue (ADR-0012).
 *
 * `API_ERROR_CODES` is read from the API's source (a test in `apps/api` keeps
 * it so). A code with no message would show a person a raw key, or tempt a
 * screen back into showing the server's English; a message for a code the API
 * no longer returns is a sentence nobody maintains.
 */

interface Tree {
  readonly [key: string]: string | Tree;
}

function lookup(tree: Tree, key: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') {
      return undefined;
    }
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function leaves(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`),
  );
}

describe('API error messages', () => {
  it('has a message in English and Arabic for every code the API can return', () => {
    const catalogues: [string, Tree][] = [
      ['en', en],
      ['ar', ar],
    ];
    const missing = API_ERROR_CODES.flatMap((code) =>
      catalogues.flatMap(([language, catalogue]) =>
        lookup(catalogue, apiErrorKey(code)) === undefined
          ? [`${code} (${language}: ${apiErrorKey(code)})`]
          : [],
      ),
    );
    expect(missing, 'add these to api-errors.en.ts and api-errors.ar.ts').toEqual([]);
  });

  it('has no message for a code the API no longer returns', () => {
    const codes: readonly string[] = API_ERROR_CODES;
    const stale = leaves(en.apiErrors).filter((code) => !codes.includes(code));
    expect(stale).toEqual([]);
  });

  it('keeps one message per code: none under apiErrors for a code that points elsewhere', () => {
    const doubled = Object.keys(API_ERROR_MESSAGE_KEYS).filter(
      (code) => lookup(en.apiErrors, code) !== undefined,
    );
    expect(doubled).toEqual([]);
    const codes: readonly string[] = API_ERROR_CODES;
    expect(Object.keys(API_ERROR_MESSAGE_KEYS).filter((code) => !codes.includes(code))).toEqual([]);
  });

  it('interpolates nothing, because a refusal carries nothing safe to interpolate', () => {
    const withPlaceholders = [...leaves(en.apiErrors), ...leaves(ar.apiErrors)].filter((key) =>
      `${lookup(en.apiErrors, key) ?? ''}${lookup(ar.apiErrors, key) ?? ''}`.includes('{{'),
    );
    expect(withPlaceholders).toEqual([]);
  });
});

describe('apiErrorMessage', () => {
  const english = createI18n({ locale: 'en' }).t;
  const arabic = createI18n({ locale: 'ar' }).t;
  const failure = (
    status: number,
    code: string,
    details: { field: string; code: string }[] = [],
  ) => ({
    status,
    code,
    message: 'The server’s English, never shown',
    requestId: 'req-1',
    details,
  });

  it('says a known code in the reader’s language', () => {
    expect(apiErrorMessage(failure(409, 'version_conflict'), english)).toBe(
      en.apiErrors.version_conflict,
    );
    expect(apiErrorMessage(failure(409, 'version_conflict'), arabic)).toBe(
      ar.apiErrors.version_conflict,
    );
    expect(apiErrorMessage(failure(409, 'customer_on_hold'), arabic)).toBe(
      'هذا العميل موقوف مؤقتًا. راجع قسم الحسابات قبل إنشاء أي عمل.',
    );
  });

  it('follows a code whose message lives elsewhere, and a code with a dot', () => {
    expect(apiErrorMessage(failure(403, 'forbidden'), arabic)).toBe(ar.errors.forbidden);
    expect(apiErrorMessage(failure(401, 'auth.invalid_credentials'), arabic)).toBe(
      ar.auth.invalidCredentials,
    );
    expect(apiErrorMessage(failure(401, 'auth.session_revoked'), arabic)).toBe(
      ar.apiErrors.auth.session_revoked,
    );
    expect(apiErrorMessage(failure(404, 'customer_unknown'), english)).toBe(
      en.apiErrors.customer_not_found,
    );
  });

  it('falls back by status for a code this build does not know, never to the server’s words', () => {
    expect(apiErrorMessage(failure(403, 'brand_new'), arabic)).toBe(ar.errors.forbidden);
    expect(apiErrorMessage(failure(404, 'brand_new'), arabic)).toBe(ar.errors.notFound);
    expect(apiErrorMessage(failure(401, 'brand_new'), english)).toBe(en.apiErrors.unauthorised);
    expect(apiErrorMessage(failure(429, 'brand_new'), english)).toBe(en.auth.rateLimited);
    const other = apiErrorMessage(failure(409, 'brand_new'), english);
    expect(other).toContain('req-1');
    expect(other).not.toContain('never shown');
    expect(apiErrorMessage(new Error('boom'), english)).toBe(en.errors.unexpected);
  });

  it('prefers a screen’s own message for a code', () => {
    expect(apiErrorMessage(failure(422, 'self_approval'), english, { self_approval: 'Mine' })).toBe(
      'Mine',
    );
  });

  it('adds the details it knows, once each, and drops the rest', () => {
    const lines = apiErrorDetailMessages(
      failure(409, 'completion_blocked', [
        { field: 'photos.before', code: 'photos_missing' },
        { field: 'photos.after', code: 'photos_missing' },
        { field: 'signoff', code: 'signoff_missing' },
        { field: 'x', code: 'completion_blocked' },
        { field: 'y', code: 'not_a_code_we_know' },
      ]),
      arabic,
    );
    expect(lines).toEqual([ar.apiErrors.photos_missing, ar.apiErrors.signoff_missing]);
  });
});
