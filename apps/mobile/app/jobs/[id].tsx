import { CLOSED_WORK_ORDER_STATES } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { addressText, job } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { Linking, Pressable, Text, View } from 'react-native';
import { AccessNotes } from '~/components/access-notes';
import { JobForms } from '~/components/job-forms';
import { JobSyncBadge, JobSyncCard } from '~/components/job-sync';
import {
  JobActions,
  JobAttachments,
  JobChecklist,
  JobPhotos,
  JobTimes,
  navigateTo,
  SignoffSummary,
} from '~/components/job-work';
import { LocalGate } from '~/components/local-gate';
import {
  Badge,
  Body,
  Button,
  Detail,
  EmptyState,
  Heading,
  Row,
  ScrollScreen,
  Section,
  useTheme,
} from '~/components/ui';
import { formatWhen } from '~/lib/format';
import { useLocalQuery } from '~/local/react';

/**
 * One job, from the phone, in the order the engineer works through it (P14):
 * how to get in, then what to do — the next step, the instructions, the forms,
 * the photos, the checklist, the files — and only then the job's particulars.
 * How to get in comes before the title, because it is what they need at the gate.
 */
export default function JobScreen() {
  return (
    <LocalGate>
      <Job />
    </LocalGate>
  );
}

function Job() {
  const { t, i18n } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLocalQuery(`job:${id}`, ['work_orders'], (sql) => job(sql, id));

  if (state.status !== 'ready') {
    return <ScrollScreen>{null}</ScrollScreen>;
  }
  if (state.data === undefined) {
    return (
      <ScrollScreen>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        <EmptyState title={t('mobile.job.notOnPhone')} body="" />
      </ScrollScreen>
    );
  }

  const { detail, downloadedAt } = state.data;
  const { workOrder, site, customer, siteContact } = detail;
  const when = (value: string) => formatWhen(value, i18n.language);
  const closed = CLOSED_WORK_ORDER_STATES.includes(workOrder.state);
  const address = addressText(site.address);

  return (
    <ScrollScreen>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        <JobSyncBadge workOrderId={workOrder.id} />
      </View>

      <AccessNotes access={site.access} />

      <JobSyncCard workOrderId={workOrder.id} />

      <View style={{ gap: spacing[2] }}>
        <Body muted>{workOrder.referenceLabel}</Body>
        <Heading>{workOrder.title}</Heading>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
          <Badge label={t(`operations.state.${workOrder.state}`)} tone="accent" />
          <Badge
            label={t(`operations.priority.${workOrder.priority}`)}
            tone={workOrder.priority === 'urgent' ? 'danger' : 'muted'}
          />
        </View>
        <Body>{address}</Body>
      </View>

      {closed ? null : <JobActions detail={detail} />}

      {workOrder.instructions === null ? null : (
        <Section title={t('mobile.job.instructions')}>
          <Body>{workOrder.instructions}</Body>
        </Section>
      )}

      <JobForms workOrderId={workOrder.id} siteId={site.id} />

      <JobPhotos detail={detail} closed={closed} />

      <JobChecklist detail={detail} closed={closed} />

      <JobAttachments detail={detail} />

      <JobTimes detail={detail} />

      <Section title={t('mobile.job.details')}>
        <Detail label={t('mobile.job.customer')}>
          <Link
            label={customer.name}
            onPress={() =>
              router.push({ pathname: '/customers/[id]', params: { id: customer.id } })
            }
          />
        </Detail>
        <Detail label={t('mobile.job.site')}>
          <Link
            label={site.name}
            onPress={() => router.push({ pathname: '/sites/[id]', params: { id: site.id } })}
          />
          <Body>{address}</Body>
          <Link label={t('mobile.job.openInMaps')} onPress={() => void navigateTo(site, address)} />
        </Detail>
        {siteContact === null ? null : (
          <Detail label={t('mobile.job.siteContact')}>
            <Body>{siteContact.name}</Body>
            {siteContact.phone === null ? null : (
              <Link
                label={t('mobile.job.call', { number: siteContact.phone })}
                onPress={() => void Linking.openURL(`tel:${siteContact.phone ?? ''}`)}
              />
            )}
          </Detail>
        )}
        {workOrder.dueBy === null && workOrder.dueFrom === null ? null : (
          <Detail label={t('mobile.job.due')}>
            {workOrder.dueFrom !== null && workOrder.dueBy !== null
              ? t('mobile.job.dueWindow', {
                  from: when(workOrder.dueFrom),
                  by: when(workOrder.dueBy),
                })
              : when(workOrder.dueBy ?? workOrder.dueFrom!)}
          </Detail>
        )}
        {workOrder.description === null ? null : (
          <Detail label={t('mobile.job.description')}>{workOrder.description}</Detail>
        )}
        <SignoffSummary detail={detail} />
      </Section>

      {detail.crew.length === 0 ? null : (
        <Section title={t('mobile.job.crew')}>
          {detail.crew.map((member) => (
            <Body key={member.id}>
              {member.lead ? `${member.name} · ${t('mobile.job.lead')}` : member.name}
            </Body>
          ))}
        </Section>
      )}

      {detail.comments.length === 0 ? null : (
        <Section title={t('mobile.job.notes')}>
          {detail.comments.map((comment) => (
            <Row
              key={comment.id}
              title={comment.author.name}
              lines={[comment.body, when(comment.createdAt)]}
              tag={
                comment.visibility === 'internal'
                  ? { label: t('mobile.job.internal'), tone: 'muted' }
                  : undefined
              }
            />
          ))}
        </Section>
      )}

      {detail.previousAtSite.length === 0 ? null : (
        <Section title={t('mobile.job.previous')}>
          {detail.previousAtSite.map((previous) => (
            <Row
              key={previous.id}
              title={previous.title}
              lines={[`${previous.referenceLabel} · ${t(`operations.state.${previous.state}`)}`]}
              onPress={() => router.push({ pathname: '/jobs/[id]', params: { id: previous.id } })}
            />
          ))}
        </Section>
      )}

      <Body muted>{t('mobile.job.downloadedAt', { when: when(downloadedAt) })}</Body>
    </ScrollScreen>
  );
}

function Link({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="link" onPress={onPress} hitSlop={6}>
      <Text style={{ color: theme.accent, fontWeight: '600', textAlign: 'auto' }}>{label}</Text>
    </Pressable>
  );
}
