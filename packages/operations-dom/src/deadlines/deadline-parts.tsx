import { formatDateTime, formatRelativeTime, useTranslation } from '@integr8/i18n';
import { type DeadlineState, type JobDeadline, type JobDeadlines, useOperations } from '../api.js';
import { cardClass } from '../ui.js';

/**
 * A job's response and completion deadlines (P27): a small countdown for a
 * list, and the full picture for the job screen. The colour changes at the
 * warning and at the miss, and the words always say which.
 */

const chip =
  'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium';

export const DEADLINE_STYLE: Record<DeadlineState, string> = {
  running: 'border-border-subtle bg-surface text-content',
  warning: 'border-warning bg-warning-subtle text-content',
  missed: 'border-danger bg-danger-subtle text-danger',
  met_late: 'border-danger bg-surface text-danger',
  met: 'border-success bg-success-subtle text-content',
  closed: 'border-border-subtle bg-surface-muted text-content-muted',
};

/**
 * The deadline that matters now, for a row: the next one still open, with
 * how long is left, or the last one missed. Nothing when the job has none.
 */
export function DeadlineChip({ deadline, now }: { deadline: JobDeadline | null; now?: Date }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  if (deadline === null) {
    return null;
  }
  const relative = formatRelativeTime(deadline.dueAt, {
    locale,
    ...(now === undefined ? {} : { now }),
  });
  return (
    <span
      className={`${chip} ${DEADLINE_STYLE[deadline.state]}`}
      title={t('operations.deadlines.chip.dueAt', {
        time: formatDateTime(deadline.dueAt, { locale }),
      })}
    >
      {deadline.state === 'running' || deadline.state === 'warning'
        ? t(`operations.deadlines.chip.${deadline.kind}.open`, { when: relative })
        : t(`operations.deadlines.chip.${deadline.kind}.${deadline.state}`)}
    </span>
  );
}

/** One deadline on the job screen: when it is due, and how it went. */
function DeadlineLine({
  label,
  deadline,
}: {
  label: string;
  deadline: NonNullable<JobDeadlines['response']>;
}) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const due = formatDateTime(deadline.dueAt, { locale });
  const met = deadline.metAt === null ? '' : formatDateTime(deadline.metAt, { locale });
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <dt className="text-content-muted">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-content">
        <span>{t('operations.deadlines.card.due', { time: due })}</span>
        <span className={`${chip} ${DEADLINE_STYLE[deadline.state]}`}>
          {t(`operations.deadlines.state.${deadline.state}`)}
        </span>
        {deadline.state === 'running' || deadline.state === 'warning' ? (
          <span className="text-content-muted">
            {formatRelativeTime(deadline.dueAt, { locale })}
          </span>
        ) : null}
        {met === '' ? null : (
          <span className="text-content-muted">
            {t('operations.deadlines.card.metAt', { time: met })}
          </span>
        )}
      </dd>
    </div>
  );
}

export function DeadlinesCard({ deadlines }: { deadlines: JobDeadlines | null }) {
  const { t } = useTranslation();
  if (deadlines === null || (deadlines.response === null && deadlines.completion === null)) {
    return null;
  }
  return (
    <section aria-labelledby="deadlines-heading" className={cardClass}>
      <h2 id="deadlines-heading" className="text-lg font-semibold text-content">
        {t('operations.deadlines.card.title')}
      </h2>
      <dl className="flex flex-col gap-3">
        {deadlines.response === null ? null : (
          <DeadlineLine
            label={t('operations.deadlines.kind.response')}
            deadline={deadlines.response}
          />
        )}
        {deadlines.completion === null ? null : (
          <DeadlineLine
            label={t('operations.deadlines.kind.completion')}
            deadline={deadlines.completion}
          />
        )}
      </dl>
      <p className="text-xs text-content-muted">
        {t(`operations.deadlines.card.clock.${deadlines.clock}`)}{' '}
        {t('operations.deadlines.card.rules')}
      </p>
    </section>
  );
}
