import { formatDateTime, formatNumber, useTranslation } from '@integr8/i18n';
import type { AiUsage, AiUsageAxis } from '../api.js';
import { useOperations } from '../api.js';

/**
 * How much of the assistant is left, in numbers and never only in colour
 * (docs/ai §10.5): the company's pooled counters and the member's own, each
 * axis with its limit and the moment it resets, in the reader's locale. An
 * axis the policy does not limit is not shown at all — a limit of "none" is
 * not a number worth a line.
 */

/** The first axis with nothing left, which closes the composer; `undefined` while something is. */
export function exhaustedAxis(usage: AiUsage): AiUsageAxis | undefined {
  if (usage.unlimited) {
    return undefined;
  }
  return [usage.daily, usage.monthly, usage.user.daily, usage.user.monthly]
    .filter(limited)
    .find((axis) => axis.remaining !== null && axis.remaining <= 0);
}

function limited(axis: AiUsageAxis | null): axis is AiUsageAxis {
  return axis !== null && axis.limit !== null;
}

export function UsageMeter({ usage }: { usage: AiUsage }) {
  const { t } = useTranslation();
  const rows: { key: string; label: string; axis: AiUsageAxis }[] = [];
  if (!usage.unlimited) {
    if (limited(usage.daily)) {
      rows.push({ key: 'company-daily', label: t('ai.usage.companyDaily'), axis: usage.daily });
    }
    if (limited(usage.monthly)) {
      rows.push({
        key: 'company-monthly',
        label: t('ai.usage.companyMonthly'),
        axis: usage.monthly,
      });
    }
    if (limited(usage.user.daily)) {
      rows.push({ key: 'mine-daily', label: t('ai.usage.mineDaily'), axis: usage.user.daily });
    }
    if (limited(usage.user.monthly)) {
      rows.push({
        key: 'mine-monthly',
        label: t('ai.usage.mineMonthly'),
        axis: usage.user.monthly,
      });
    }
  }
  if (rows.length === 0) {
    return <p className="text-xs text-content-muted">{t('ai.usage.unlimited')}</p>;
  }
  return (
    <dl
      aria-label={t('ai.usage.title')}
      className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]"
    >
      {rows.map((row) => (
        <UsageRow key={row.key} label={row.label} axis={row.axis} />
      ))}
    </dl>
  );
}

function UsageRow({ label, axis }: { label: string; axis: AiUsageAxis }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  const limit = axis.limit ?? 0;
  const spent = axis.used + axis.reserved;
  const empty = axis.remaining !== null && axis.remaining <= 0;
  return (
    <>
      <dt className="font-medium text-content">{label}</dt>
      <dd className={`flex flex-wrap gap-x-2 ${empty ? 'text-danger' : 'text-content-muted'}`}>
        <span className="tabular-nums">
          {t('ai.usage.count', {
            used: formatNumber(spent, { locale }),
            limit: formatNumber(limit, { locale }),
          })}
        </span>
        <span>{t('ai.usage.resets', { time: formatDateTime(axis.resetsAt, { locale }) })}</span>
      </dd>
    </>
  );
}
