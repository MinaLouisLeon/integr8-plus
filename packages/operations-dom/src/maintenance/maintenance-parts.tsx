import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import {
  type MaintenancePlan,
  type MaintenanceStanding,
  useOperations,
  type WorkOrderDetail,
} from '../api.js';

/**
 * The pieces of maintenance plans (P27) the other screens share: where a due
 * date stands, a plan's status, its interval in words, and the plans that
 * made a job.
 */

const badge =
  'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium';

const STANDING_STYLE: Record<MaintenanceStanding, string> = {
  upcoming: 'border-border-subtle bg-surface text-content',
  created: 'border-accent bg-surface text-content',
  completed: 'border-success bg-success-subtle text-content',
  overdue: 'border-danger bg-danger-subtle text-danger',
  cancelled: 'border-border-subtle bg-surface-muted text-content-muted line-through',
  skipped: 'border-border-subtle bg-surface-muted text-content-muted',
};

export function MaintenanceStandingBadge({ standing }: { standing: MaintenanceStanding }) {
  const { t } = useTranslation();
  return (
    <span className={`${badge} ${STANDING_STYLE[standing]}`}>
      {t(`operations.maintenance.standing.${standing}`)}
    </span>
  );
}

const STATUS_STYLE: Record<MaintenancePlan['status'], string> = {
  active: 'border-success bg-success-subtle text-content',
  paused: 'border-warning bg-warning-subtle text-content',
  ended: 'border-border-subtle bg-surface-muted text-content-muted',
};

export function PlanStatusBadge({ status }: { status: MaintenancePlan['status'] }) {
  const { t } = useTranslation();
  return (
    <span className={`${badge} ${STATUS_STYLE[status]}`}>
      {t(`operations.maintenance.planStatus.${status}`)}
    </span>
  );
}

/** "Every 3 months from the start date", or "3 months after the last job was completed". */
export function useIntervalText(): (
  plan: Pick<MaintenancePlan, 'intervalCount' | 'intervalUnit' | 'counting'>,
) => string {
  const { t } = useTranslation();
  return (plan) => {
    const every = t(`operations.maintenance.every.${plan.intervalUnit}`, {
      count: plan.intervalCount,
    });
    return t(`operations.maintenance.counting.${plan.counting}.summary`, { every });
  };
}

/** The plans that made a job, for the job screen's details. Nothing when none did. */
export function PlannedMaintenance({ job }: { job: WorkOrderDetail }) {
  const { t } = useTranslation();
  const { paths, navigate, locale } = useOperations();
  if (job.maintenancePlans.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-0.5 text-sm sm:col-span-2">
      <dt className="text-content-muted">{t('operations.maintenance.planned')}</dt>
      <dd className="text-content">
        <ul className="flex flex-col">
          {job.maintenancePlans.map((plan) => (
            <li key={plan.planId} className="flex flex-wrap items-center gap-x-1">
              <span dir="auto">{plan.title}</span>
              <span aria-hidden="true">·</span>
              <a
                href={paths.asset(plan.asset.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.asset(plan.asset.id));
                }}
              >
                <span dir="ltr">{plan.asset.reference}</span>{' '}
                <span dir="auto">{plan.asset.name}</span>
              </a>
              <span className="text-content-muted">
                {t('operations.maintenance.dueOn', {
                  date: formatCalendarDate(plan.dueOn, { locale }),
                })}
              </span>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}
