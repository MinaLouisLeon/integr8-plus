import { useTranslation } from '@integr8/i18n';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatWhen } from '~/lib/format';
import { localData } from '~/local/local-data';
import { useDownloadStatus } from '~/local/react';
import { useTheme } from './ui';

/**
 * Whether what the phone shows is current. It never covers the work: the jobs
 * are listed underneath whatever this says.
 */
export function SyncBanner({ lastDownloadAt }: { lastDownloadAt: string | null }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const status = useDownloadStatus();
  const when = lastDownloadAt === null ? undefined : formatWhen(lastDownloadAt, i18n.language);

  const message = status.running
    ? t('mobile.sync.updating')
    : status.problem === 'offline'
      ? when === undefined
        ? t('mobile.sync.offlineNothing')
        : t('mobile.sync.offline', { when })
      : status.problem === 'sign_in_needed'
        ? t('mobile.sync.signInNeeded')
        : status.problem === 'failed'
          ? when === undefined
            ? t('mobile.sync.failedNothing')
            : t('mobile.sync.failed', { when })
          : when === undefined
            ? t('mobile.sync.notYet')
            : t('mobile.sync.updatedAt', { when });

  const warn = status.problem !== undefined;

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.banner,
        {
          backgroundColor: warn ? theme.warningSubtle : theme.surfaceMuted,
          borderColor: warn ? theme.warning : theme.border,
        },
      ]}
    >
      <Text style={[styles.text, { color: theme.text }]}>{message}</Text>
      {status.running || status.problem === 'sign_in_needed' ? null : (
        <Pressable accessibilityRole="button" onPress={() => void localData.download()} hitSlop={8}>
          <Text style={[styles.action, { color: theme.accent }]}>{t('mobile.sync.updateNow')}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  text: { flex: 1, fontSize: fontSize.sm, textAlign: 'auto' },
  action: { fontSize: fontSize.sm, fontWeight: '600' },
});
