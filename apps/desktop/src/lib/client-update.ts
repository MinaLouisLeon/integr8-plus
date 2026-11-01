import { type ClientTooOldInfo, updatePageUrl } from '@integr8/api-client';

/**
 * Whether the server has said this build is too old, and where to update.
 *
 * Set by the session and the staff sign-in the first time any request is
 * refused with `client_too_old`, and read by the strip at the top of the window
 * (`ClientTooOldBanner`). Installed desktop apps normally update themselves
 * (`updates.ts`); this is the way out when that has not happened — an updater
 * key that changed, a feed that cannot be reached, an app installed before
 * the updater existed.
 */
export interface UpdateNotice {
  /** The download page to open, with the company filled in; absent from an older server. */
  link: string | undefined;
}

let notice: UpdateNotice | undefined;
const listeners = new Set<() => void>();

/**
 * The page the Update button opens: the server's address, with the company's
 * slug for a company's own build so the page lists that company's installers.
 * The staff app (and a development build) opens the plain page.
 */
export function updateLinkFor(
  updateUrl: string | undefined,
  companySlug: string | undefined,
): string | undefined {
  return updateUrl === undefined ? undefined : updatePageUrl(updateUrl, companySlug);
}

/** What the session calls when the server refuses this build. */
export function reportClientTooOld(info: ClientTooOldInfo, companySlug: string | undefined): void {
  const link = updateLinkFor(info.updateUrl, companySlug);
  if (notice !== undefined && (link === undefined || link === notice.link)) {
    return;
  }
  notice = { link: link ?? notice?.link };
  for (const listener of listeners) {
    listener();
  }
}

export function currentUpdateNotice(): UpdateNotice | undefined {
  return notice;
}

export function subscribeToUpdateNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: forget what was reported. */
export function resetUpdateNotice(): void {
  notice = undefined;
}
