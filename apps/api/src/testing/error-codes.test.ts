import { describe, expect, it } from 'vitest';
import { extractErrorCodes, parseCodeList, readCodeList, renderCodeList } from './error-codes.js';

/**
 * The checked-in list of error codes is the API's source, read again.
 *
 * `@integr8/i18n` holds a message in English and Arabic for each code on that
 * list, and fails its own test when one is missing. That only means something
 * while the list is the codes the API really returns — which is this test.
 */
describe('the checked-in list of error codes', () => {
  const extraction = extractErrorCodes();

  it('knows where every code comes from', () => {
    expect(
      extraction.unresolved,
      'a code that is an expression: add it to DYNAMIC_SITES in src/testing/error-codes.ts',
    ).toEqual([]);
  });

  it('matches the API source', () => {
    const checkedIn = readCodeList();
    const added = extraction.codes.filter((code) => !checkedIn.includes(code));
    const removed = checkedIn.filter((code) => !extraction.codes.includes(code));
    expect(
      { added, removed },
      'packages/i18n/src/api-error-codes.ts is out of date: run `pnpm --filter @integr8/api error-codes` to update it, then give each new code a message under `apiErrors` in en.ts and ar.ts',
    ).toEqual({ added: [], removed: [] });
    expect(checkedIn).toEqual(extraction.codes);
  });

  it('finds the codes of every kind of refusal', () => {
    expect(extraction.codes).toEqual(
      expect.arrayContaining([
        // Fixed-code helpers in http/errors.ts.
        'forbidden',
        'not_found',
        'unauthorised',
        'rate_limited',
        'internal_error',
        'validation_failed',
        // A helper with a code, an ApiError subclass, @integr8/auth and the sync push.
        'version_conflict',
        'feature_disabled',
        'auth.invalid_credentials',
        'work_order_changed',
        // A detail, and the codes behind an expression.
        'photos_missing',
        'name_taken',
        'location_name_taken',
        'logo_not_found',
        'rules_not_confirmed',
      ]),
    );
  });

  it('writes a list it reads back as written', () => {
    expect(parseCodeList(renderCodeList(['a', 'b.c']))).toEqual(['a', 'b.c']);
  });
});
