import { SessionManager } from '@integr8/api-client';
import Constants from 'expo-constants';
import { API_BASE_URL } from './env';
import { SecureTokenStore } from './platform';

/**
 * The mobile session.
 *
 * The same `SessionManager` the desktop app uses, over SecureStore instead of
 * the OS keychain. Both are devices with a real credential store, so both keep
 * their own refresh token; the web app cannot and uses an httpOnly cookie.
 */

let manager: SessionManager | undefined;
let onSignedOut: (() => void) | undefined;

/** The build, sent as `x-client-version` and used as the Sentry release. */
export const APP_VERSION: string = Constants.expoConfig?.version ?? '0.1.0';

export function session(): SessionManager {
  manager ??= new SessionManager({
    baseUrl: API_BASE_URL,
    clientApp: 'mobile',
    clientVersion: APP_VERSION,
    store: new SecureTokenStore(),
    onSignedOut: () => {
      onSignedOut?.();
    },
  });

  return manager;
}

export function whenSignedOut(handler: () => void): void {
  onSignedOut = handler;
}
