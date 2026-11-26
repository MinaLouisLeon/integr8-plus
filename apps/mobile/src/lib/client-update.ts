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
  /** The update address to open, with the company filled in; absent from an older server. */
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

/** Where Update goes: a store app, or a page in the in-app browser. */
export type UpdateDestination = { kind: 'store'; url: string } | { kind: 'page'; url: string };

/**
 * Where the Update button takes this phone (0023). A company that publishes
 * its app in its own Google Play and App Store accounts gets its store page,
 * which is where the new version is; on an iPhone with no App Store page yet,
 * and for an app Integr8 staff send as an APK, the server's update address.
 * Nothing at all when there is neither.
 */
export function updateDestination(
  link: string | undefined,
  storeLinks: { googlePlay: string; appStore: string | null } | null | undefined,
  /** `Platform.OS`: only `android` and `ios` have a store. */
  platform: string,
): UpdateDestination | undefined {
  const store =
    storeLinks === null || storeLinks === undefined
      ? null
      : platform === 'android'
        ? storeLinks.googlePlay
        : platform === 'ios'
          ? storeLinks.appStore
          : null;
  if (store !== null) {
    return { kind: 'store', url: store };
  }
  return link === undefined ? undefined : { kind: 'page', url: link };
}

/** For tests: forget what was reported. */
export function resetUpdateNotice(): void {
  notice = undefined;
}
