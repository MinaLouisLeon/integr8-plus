import { useTranslation } from '@integr8/i18n';
import { router } from 'expo-router';
import type { JobListItem } from '~/local/queries';
import { formatWhen } from '~/lib/format';
import { Row } from './ui';

export function JobRow({ job }: { job: JobListItem }) {
  const { t, i18n } = useTranslation();
  const when =
    job.closedAt !== null
      ? t('mobile.jobs.closed', { when: formatWhen(job.closedAt, i18n.language) })
      : job.dueBy !== null
        ? t('mobile.jobs.due', { when: formatWhen(job.dueBy, i18n.language) })
        : '';

  return (
    <Row
      title={job.title}
      lines={[
        `${job.referenceLabel} · ${t(`operations.state.${job.state}`)}`,
        `${job.customerName} · ${job.siteName}`,
        job.siteAddress,
        when,
      ]}
      tag={job.hazards ? { label: `⚠ ${t('mobile.jobs.hazards')}`, tone: 'danger' } : undefined}
      onPress={() => router.push({ pathname: '/jobs/[id]', params: { id: job.id } })}
    />
  );
}
