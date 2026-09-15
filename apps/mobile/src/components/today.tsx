import { shiftDurationMs } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import {
  addressText,
  currentShift,
  job,
  type JobListItem,
  LocalChangeError,
} from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { formatDuration, formatWhen } from '~/lib/format';
import { dayJobs, jobSteps, nextJob } from '~/lib/today';
import { useNow } from '~/lib/use-now';
import { clockIn, clockOut } from '~/local/job-actions';
import { useLocalQuery } from '~/local/react';
import { jobStatusLine, navigateTo, useJobStep } from './job-work';
import { Body, Button, Heading, useTheme } from './ui';

/**
 * The top of the engineer's day (P14): clocked in or not and for how long, the
 * job to do next with the one step forward on it, and directions there.
 */
export function Today({ open }: { open: readonly JobListItem[] }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const now = useNow(30_000);
  const shift = useLocalQuery('shift', ['shifts'], currentShift);
  const [clocking, setClocking] = useState(false);
  const next = nextJob(open, now);
  const nextDetail = useLocalQuery(`today-job:${next?.id ?? ''}`, ['work_orders'], (sql) =>
    next === undefined ? Promise.resolve(undefined) : job(sql, next.id),
  );
  const { busy, take } = useJobStep();
  const day = dayJobs(open, now);

  if (shift.status !== 'ready') {
    return null;
  }
  const clocked = shift.data;
  const underWay = open.find((item) =>
    ['travelling', 'on_site', 'in_progress'].includes(item.state),
  );

  const toggleClock = async () => {
    setClocking(true);
    try {
      if (clocked === undefined) {
        await clockIn();
      } else {
        await clockOut(clocked.id);
      }
    } catch (error) {
      Alert.alert(
        t('mobile.work.failedTitle'),
        error instanceof LocalChangeError ? error.message : t('mobile.work.failed'),
      );
    } finally {
      setClocking(false);
    }
  };
  const confirmClockOut = () => {
    if (underWay === undefined) {
      void toggleClock();
      return;
    }
    Alert.alert(
      t('mobile.today.clockOutTitle'),
      t('mobile.today.clockOutUnderWay', {
        job: underWay.referenceLabel,
        state: t(`operations.state.${underWay.state}`),
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('mobile.today.clockOut'), onPress: () => void toggleClock() },
      ],
    );
  };

  const detail = nextDetail.status === 'ready' ? nextDetail.data?.detail : undefined;
  const steps = detail === undefined ? undefined : jobSteps(detail.workOrder.state);

  return (
    <View style={styles.stack}>
      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <View style={styles.clockRow}>
          <View style={styles.grow}>
            <Text style={[styles.label, { color: theme.textMuted }]}>
              {t('mobile.today.title')}
            </Text>
            <Body>
              {clocked === undefined
                ? t('mobile.today.notClockedIn')
                : t('mobile.today.clockedIn', {
                    when: formatWhen(clocked.startedAt, i18n.language, now),
                    duration: formatDuration(shiftDurationMs(clocked, now), i18n.language),
                  })}
            </Body>
            <Body muted>{t('mobile.today.jobsToday', { count: day.length })}</Body>
          </View>
          <Button
            label={clocked === undefined ? t('mobile.today.clockIn') : t('mobile.today.clockOut')}
            variant={clocked === undefined ? 'primary' : 'secondary'}
            busy={clocking}
            onPress={clocked === undefined ? () => void toggleClock() : confirmClockOut}
          />
        </View>
      </View>

      {next === undefined || detail === undefined ? null : (
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.accent }]}>
          <Text style={[styles.label, { color: theme.textMuted }]}>
            {['travelling', 'on_site', 'in_progress'].includes(next.state)
              ? t('mobile.today.current')
              : t('mobile.today.next')}
          </Text>
          <Heading>{next.title}</Heading>
          <Body muted>{`${next.referenceLabel} · ${next.customerName}`}</Body>
          <Body>{addressText(detail.site.address)}</Body>
          {next.dueBy === null ? null : (
            <Body muted>
              {t('mobile.jobs.due', { when: formatWhen(next.dueBy, i18n.language, now) })}
            </Body>
          )}
          {next.hazards ? (
            <Text style={[styles.hazard, { color: theme.danger }]}>
              {`⚠ ${t('mobile.jobs.hazards')}`}
            </Text>
          ) : null}
          <Body>{jobStatusLine(t, detail, now, i18n.language)}</Body>
          <View style={styles.buttons}>
            {steps?.primary === undefined ? null : (
              <Button
                label={t(`mobile.work.step.${steps.primary}`)}
                busy={busy === steps.primary}
                disabled={busy !== undefined}
                onPress={() => void take(detail, steps.primary!)}
              />
            )}
            <View style={styles.pair}>
              <View style={styles.grow}>
                <Button
                  label={t('mobile.work.directions')}
                  variant="secondary"
                  onPress={() => void navigateTo(detail.site, addressText(detail.site.address))}
                />
              </View>
              <View style={styles.grow}>
                <Button
                  label={t('mobile.today.openJob')}
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/jobs/[id]', params: { id: next.id } })}
                />
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing[3] },
  card: {
    gap: spacing[2],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
  },
  clockRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  grow: { flex: 1, gap: spacing[1] },
  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    textAlign: 'auto',
  },
  hazard: { fontWeight: '600', textAlign: 'auto' },
  buttons: { gap: spacing[2], marginTop: spacing[1] },
  pair: { flexDirection: 'row', gap: spacing[2] },
});
