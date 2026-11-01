import { isTauri } from './platform';

/**
 * Whether a newer version of this app is waiting, and installing it.
 *
 * The Tauri updater plugin does the work: it asks the feed stamped into the
 * build (the web app's `/desktop-updates/<staff or company>/…`), checks the
 * download against the public key in `tauri.conf.json`, and refuses anything
 * not signed with the release's key. Tauri 2 never asks by itself, so the app
 * does, on start and every few hours after.
 *
 * Nothing here can fail loudly. A feed that cannot be reached (offline, a
 * development build pointing at the placeholder address, a release with no
 * signed bundles) means "no update", never an error on screen: the app the
 * person has still works.
 */

export interface AvailableUpdate {
  version: string;
  /**
   * Downloads and installs it. On Windows the installer takes over and opens
   * the new version itself; elsewhere the new version starts next time the
   * app is opened.
   */
  install: () => Promise<void>;
}

/** How often a running app asks again. A release is rare; a check is one small request. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The plugin's `check`, narrowed to what is used here, so tests can stand in for it. */
export type UpdateCheck = () => Promise<{
  version: string;
  downloadAndInstall: () => Promise<void>;
} | null>;

async function pluginCheck(): ReturnType<UpdateCheck> {
  const { check } = await import('@tauri-apps/plugin-updater');
  return check();
}

/**
 * The waiting update, or `undefined` when there is none or no way to know. A
 * browser tab has no updater; it always runs what the server serves.
 */
export async function findUpdate(
  options: { check?: UpdateCheck; inTauri?: boolean } = {},
): Promise<AvailableUpdate | undefined> {
  if (!(options.inTauri ?? isTauri())) {
    return undefined;
  }
  try {
    const update = await (options.check ?? pluginCheck)();
    if (update === null) {
      return undefined;
    }
    return { version: update.version, install: () => update.downloadAndInstall() };
  } catch (error) {
    console.warn('Could not check for an update', error);
    return undefined;
  }
}

/** True on Windows, where installing closes the app and the installer reopens it. */
export function installerRestartsApp(
  userAgent: string = globalThis.navigator?.userAgent ?? '',
): boolean {
  return /windows/iu.test(userAgent);
}
