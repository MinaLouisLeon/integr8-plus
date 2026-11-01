import { SessionManager, type SignOutReason } from '@integr8/api-client';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { reportClientTooOld } from './client-update';
import { COMPANY } from './company';
import { API_BASE_URL, AUTH_VERIFICATION_KEYS } from './env';
import { checkOfflineGrant, type GrantKey, parseVerificationKeys } from './offline-grant';
import { SecureTokenStore } from './platform';

/**
 * The mobile session.
 *
 * The same `SessionManager` the desktop app uses, over SecureStore instead of
 * the OS keychain. Both are devices with a real credential store, so both keep
 * their own refresh token; the web app cannot and uses an httpOnly cookie.
 *
 * Only the phone has an offline grant (P03), and it checks it itself: signed
 * by a key the build carries, a grant, and not yet ended by its own `exp`.
 */

let manager: SessionManager | undefined;
let onSignedOut: ((reason: SignOutReason) => void) | undefined;

/** The build, sent as `x-client-version` and used as the Sentry release. */
export const APP_VERSION: string = Constants.expoConfig?.version ?? '1.1.0';

/** Each reason a grant was refused, said to Sentry once a run rather than on every check. */
const reported = new Set<string>();

function report(reason: string, error?: unknown): void {
  if (reported.has(reason)) {
    return;
  }
  reported.add(reason);
  if (error === undefined) {
    Sentry.captureMessage(`Offline grant not usable on this phone: ${reason}`, {
      level: 'warning',
      tags: { area: 'offline-grant', reason },
    });
  } else {
    Sentry.captureException(error, { tags: { area: 'offline-grant', reason } });
  }
}

/**
 * Reads the keys once. A build made with keys it cannot read fails closed:
 * no grant opens it, so the phone needs signal to open, and Sentry hears why.
 */
function grantKeys(): GrantKey[] | undefined {
  if (AUTH_VERIFICATION_KEYS === undefined) {
    return undefined;
  }
  try {
    return parseVerificationKeys(AUTH_VERIFICATION_KEYS);
  } catch (error) {
    report('invalid_keys', error);
    return [];
  }
}

/**
 * The phone's own check of its offline grant.
 *
 * A build made without `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS` cannot check a
 * signature, so it goes by the grant's end as the server sent it, and says so
 * to Sentry once: the build settings need the keys (docs/auth/offline-access.md).
 */
function offlineGrantCheck(): (grant: string, now: Date) => boolean {
  const keys = grantKeys();
  return (grant, now) => {
    if (keys === undefined) {
      report('built_without_keys');
      return true;
    }
    const check = checkOfflineGrant(grant, keys, now);
    // An ended grant is the ordinary case; anything else means a build with the
    // wrong keys, a phone clock set back, or a grant that was tampered with.
    if (!check.ok && check.reason !== 'expired') {
      report(check.reason);
    }
    return check.ok;
  };
}

export function session(): SessionManager {
  manager ??= new SessionManager({
    baseUrl: API_BASE_URL,
    clientApp: 'mobile',
    clientVersion: APP_VERSION,
    store: new SecureTokenStore(),
    verifyOfflineGrant: offlineGrantCheck(),
    onSignedOut: (reason) => {
      onSignedOut?.(reason);
    },
    // Any refusal of this build, from any screen, shows the Update strip.
    onClientTooOld: (info) => {
      reportClientTooOld(info, COMPANY?.slug);
    },
  });

  return manager;
}

export function whenSignedOut(handler: (reason: SignOutReason) => void): void {
  onSignedOut = handler;
}
