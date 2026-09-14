import { createI18n, I18nextProvider } from '@integr8/i18n';
import { isRtl } from '@integr8/i18n/core';
import * as Sentry from '@sentry/react-native';
import * as Network from 'expo-network';
import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, I18nManager } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { APP_ENV, SENTRY_DSN } from '~/lib/env';
import { deviceLocale } from '~/lib/preferences';
import { APP_VERSION, whenSignedOut } from '~/lib/session';
import { localData } from '~/local/local-data';

/**
 * The root layout.
 *
 * Sentry is initialised first, so an error thrown during startup is still
 * reported — tagged with the build, which is what P05's fourth exit criterion
 * asks for.
 */
if (SENTRY_DSN !== undefined && SENTRY_DSN !== '') {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: APP_ENV,
    release: APP_VERSION,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
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
    void localData.wipe();
  }
  router.replace('/sign-in');
});

function RootLayout() {
  const [i18n] = useState(() => createI18n({ locale }));

  // Keep the phone current whenever it could be: on launch, back in the
  // foreground, and when a connection returns. Each attempt checks it is signed
  // in and online first, and none of them holds up a screen.
  useEffect(() => {
    void localData.download();
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void localData.download();
      }
    });
    const network = Network.addNetworkStateListener((state) => {
      if (state.isInternetReachable === true) {
        void localData.download();
      }
    });
    return () => {
      foreground.remove();
      network.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <I18nextProvider i18n={i18n}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </I18nextProvider>
    </SafeAreaProvider>
  );
}

// Wrapping the root is what catches an error thrown in any screen below it.
export default Sentry.wrap(RootLayout);
