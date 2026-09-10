import { createI18n, I18nextProvider } from '@integr8/i18n';
import { isRtl } from '@integr8/i18n/core';
import * as Sentry from '@sentry/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { I18nManager } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { APP_ENV, SENTRY_DSN } from '~/lib/env';
import { deviceLocale } from '~/lib/preferences';
import { APP_VERSION } from '~/lib/session';

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Retrying a 401 or a validation failure achieves nothing, and on a
        // phone it also spends battery and a metered connection.
        const status = (error as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

function RootLayout() {
  const [i18n] = useState(() => createI18n({ locale }));

  return (
    <SafeAreaProvider>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }} />
        </QueryClientProvider>
      </I18nextProvider>
    </SafeAreaProvider>
  );
}

// Wrapping the root is what catches an error thrown in any screen below it.
export default Sentry.wrap(RootLayout);
