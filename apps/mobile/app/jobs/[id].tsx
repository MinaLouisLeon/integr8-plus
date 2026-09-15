import { useTranslation } from '@integr8/i18n';
import { addressText, job, type JobForm, jobForms } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Pressable, Text, View } from 'react-native';
import { AccessNotes } from '~/components/access-notes';
import { JobSyncBadge, JobSyncCard } from '~/components/job-sync';
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
import { type EarlierOffer, earlierOffer, startForm } from '~/forms/session';
import { formatWhen } from '~/lib/format';
import { localData } from '~/local/local-data';
import { useLocalQuery } from '~/local/react';

/**
 * One job, from the phone. How to get in comes first — before the title, before
 * the customer — because it is what the engineer needs at the gate.
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
  const theme = useTheme();
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
  const location = site.location;

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
      </View>

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
          <Body>{addressText(site.address)}</Body>
          {location === null ? null : (
            <Link
              label={t('mobile.job.openInMaps')}
              onPress={() =>
                void Linking.openURL(
                  `geo:${String(location.latitude)},${String(location.longitude)}?q=${String(location.latitude)},${String(location.longitude)}`,
                )
              }
            />
          )}
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
        {workOrder.instructions === null ? null : (
          <Detail label={t('mobile.job.instructions')}>{workOrder.instructions}</Detail>
        )}
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

      <JobForms workOrderId={workOrder.id} siteId={site.id} />

      {detail.checklist.length === 0 ? null : (
        <Section title={t('mobile.job.checklist')}>
          {detail.checklist.map((item) => (
            <Text
              key={item.id}
              accessibilityLabel={`${item.label}: ${item.done ? t('mobile.job.done') : t('mobile.job.notDone')}`}
              style={{ color: theme.text, textAlign: 'auto' }}
            >
              {item.done ? '☑' : '☐'} {item.label}
            </Text>
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

/**
 * The forms this job needs, as the phone has them. Tapping one opens it; a form
 * not started yet is started on the phone, from the answers last given at this
 * site if the engineer wants them.
 */
function JobForms({ workOrderId, siteId }: { workOrderId: string; siteId: string }) {
  const { t, i18n } = useTranslation();
  const forms = useLocalQuery(
    `job-forms:${workOrderId}`,
    ['work_orders', 'submissions', 'forms', 'outbox'],
    (sql) => jobForms(sql, workOrderId),
  );
  const [opening, setOpening] = useState<string | undefined>(undefined);

  if (forms.status !== 'ready' || forms.data.length === 0) {
    return null;
  }

  const open = async (form: JobForm) => {
    if (form.submission !== null) {
      router.push({ pathname: '/forms/[id]', params: { id: form.submission.id } });
      return;
    }
    const context = localData.changeContext();
    if (form.liveVersionId === null || context === undefined) {
      Alert.alert(form.title, t('mobile.fill.noLiveVersion'));
      return;
    }
    setOpening(form.formId);
    try {
      const offer = await earlierOffer(context, { form, siteId });
      const start = async (startFrom: EarlierOffer | undefined) => {
        const id = await startForm(context, { form, workOrderId, startFrom });
        router.push({
          pathname: '/forms/[id]',
          params:
            startFrom === undefined
              ? { id }
              : { id, prefilled: String(startFrom.filled), from: startFrom.job },
        });
      };
      if (offer === undefined) {
        await start(undefined);
        return;
      }
      Alert.alert(
        t('mobile.fill.start.title'),
        t('mobile.fill.start.body', {
          job: offer.job,
          when: offer.submittedAt === null ? '' : formatWhen(offer.submittedAt, i18n.language),
        }),
        [
          { text: t('mobile.fill.start.empty'), onPress: () => void start(undefined) },
          { text: t('mobile.fill.start.useEarlier'), onPress: () => void start(offer) },
        ],
      );
    } finally {
      setOpening(undefined);
    }
  };

  return (
    <Section title={t('mobile.job.forms')}>
      {forms.data.map((form) => (
        <Row
          key={form.formId}
          title={form.title}
          lines={[
            form.required ? t('mobile.job.required') : '',
            opening === form.formId
              ? t('common.loading')
              : t(`mobile.job.formStatus.${form.submission?.status ?? 'none'}`),
          ]}
          {...(form.submission !== null && !form.submission.sent
            ? { tag: { label: t('mobile.jobSync.notYet'), tone: 'muted' as const } }
            : {})}
          onPress={() => void open(form)}
        />
      ))}
    </Section>
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
