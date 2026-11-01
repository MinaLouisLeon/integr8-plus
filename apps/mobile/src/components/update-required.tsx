import { useTranslation } from '@integr8/i18n';
import { fontSize, spacing } from '@integr8/tokens';
import * as WebBrowser from 'expo-web-browser';
import { useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { currentUpdateNotice, subscribeToUpdateNotice } from '~/lib/client-update';
import { Button, useTheme } from './ui';

/**
 * A strip along the bottom of every screen once the server has refused this
 * build as too old (Low 6). Nothing the app sends will be accepted until it is
 * replaced, so it stays, over whatever screen is open, and its Update button
 * opens the web app's download page — this company's, for a company's own app —
 * in the in-app browser, as the app's other outside pages are.
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
  const link = notice.link;

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
      {link === undefined ? null : (
        <Button
          label={t('clientUpdate.button')}
          onPress={() => void WebBrowser.openBrowserAsync(link)}
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
