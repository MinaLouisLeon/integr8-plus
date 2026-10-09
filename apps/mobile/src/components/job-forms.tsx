import { useTranslation } from '@integr8/i18n';
import { type JobForm, jobForms } from '@integr8/offline';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { type EarlierOffer, earlierOffer, startForm } from '~/forms/session';
import { formatWhen } from '~/lib/format';
import { localData } from '~/local/local-data';
import { useLocalQuery } from '~/local/react';
import { LocalReadError, Row, Section } from './ui';

/**
 * Opening one of a job's forms: a form already started opens where it is; one
 * not started yet is started on the phone, from the answers last given at this
 * site if the engineer wants them.
 */
export function useOpenForm(workOrderId: string, siteId: string) {
  const { t, i18n } = useTranslation();
  const [opening, setOpening] = useState<string | undefined>(undefined);

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

  return { open, opening };
}

/** The forms this job needs, as the phone has them. */
export function JobForms({
  workOrderId,
  siteId,
  onlyMissing = false,
}: {
  workOrderId: string;
  siteId: string;
  /** Just the required forms not submitted yet: what completing is waiting for. */
  onlyMissing?: boolean;
}) {
  const { t } = useTranslation();
  const forms = useLocalQuery(
    `job-forms:${workOrderId}`,
    ['work_orders', 'submissions', 'forms', 'outbox'],
    (sql) => jobForms(sql, workOrderId),
  );
  const { open, opening } = useOpenForm(workOrderId, siteId);

  if (forms.status === 'error') {
    return <LocalReadError />;
  }
  const shown =
    forms.status !== 'ready'
      ? []
      : onlyMissing
        ? forms.data.filter((form) => form.required && form.submission?.status !== 'submitted')
        : forms.data;
  if (shown.length === 0) {
    return null;
  }

  return (
    <Section title={t('mobile.job.forms')}>
      {shown.map((form) => (
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
