import { useTranslation } from '@integr8/i18n';
import { fontSize, spacing } from '@integr8/tokens';
import * as WebBrowser from 'expo-web-browser';
import { useSyncExternalStore } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  currentUpdateNotice,
  subscribeToUpdateNotice,
  updateDestination,
} from '~/lib/client-update';
import { COMPANY } from '~/lib/company';
import { Button, useTheme } from './ui';

/**
 * A strip along the bottom of every screen once the server has refused this
 * build as too old (Low 6). Nothing the app sends will be accepted until it is
 * replaced, so it stays, over whatever screen is open, and its Update button
 * opens the server's update address (`API_UPDATE_URL`, with this company added
 * for a company's own app) in the in-app browser, as the app's other outside
 * pages are. A company that publishes in its own stores (0023) has its store
 * pages built into its app, and Update opens the store instead.
 *
 * Work saved on the phone is kept: it is sent once the new version is
 * installed and signed in.
 */
export function UpdateRequired() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const notice = useSyncExternalStore(
    subscribeToUpdateNotice,
    currentUpdateNotice,
    currentUpdateNotice,
  );

  if (notice === undefined) {
    return null;
  }
  const destination = updateDestination(notice.link, COMPANY?.storeLinks, Platform.OS);

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.strip,
        {
          backgroundColor: theme.warningSubtle,
          borderColor: theme.warning,
          paddingBottom: insets.bottom + spacing[3],
        },
      ]}
    >
      <Text style={[styles.text, { color: theme.text }]}>{t('clientUpdate.needed')}</Text>
      {destination === undefined ? null : (
        <Button
          label={t('clientUpdate.button')}
          onPress={() =>
            void (destination.kind === 'store'
              ? Linking.openURL(destination.url)
              : WebBrowser.openBrowserAsync(destination.url))
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    start: 0,
    end: 0,
    bottom: 0,
    gap: spacing[2],
    borderTopWidth: 1,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  text: { fontSize: fontSize.sm, textAlign: 'auto' },
});
