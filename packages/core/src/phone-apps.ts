/**
 * A company's phone app as the stores know it (0023).
 *
 * Every company's phone app is built in Integr8's one Expo project, each with
 * its own identifiers, which are permanent: an Android phone only updates an
 * app to one with the same package name and signing key. The phone app's
 * build config, and the API's links to a store company's listings, both come
 * from here, so the two can never disagree.
 */

/** `com.integr8.plus.<slug>`: hyphens are legal in an iOS bundle identifier. */
export function iosBundleIdentifier(slug: string): string {
  return `com.integr8.plus.${slug}`;
}

/**
 * `com.integr8.plus.<slug>` with every hyphen turned into an underscore, and a
 * `c` in front of a segment that starts with a digit: a Java package segment
 * is an identifier, so `7up` is not one and `c7up` is.
 */
export function androidPackage(slug: string): string {
  const segment = slug.replaceAll('-', '_');
  return `com.integr8.plus.${/^\d/u.test(segment) ? `c${segment}` : segment}`;
}

export interface StoreLinks {
  /** The app's Google Play page. */
  googlePlay: string;
  /** The app's App Store page, or null until its App Store number is known. */
  appStore: string | null;
}

/**
 * Where a store company's people get and update its phone app: its Google
 * Play page by package name, and its App Store page by the app record's
 * number (App Store Connect → App Information → Apple ID).
 */
export function storeLinks(slug: string, appStoreId: string | null): StoreLinks {
  return {
    googlePlay: `https://play.google.com/store/apps/details?id=${androidPackage(slug)}`,
    appStore: appStoreId === null ? null : `https://apps.apple.com/app/id${appStoreId}`,
  };
}
