import { createI18n, I18nextProvider } from '@integr8/i18n';
import { isRtl } from '@integr8/i18n/core';
import * as Sentry from '@sentry/react-native';
import * as Network from 'expo-network';
import { router, Stack, useGlobalSearchParams, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { AppState, I18nManager } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppLock } from '~/components/app-lock';
import { BrandProvider } from '~/components/brand';
import { refreshBrand } from '~/lib/brand-cache';
import { COMPANY } from '~/lib/company';
import { APP_ENV, SENTRY_DSN } from '~/lib/env';
import { deviceLocale } from '~/lib/preferences';
import { APP_VERSION, session, whenSignedOut } from '~/lib/session';
import { registerBackgroundSync, unregisterBackgroundSync } from '~/local/background';
import { localData } from '~/local/local-data';
import { channelNames, listenForPush, registerForPush, unregisterForPush } from '~/local/push';
import { useLocalStatus } from '~/local/react';
import { saveRoute } from '~/local/resume';

/**
 * The root layout.
 *
 * Sentry is initialised first, so an error thrown during startup is still
 * reported — tagged with the build, which is what P05's fourth exit criterion
 * asks for, and with the over-the-air update it is running (P14).
 *
 * A crash with no signal is not lost: the native SDKs write every event to disk
 * first and send what is stored the next time the app starts with a connection.
 * `maxCacheItems` is how many are kept meanwhile — a week in a basement.
 */
if (SENTRY_DSN !== undefined && SENTRY_DSN !== '') {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: APP_ENV,
    release: APP_VERSION,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    maxCacheItems: 100,
  });
  Sentry.setTag('update_id', Updates.updateId ?? 'embedded');
  Sentry.setTag('update_channel', Updates.channel ?? 'none');
}

const locale = deviceLocale();

/**
 * Right-to-left is a native setting on React Native, not a style.
 *
 * `allowRTL` lets the platform mirror layouts at all; `forceRTL` decides
 * whether it does. Both have to be set before the first render, and changing
 * them afterwards needs an app restart to take effect — which is precisely why
 * this is settled in P05 rather than retrofitted in P32.
 */
I18nManager.allowRTL(true);
I18nManager.forceRTL(isRtl(locale));

/**
 * When the session ends, the company's data leaves the phone.
 *
 * - **Signed out, or refused by the server** — revoked from the office, the
 *   membership ended — the phone is wiped. A revoked phone is wiped the next
 *   time it reaches the API, which it tries on launch, on coming back to the
 *   foreground and when the connection returns.
 * - **Expired** — the refresh token lapsed on a phone left unopened — is not a
 *   decision anybody made about this phone. Its work stays, encrypted, until
 *   somebody signs in: the same person carries on, anybody else wipes it first.
 */
whenSignedOut((reason) => {
  if (reason !== 'expired') {
    void unregisterForPush();
    void localData.wipe();
    void unregisterBackgroundSync();
  }
  // A company's own app goes back to its website; the generic app to sign-in.
  router.replace(COMPANY === undefined ? '/sign-in' : '/welcome');
});

function RootLayout() {
  const [i18n] = useState(() => createI18n({ locale }));

  // Sync whenever it could help: on launch, back in the foreground, when a
  // connection returns, and in the background while the app is closed. Each run
  // checks it is signed in and online first, and none of them holds up a screen.
  useEffect(() => {
    // The public brand, before anything needs a session: nothing if this is the generic app.
    void refreshBrand();
    void localData.sync('launch');
    void registerBackgroundSync();
    const names = channelNames(i18n.t);
    void session()
      .isSignedIn()
      .then((signedIn) => (signedIn ? registerForPush(names) : undefined));
    const stopPush = listenForPush(names);
    void fetchUpdate();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void localData.sync('foreground');
        void fetchUpdate();
      }
    });
    const network = Network.addNetworkStateListener((state) => {
      if (state.isInternetReachable === true) {
        void localData.sync('reconnect');
      }
    });
    return () => {
      foreground.remove();
      network.remove();
      stopPush();
    };
  }, [i18n]);

  return (
    <SafeAreaProvider>
      <I18nextProvider i18n={i18n}>
        <StatusBar style="auto" />
        <AppLock>
          <BrandProvider>
            <RouteMemory />
            <Stack screenOptions={{ headerShown: false }} />
          </BrandProvider>
        </AppLock>
      </I18nextProvider>
    </SafeAreaProvider>
  );
}

/**
 * Over-the-air updates (P14): a fix to a screen reaches phones without a store
 * release. A new update is downloaded in the background and runs from the next
 * time the app starts — never under an engineer's fingers mid-form — and only
 * if it was built for this binary's runtime version.
 */
async function fetchUpdate(): Promise<void> {
  if (__DEV__ || !Updates.isEnabled) {
    return;
  }
  try {
    const check = await Updates.checkForUpdateAsync();
    if (check.isAvailable) {
      await Updates.fetchUpdateAsync();
    }
  } catch {
    // No signal, or the update server is unreachable: the next launch tries again.
  }
}

/** Remembers the screen on show, so a force-closed app opens where it was (P14). */
function RouteMemory() {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const status = useLocalStatus();
  const db = status.phase === 'open' ? status.db : undefined;
  const flat = JSON.stringify(
    Object.fromEntries(
      Object.entries(params).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
    ),
  );
  useEffect(() => {
    if (db !== undefined) {
      void saveRoute(db, pathname, JSON.parse(flat) as Record<string, string>).catch(
        () => undefined,
      );
    }
  }, [db, pathname, flat]);
  return null;
}

// Wrapping the root is what catches an error thrown in any screen below it.
export default Sentry.wrap(RootLayout);
