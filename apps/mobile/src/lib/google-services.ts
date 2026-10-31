/**
 * Whether a `google-services.json` can go into this Android build (P14).
 *
 * Expo's push notifications reach an Android phone through Firebase Cloud
 * Messaging, and a release build only registers with FCM when it was built
 * with the Firebase project's `google-services.json`. One file can hold every
 * company's app, one Android client per package id; EAS hands it to the build
 * as the file environment variable `GOOGLE_SERVICES_JSON`.
 *
 * Google's build plugin fails the whole build when the file has no client for
 * the package being built. A company added to Integr8 but not yet to Firebase
 * would then get no app at all, so such a build leaves the file out and says
 * why: the app installs and works, without push, until the company is added
 * and the app built again.
 */

interface GoogleServicesFile {
  client?: { client_info?: { android_client_info?: { package_name?: unknown } } }[];
}

/** The Android package ids a `google-services.json` has clients for. */
export function googleServicesPackages(contents: string): string[] {
  let parsed: GoogleServicesFile;
  try {
    parsed = JSON.parse(contents) as GoogleServicesFile;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.client)) {
    return [];
  }
  return parsed.client.flatMap((client) => {
    const name = client.client_info?.android_client_info?.package_name;
    return typeof name === 'string' ? [name] : [];
  });
}

export type GoogleServicesDecision =
  | { use: true }
  | { use: false; reason: 'not_set' | 'unreadable' | 'package_missing'; message?: string };

/** Whether to build `androidPackage` with the file at `path`, given its contents. */
export function googleServicesDecision(
  path: string | undefined,
  contents: string | undefined,
  androidPackage: string,
): GoogleServicesDecision {
  if (path === undefined || path === '') {
    return { use: false, reason: 'not_set' };
  }
  if (contents === undefined) {
    return {
      use: false,
      reason: 'unreadable',
      message: `GOOGLE_SERVICES_JSON names ${path}, which cannot be read: this build has no push notifications.`,
    };
  }
  if (!googleServicesPackages(contents).includes(androidPackage)) {
    return {
      use: false,
      reason: 'package_missing',
      message: `google-services.json has no Android app ${androidPackage}: add it to the Firebase project, upload the new file to EAS and build again. This build has no push notifications.`,
    };
  }
  return { use: true };
}
