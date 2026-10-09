import { useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { useBrand } from '~/components/brand';
import { BrandHeader } from '~/components/brand-header';
import { Body, Button, ErrorState, Heading, LoadingState, useTheme } from '~/components/ui';
import { COMPANY } from '~/lib/company';
import { sameOrigin } from '~/lib/web-origin';

/**
 * A company's app, before anybody has signed in.
 *
 * The company's website first, under a slim bar in its colours with Login at
 * the end: the people who install a company's app are mostly its customers and
 * its staff, and both expect the website. Links that leave the site open in the
 * system browser, so the app never becomes a browser for the whole web. A
 * company with no website gets a branded welcome instead. Login is the same
 * sign-in screen as the generic app, locked to this company.
 */
export default function WelcomeScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const brand = useBrand();
  const website = brand.websiteUrl ?? COMPANY?.websiteUrl ?? null;
  const login = { label: t('mobile.welcome.login'), onPress: () => router.push('/sign-in') };

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <BrandHeader action={login} />
      {website === null ? (
        <NoWebsite name={brand.name} logoUrl={brand.logoUrl} />
      ) : (
        <Site url={website} />
      )}
    </View>
  );
}

function Site({ url }: { url: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // Remounting the WebView is the one reliable way to start the load again
  // after an error, on both platforms.
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <View style={[styles.body, { paddingBottom: insets.bottom + spacing[6] }]}>
        <ErrorState
          message={t('mobile.welcome.loadFailed')}
          onRetry={() => {
            setFailed(false);
            setAttempt((count) => count + 1);
          }}
        />
      </View>
    );
  }

  return (
    <WebView
      key={attempt}
      source={{ uri: url }}
      style={[styles.web, { backgroundColor: theme.background }]}
      startInLoadingState
      renderLoading={() => (
        <View style={[styles.loading, { backgroundColor: theme.background }]}>
          <LoadingState />
        </View>
      )}
      onError={() => setFailed(true)}
      onHttpError={(event) => {
        if (event.nativeEvent.statusCode >= 400) {
          setFailed(true);
        }
      }}
      onShouldStartLoadWithRequest={(request) => {
        // Only a top-level navigation can leave the site; an iframe or an
        // analytics request on another host is the page's own business.
        if (request.isTopFrame === false || sameOrigin(request.url, url)) {
          return true;
        }
        if (/^https?:/iu.test(request.url)) {
          void WebBrowser.openBrowserAsync(request.url);
        }
        return false;
      }}
      setSupportMultipleWindows={false}
      allowsBackForwardNavigationGestures
    />
  );
}

function NoWebsite({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.body, { paddingBottom: insets.bottom + spacing[6] }]}>
      {logoUrl === null ? null : (
        <Image
          source={{ uri: logoUrl }}
          style={styles.logo}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      )}
      <Heading>{t('mobile.welcome.title', { company: name })}</Heading>
      <Body muted>{t('mobile.welcome.body')}</Body>
      <Button label={t('mobile.welcome.login')} onPress={() => router.push('/sign-in')} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  web: { flex: 1 },
  loading: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0 },
  body: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing[4],
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[8],
  },
  logo: { width: 96, height: 96, alignSelf: 'flex-start' },
});
