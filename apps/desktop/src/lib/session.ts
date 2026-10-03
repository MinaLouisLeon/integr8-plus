import { SessionManager } from '@integr8/api-client';
import { createTokenStore } from './platform';
import { APP_VERSION, API_BASE_URL } from './env';

/**
 * The desktop session.
 *
 * Unlike the web app, this uses the shared `SessionManager`: there is a real
 * credential store here, so the refresh token can live on the device and
 * rotation can be managed in the client. The web app cannot do that — a browser
 * has no keychain — which is why it keeps its refresh token in an httpOnly
 * cookie instead.
 */

let manager: SessionManager | undefined;
let onSignedOut: (() => void) | undefined;

export function session(): SessionManager {
  manager ??= new SessionManager({
    baseUrl: API_BASE_URL,
    clientApp: 'desktop',
    clientVersion: APP_VERSION,
    store: createTokenStore(),
    onSignedOut: () => {
      onSignedOut?.();
    },
    onClientTooOld: ({ message }) => {
      // The updater plugin handles the actual update; this is what the person
      // sees in the meantime.
      console.warn(message);
    },
  });

  return manager;
}

/** Lets the router send somebody back to sign-in when their session ends. */
export function whenSignedOut(handler: () => void): void {
  onSignedOut = handler;
}
