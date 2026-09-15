import { useTranslation } from '@integr8/i18n';
import { jobSyncState } from '@integr8/offline';
import { fontSize, radii, spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalQuery } from '~/local/react';
import { useTheme } from './ui';

/**
 * "Is it safe to leave?" — answered at a glance, for one job (P12).
 *
 * Safe means nothing done on this job exists only on the phone: every change
 * applied by the server, every photo and signature confirmed, nothing waiting for
 * the engineer to decide. Anything less says what is still here.
 */
export function JobSyncBadge({ workOrderId }: { workOrderId: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const state = useLocalQuery(
    `job-sync:${workOrderId}`,
    ['outbox', 'uploads', 'submissions'],
    (sql) => jobSyncState(sql, workOrderId),
  );
  if (state.status !== 'ready') {
    return null;
  }
  const { safeToLeave, needsAttention } = state.data;
  const tone = needsAttention > 0 ? 'danger' : safeToLeave ? 'success' : 'warning';
  const label =
    needsAttention > 0
      ? t('mobile.jobSync.attention')
      : safeToLeave
        ? t('mobile.jobSync.safe')
        : t('mobile.jobSync.notYet');
  const colours = {
    danger: { background: theme.dangerSubtle, text: theme.danger },
    warning: { background: theme.warningSubtle, text: theme.warning },
    success: { background: theme.successSubtle, text: theme.success },
  }[tone];

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.badge, { backgroundColor: colours.background }]}
    >
      <Text style={[styles.badgeText, { color: colours.text }]}>
        {tone === 'success' ? '✓' : '⚠'} {label}
      </Text>
    </View>
  );
}

export function JobSyncCard({ workOrderId }: { workOrderId: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const state = useLocalQuery(
    `job-sync:${workOrderId}`,
    ['outbox', 'uploads', 'submissions'],
    (sql) => jobSyncState(sql, workOrderId),
  );
  if (state.status !== 'ready') {
    return null;
  }
  const { safeToLeave, pendingChanges, pendingUploads, needsAttention } = state.data;
  const tone = needsAttention > 0 ? 'danger' : safeToLeave ? 'success' : 'warning';
  const colours = {
    danger: { background: theme.dangerSubtle, border: theme.danger },
    warning: { background: theme.warningSubtle, border: theme.warning },
    success: { background: theme.successSubtle, border: theme.success },
  }[tone];

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.card, { backgroundColor: colours.background, borderColor: colours.border }]}
    >
      <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
        {needsAttention > 0
          ? t('mobile.jobSync.attention')
          : safeToLeave
            ? `✓ ${t('mobile.jobSync.safe')}`
            : t('mobile.jobSync.notYet')}
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>
        {needsAttention > 0
          ? t('mobile.jobSync.attentionBody')
          : safeToLeave
            ? t('mobile.jobSync.safeBody')
            : t('mobile.jobSync.notYetBody', {
                changes: t('mobile.jobSync.changes', { count: pendingChanges }),
                files: t('mobile.jobSync.files', { count: pendingUploads }),
              })}
      </Text>
      {needsAttention > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => router.push('/sync')} hitSlop={8}>
          <Text style={[styles.action, { color: theme.accent }]}>
            {t('mobile.jobSync.openSync')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'center',
    borderRadius: radii.full,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  badgeText: { fontSize: fontSize.sm, fontWeight: '700' },
  card: {
    gap: spacing[2],
    borderWidth: 2,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', textAlign: 'auto' },
  body: { fontSize: fontSize.base, textAlign: 'auto' },
  action: { fontSize: fontSize.sm, fontWeight: '600' },
});
