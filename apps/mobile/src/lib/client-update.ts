import { type ClientTooOldInfo, updatePageUrl } from '@integr8/api-client';

/**
 * Whether the server has said this build is too old, and where to update.
 *
 * Set by the session the first time any request is refused with
 * `client_too_old` — signing in, syncing, anything — and read by the strip
 * along the bottom of every screen (`UpdateRequired`). Kept for the life of the
 * app: the build does not get any newer until it is replaced.
 */
export interface UpdateNotice {
  /** The download page to open, with the company filled in; absent from an older server. */
  link: string | undefined;
}

let notice: UpdateNotice | undefined;
const listeners = new Set<() => void>();

/**
 * The page the Update button opens: the server's address, with this company's
 * slug for a company's own build so the page lists that company's app. The
 * generic app opens the plain page.
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
  // A later refusal without an address (it should not happen) keeps the one known.
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
