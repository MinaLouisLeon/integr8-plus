import { ApiRequestError } from '@integr8/api-client';
import { apiErrorCodeMessage, apiErrorMessage, type TFunction } from '@integr8/i18n';
import { LocalChangeError, UPLOAD_FAILED } from '@integr8/offline';

/**
 * Why something was refused, in the engineer's language (ADR-0012).
 *
 * Three kinds of refusal reach the phone's screens, and none is shown in the
 * English it was raised with:
 *
 * - the server's, by its code (`apiErrors.*` in the catalogue);
 * - the phone's own, a `LocalChangeError` thrown before a change is queued,
 *   by its code — the same message as the server's where the code means the
 *   same thing, otherwise `mobile.localRefusal.*`;
 * - a change the outbox stopped sending, stored with a code the phone gave it.
 */

/**
 * The phone's own refusal codes, and where each one's words are. A code that
 * is also an API code with the same meaning (a retired asset, a date ahead) is
 * not here: it uses the API's message.
 */
export const LOCAL_REFUSAL_KEYS = {
  work_order_not_on_phone: 'mobile.localRefusal.work_order_not_on_phone',
  quantity_invalid: 'mobile.parts.invalidQuantity',
  item_not_in_van: 'mobile.parts.notInVan',
  name_required: 'mobile.localRefusal.name_required',
  asset_not_on_phone: 'mobile.localRefusal.asset_not_on_phone',
  amount_invalid: 'mobile.localRefusal.amount_invalid',
  date_invalid: 'mobile.localRefusal.date_invalid',
  description_required: 'mobile.localRefusal.description_required',
  category_unknown: 'mobile.localRefusal.category_unknown',
  claim_not_on_phone: 'mobile.localRefusal.claim_not_on_phone',
  site_not_on_phone: 'mobile.localRefusal.site_not_on_phone',
  form_not_on_phone: 'mobile.localRefusal.form_not_on_phone',
  form_submitted: 'mobile.localRefusal.form_submitted',
  shift_open: 'mobile.localRefusal.shift_open',
  shift_not_open: 'mobile.localRefusal.shift_not_open',
  change_unknown: 'mobile.localRefusal.change_unknown',
  change_done: 'mobile.localRefusal.change_done',
  not_an_access_conflict: 'mobile.localRefusal.not_an_access_conflict',
  not_an_answers_conflict: 'mobile.localRefusal.not_an_answers_conflict',
  part_description_required: 'mobile.localRefusal.part_description_required',
  purchase_not_on_phone: 'mobile.localRefusal.purchase_not_on_phone',
  unit_price_invalid: 'mobile.localRefusal.unit_price_invalid',
  lot_not_in_van: 'mobile.localRefusal.lot_not_in_van',
  lots_mismatch: 'mobile.localRefusal.lots_mismatch',
  serial_required: 'mobile.localRefusal.serial_required',
} as const;

/** Phone codes that are API codes meaning the same thing, said as the API's. */
export const LOCAL_CODES_SAID_AS_THE_APIS = [
  'transition_not_allowed',
  'checklist_item_unknown',
  'asset_not_at_site',
  'asset_retired',
  'spent_in_future',
  'visit_unknown',
  'visit_final',
] as const;

/** A dynamic catalogue key; the keys above are checked by this app's tests. */
const say = (t: TFunction, key: string): string => t(key as 'mobile.work.failed');

function localMessage(t: TFunction, code: string): string | undefined {
  const key = (LOCAL_REFUSAL_KEYS as Partial<Record<string, string>>)[code];
  if (key !== undefined) {
    return say(t, key);
  }
  return (LOCAL_CODES_SAID_AS_THE_APIS as readonly string[]).includes(code)
    ? apiErrorCodeMessage(code, t)
    : undefined;
}

/**
 * Something a person tried that failed: the phone's own refusal or the
 * server's, said by its code; anything else as `fallback`.
 */
export function refusalMessage(t: TFunction, error: unknown, fallback: string): string {
  if (error instanceof LocalChangeError) {
    return localMessage(t, error.code) ?? fallback;
  }
  if (error instanceof ApiRequestError) {
    return apiErrorMessage(error, t);
  }
  return fallback;
}

/** The codes the outbox gives a change itself, rather than the server. */
const GAVE_UP = 'gave_up';
const UNREADABLE = 'unreadable_change';

/**
 * Why a queued change is waiting on the engineer, from what the outbox stored
 * with it: the server's refusal by its code, or the phone's own reason.
 */
export function syncRefusalMessage(
  t: TFunction,
  lastError: { code: string } | null | undefined,
): string {
  const code = lastError?.code;
  if (code === undefined) {
    return t('mobile.syncRefusal.other');
  }
  switch (code) {
    case UPLOAD_FAILED:
      return t('mobile.conflict.uploadFailedShort');
    case GAVE_UP:
      return t('mobile.syncRefusal.gaveUp');
    case UNREADABLE:
      return t('mobile.syncRefusal.unreadable');
    default:
      return apiErrorCodeMessage(code, t) ?? t('mobile.syncRefusal.other');
  }
}
