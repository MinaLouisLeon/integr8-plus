import { useTranslation } from '@integr8/i18n';
import { type MyQualification, myQualifications } from '@integr8/offline';
import { radii, spacing } from '@integr8/tokens';
import { StyleSheet, View } from 'react-native';
import { LocalGate } from '~/components/local-gate';
import {
  BackButton,
  Badge,
  Body,
  EmptyState,
  Heading,
  NotReadyScreen,
  ScrollScreen,
  useTheme,
} from '~/components/ui';
import { formatDay, formatWhen } from '~/lib/format';
import { useLocalQuery } from '~/local/react';

/**
 * The engineer's own skills and certificates (P26), from the phone: what they
 * hold, and when each certificate expires, expired ones first. Read only — the
 * office records them — and kept from the last sync, so it opens with no signal.
 */
export default function QualificationsScreen() {
  return (
    <LocalGate>
      <Qualifications />
    </LocalGate>
  );
}

function Qualifications() {
  const { t, i18n } = useTranslation();
  const state = useLocalQuery('my-qualifications', ['meta'], myQualifications);

  if (state.status !== 'ready') {
    return <NotReadyScreen failed={state.status === 'error'} />;
  }
  const { items, receivedAt } = state.data;

  return (
    <ScrollScreen>
      <BackButton />
      <Heading>{t('mobile.qualifications.title')}</Heading>
      <Body muted>{t('mobile.qualifications.intro')}</Body>
      {items.length === 0 ? (
        <EmptyState
          title={
            receivedAt === null
              ? t('mobile.qualifications.notYet')
              : t('mobile.qualifications.empty')
          }
          body=""
        />
      ) : (
        items.map((item) => <QualificationCard key={item.id} item={item} />)
      )}
      {receivedAt === null ? null : (
        <Body muted>
          {t('mobile.qualifications.asOf', { when: formatWhen(receivedAt, i18n.language) })}
        </Body>
      )}
    </ScrollScreen>
  );
}

const TONE: Record<MyQualification['state'], 'danger' | 'accent' | 'muted'> = {
  expired: 'danger',
  expiring: 'accent',
  valid: 'muted',
  no_expiry: 'muted',
  removed: 'muted',
};

function QualificationCard({ item }: { item: MyQualification }) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const day = (value: string) => formatDay(value, i18n.language);
  const lines = [
    item.qualificationType.kind === 'skill'
      ? t('mobile.qualifications.skill')
      : item.expiresOn === null
        ? t('mobile.qualifications.noExpiry')
        : item.state === 'expired'
          ? t('mobile.qualifications.expiredOn', { date: day(item.expiresOn) })
          : t('mobile.qualifications.expiresOn', { date: day(item.expiresOn) }),
    item.issuedOn === null ? '' : t('mobile.qualifications.issuedOn', { date: day(item.issuedOn) }),
    item.reference === null
      ? ''
      : t('mobile.qualifications.reference', { reference: item.reference }),
  ].filter((line) => line !== '');

  return (
    <View
      accessible
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
    >
      <View style={styles.title}>
        <View style={{ flex: 1 }}>
          <Body>{item.qualificationType.name}</Body>
        </View>
        <Badge label={t(`mobile.qualifications.state.${item.state}`)} tone={TONE[item.state]} />
      </View>
      {lines.map((line) => (
        <Body key={line} muted>
          {line}
        </Body>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[1],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  title: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
});
