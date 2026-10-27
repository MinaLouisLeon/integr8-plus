import { useTranslation } from '@integr8/i18n';
import { router } from 'expo-router';
import { formatWhen } from '~/lib/format';
import { listDeadline } from '~/lib/job-terms';
import { Row } from './ui';
import type { JobListItem } from '@integr8/offline';

export function JobRow({ job }: { job: JobListItem }) {
  const { t, i18n } = useTranslation();
  const when =
    job.closedAt !== null
      ? t('mobile.jobs.closed', { when: formatWhen(job.closedAt, i18n.language) })
      : job.dueBy !== null
        ? t('mobile.jobs.due', { when: formatWhen(job.dueBy, i18n.language) })
        : '';
  // The deadline that matters now (P27), against the phone's clock.
  const deadline = job.closedAt === null ? listDeadline(job.deadlines, new Date()) : undefined;
  const deadlineLine =
    deadline === undefined
      ? ''
      : `${t(`mobile.job.deadline.${deadline.kind}`, { when: formatWhen(deadline.dueAt, i18n.language) })} · ${t(`mobile.job.deadline.state.${deadline.state}`)}`;
  const urgent = deadline?.state === 'missed' || deadline?.state === 'warning';

  return (
    <Row
      title={job.title}
      lines={[
        `${job.referenceLabel} · ${t(`operations.state.${job.state}`)}`,
        `${job.customerName} · ${job.siteName}`,
        job.siteAddress,
        when,
        deadlineLine,
      ].filter((line) => line !== '')}
      tag={
        job.hazards
          ? { label: `⚠ ${t('mobile.jobs.hazards')}`, tone: 'danger' }
          : urgent && deadline !== undefined
            ? { label: t(`mobile.job.deadline.state.${deadline.state}`), tone: 'danger' }
            : job.maintenance
              ? { label: t('mobile.job.maintenance'), tone: 'muted' }
              : undefined
      }
      onPress={() => router.push({ pathname: '/jobs/[id]', params: { id: job.id } })}
    />
  );
}
