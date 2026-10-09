import { useTranslation } from '@integr8/i18n';
import { syncStatus } from '@integr8/offline';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatWhen } from '~/lib/format';
import { localData } from '~/local/local-data';
import { useLocalQuery, useSyncActivity, useSyncState } from '~/local/react';
import { LocalReadError, useTheme } from './ui';

/**
 * Whether the phone and the office agree, in one line (P12). It never covers
 * the work: the jobs are listed underneath whatever this says. Tapping it opens
 * the sync screen.
 */
export function SyncBanner() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const state = useSyncState();
  const activity = useSyncActivity();
  const status = useLocalQuery('sync-status', ['outbox', 'uploads', 'meta'], syncStatus);

  if (status.status === 'error') {
    return <LocalReadError />;
  }
  if (status.status !== 'ready') {
    return null;
  }
  const { pendingChanges, pendingUploads, conflicts, failed, failedUploads, lastSuccessfulSyncAt } =
    status.data;
  const waiting = pendingChanges + pendingUploads;
  const attention = conflicts + failed + failedUploads;

  const message =
    activity.phase === 'sending'
      ? t('mobile.syncState.sending')
      : activity.phase === 'uploading'
        ? t('mobile.syncState.uploading', { done: activity.done, total: activity.total })
        : activity.phase === 'receiving'
          ? t('mobile.syncState.receiving')
          : attention > 0
            ? t('mobile.syncState.attention', { count: attention })
            : state.problem === 'sign_in_needed'
              ? t('mobile.syncState.signInNeeded')
              : waiting > 0
                ? state.problem === 'offline'
                  ? t('mobile.syncState.waitingOffline', { count: waiting })
                  : state.lastRun?.uploadsPaused === 'low_battery'
                    ? t('mobile.syncState.lowBattery')
                    : t('mobile.syncState.waiting', { count: waiting })
                : state.problem === 'failed'
                  ? t('mobile.syncState.failed')
                  : lastSuccessfulSyncAt === null
                    ? t('mobile.syncState.allSentNever')
                    : t('mobile.syncState.allSent', {
                        when: formatWhen(lastSuccessfulSyncAt, i18n.language),
                      });

  const tone =
    attention > 0 ? 'danger' : waiting > 0 || state.problem !== undefined ? 'warning' : 'calm';
  const colours = {
    danger: { background: theme.dangerSubtle, border: theme.danger },
    warning: { background: theme.warningSubtle, border: theme.warning },
    calm: { background: theme.surfaceMuted, border: theme.border },
  }[tone];
  const busy = activity.phase !== 'idle';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t('mobile.syncState.details')}
      onPress={() => router.push('/sync')}
      style={[styles.banner, { backgroundColor: colours.background, borderColor: colours.border }]}
    >
      <Text accessibilityLiveRegion="polite" style={[styles.text, { color: theme.text }]}>
        {message}
      </Text>
      {busy || state.problem === 'sign_in_needed' ? null : (
        <View>
          <Pressable
            accessibilityRole="button"
            onPress={() => void localData.sync('manual', true)}
            hitSlop={8}
          >
            <Text style={[styles.action, { color: theme.accent }]}>
              {t('mobile.syncState.syncNow')}
            </Text>
          </Pressable>
        </View>
      )}
    </Pressable>
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
