import { ApiRequestError } from '@integr8/api-client';
import { ar, createI18n, en } from '@integr8/i18n';
import { LOCAL_CHANGE_ERROR_CODES, LocalChangeError, UPLOAD_FAILED } from '@integr8/offline';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_CODES_SAID_AS_THE_APIS,
  LOCAL_REFUSAL_KEYS,
  refusalMessage,
  syncRefusalMessage,
} from './refusals';

/**
 * Refusals on the phone, in the engineer's language (ADR-0012): the
 * server's by its code, the phone's own by its code, and never the English
 * either was raised with.
 */

const english = createI18n({ locale: 'en' }).t;
const arabic = createI18n({ locale: 'ar' }).t;

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

describe('the phone’s own refusals', () => {
  it('has words in English and Arabic for every code the phone refuses a change with', () => {
    const said: readonly string[] = [
      ...Object.keys(LOCAL_REFUSAL_KEYS),
      ...LOCAL_CODES_SAID_AS_THE_APIS,
    ];
    expect(LOCAL_CHANGE_ERROR_CODES.filter((code) => !said.includes(code))).toEqual([]);
    expect(
      said.filter((code) => !(LOCAL_CHANGE_ERROR_CODES as readonly string[]).includes(code)),
    ).toEqual([]);
    const missing = Object.values(LOCAL_REFUSAL_KEYS).filter(
      (key) => lookup(en, key) === undefined || lookup(ar, key) === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('says a phone refusal by its code, not its English', () => {
    const error = new LocalChangeError('shift_open', 'You are already clocked in.');
    expect(refusalMessage(arabic, error, 'fallback')).toBe(ar.mobile.localRefusal.shift_open);
    expect(
      refusalMessage(arabic, new LocalChangeError('asset_retired', 'English'), 'fallback'),
    ).toBe(ar.apiErrors.asset_retired);
    expect(refusalMessage(english, new LocalChangeError('item_not_in_van', 'x'), 'f')).toBe(
      en.mobile.parts.notInVan,
    );
  });

  it('says a server refusal by its code', () => {
    const error = new ApiRequestError(409, 'work_order_closed', 'English', 'req-1');
    expect(refusalMessage(arabic, error, 'fallback')).toBe(ar.apiErrors.work_order_closed);
    expect(refusalMessage(english, new Error('disk full'), 'fallback')).toBe('fallback');
  });
});

describe('a change the office refused', () => {
  it('is said by the code the outbox stored, in Arabic', () => {
    expect(syncRefusalMessage(arabic, { code: 'work_order_closed' })).toBe(
      ar.apiErrors.work_order_closed,
    );
    expect(syncRefusalMessage(arabic, { code: UPLOAD_FAILED })).toBe(
      ar.mobile.conflict.uploadFailedShort,
    );
    expect(syncRefusalMessage(arabic, { code: 'gave_up' })).toBe(ar.mobile.syncRefusal.gaveUp);
    expect(syncRefusalMessage(arabic, { code: 'a_code_from_the_future' })).toBe(
      ar.mobile.syncRefusal.other,
    );
  });
});
