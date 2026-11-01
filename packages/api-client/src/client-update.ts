/**
 * Where an app too old to be served gets its update.
 *
 * The API's `client_too_old` answer carries the address as a detail whose code
 * is `update_url` (from 1.2.4): the web app's download page unless the
 * deployment says otherwise. The phone and desktop apps open it from an Update
 * button. A company's own build adds `?company=<slug>`, so the page lists that
 * company's installers and phone app rather than the generic ones.
 */

/** The detail code the address travels under. */
export const UPDATE_URL_DETAIL = 'update_url';

/** What an app is told when its build is older than the server's minimum. */
export interface ClientTooOldInfo {
  /** The oldest build the server serves, from `min-supported-client`. */
  minimum: string;
  /** The server's sentence, written to make sense on its own. */
  message: string;
  /** Where to get the update. Absent from a server older than 1.2.4. */
  updateUrl?: string;
}

/** The update address among an error's details, if the server sent one. */
export function updateUrlFrom(
  details: readonly { code: string; message: string }[] | undefined,
): string | undefined {
  const url = details?.find((detail) => detail.code === UPDATE_URL_DETAIL)?.message.trim();
  return url === undefined || url === '' ? undefined : url;
}

/**
 * The download page for this build: the server's address, with the company
 * added for a company's own build. By hand rather than with `URL`, whose
 * `searchParams` React Native's polyfill does not reliably provide.
 */
export function updatePageUrl(updateUrl: string, companySlug?: string): string {
  const slug = companySlug?.trim() ?? '';
  if (slug === '') {
    return updateUrl;
  }
  const hashAt = updateUrl.indexOf('#');
  const base = hashAt === -1 ? updateUrl : updateUrl.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : updateUrl.slice(hashAt);
  const separator = !base.includes('?') ? '?' : /[?&]$/u.test(base) ? '' : '&';
  return `${base}${separator}company=${encodeURIComponent(slug)}${hash}`;
}
