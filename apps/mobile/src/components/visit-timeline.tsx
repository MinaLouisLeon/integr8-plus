import { useTranslation } from '@integr8/i18n';
import type { VisitListItem } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { refusalMessage } from '~/lib/refusals';
import { useNow } from '~/lib/use-now';
import { markVisitDone } from '~/local/job-actions';
import { Button, Row, Section } from './ui';

/**
 * The engineer's visits today, in order (P25): when, where, and with whom, as
 * the office planned them on the schedule. A visit that has started can be
 * marked done here, with or without signal; the job itself moves on from its
 * own screen.
 */
export function VisitTimeline({ visits }: { visits: readonly VisitListItem[] }) {
  const { t, i18n } = useTranslation();
  const now = useNow(60_000);
  const [busy, setBusy] = useState<string | undefined>();

  if (visits.length === 0) {
    return null;
  }
  const time = new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' });

  const done = async (visit: VisitListItem) => {
    setBusy(visit.id);
    try {
      await markVisitDone(visit.job.id, visit.id);
    } catch (error) {
      Alert.alert(t('mobile.work.failedTitle'), refusalMessage(t, error, t('mobile.work.failed')));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Section title={t('mobile.visits.title')}>
      {visits.map((visit) => {
        const started = Date.parse(visit.startsAt) <= now.getTime();
        return (
          <View key={visit.id} style={styles.entry}>
            <Row
              title={`${time.format(new Date(visit.startsAt))} – ${time.format(new Date(visit.endsAt))} · ${visit.job.title}`}
              lines={[
                `${visit.job.referenceLabel} · ${visit.job.siteName}`,
                visit.people.length > 1
                  ? t('mobile.visits.with', { people: visit.people.join(', ') })
                  : '',
                visit.notes ?? '',
              ].filter((line) => line !== '')}
              tag={
                visit.status === 'done'
                  ? { label: t('mobile.visits.done'), tone: 'muted' }
                  : visit.job.hazards
                    ? { label: t('mobile.jobs.hazards'), tone: 'danger' }
                    : undefined
              }
              onPress={() => router.push({ pathname: '/jobs/[id]', params: { id: visit.job.id } })}
            />
            {visit.status === 'planned' && started && visit.job.closedAt === null ? (
              <Button
                label={t('mobile.visits.markDone')}
                variant="secondary"
                busy={busy === visit.id}
                disabled={busy !== undefined}
                onPress={() => void done(visit)}
              />
            ) : null}
          </View>
        );
      })}
    </Section>
  );
}

const styles = StyleSheet.create({
  entry: { gap: spacing[1] },
});
