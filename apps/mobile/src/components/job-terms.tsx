import type { DeadlineState } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import type { WorkOrderDetail } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { View } from 'react-native';
import { liveDeadlines } from '~/lib/job-terms';
import { formatWhen } from '~/lib/format';
import { Badge, Body, Section } from './ui';

export const DEADLINE_TONE: Record<DeadlineState, 'danger' | 'accent' | 'muted'> = {
  met: 'muted',
  met_late: 'danger',
  missed: 'danger',
  warning: 'accent',
  running: 'muted',
  closed: 'muted',
};

/**
 * What P27 tells the engineer about a job before they start: whether the
 * customer's contract covers it, that it is planned maintenance and for which
 * assets, and its deadlines against the phone's own clock. Read only — the
 * office decides coverage and sets deadlines.
 */
export function JobCoverageBadges({ detail }: { detail: WorkOrderDetail }) {
  const { t } = useTranslation();
  // A job kept from before P27 says nothing about these.
  const { coverage, maintenancePlans } = detail as Partial<WorkOrderDetail>;
  const planned = (maintenancePlans ?? []).length > 0;
  if ((coverage ?? null) === null && !planned) {
    return null;
  }
  return (
    <View style={{ gap: spacing[1] }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] }}>
        {planned ? <Badge label={t('mobile.job.maintenance')} tone="muted" /> : null}
        {coverage == null ? null : (
          <Badge
            label={
              coverage.status === 'covered'
                ? coverage.contract === null
                  ? t('mobile.job.coverage.coveredPlain')
                  : t('mobile.job.coverage.covered', { reference: coverage.contract.reference })
                : t('mobile.job.coverage.chargeable')
            }
            tone={coverage.status === 'covered' ? 'muted' : 'accent'}
          />
        )}
      </View>
      {coverage == null || coverage.status === 'covered' ? null : (
        <Body muted>{t(`mobile.job.coverage.reason.${coverage.reason}`)}</Body>
      )}
    </View>
  );
}

export function JobDeadlines({ detail }: { detail: WorkOrderDetail }) {
  const { t, i18n } = useTranslation();
  const deadlines = liveDeadlines(
    (detail as Partial<WorkOrderDetail>).deadlines ?? null,
    new Date(),
  );
  const plans = (detail as Partial<WorkOrderDetail>).maintenancePlans ?? [];
  if (deadlines.length === 0 && plans.length === 0) {
    return null;
  }
  const when = (value: string) => formatWhen(value, i18n.language);
  return (
    <>
      {deadlines.length === 0 ? null : (
        <Section title={t('mobile.job.deadlines')}>
          {deadlines.map((deadline) => (
            <View
              key={deadline.kind}
              style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}
            >
              <View style={{ flex: 1 }}>
                <Body>
                  {t(`mobile.job.deadline.${deadline.kind}`, { when: when(deadline.dueAt) })}
                </Body>
              </View>
              <Badge
                label={t(`mobile.job.deadline.state.${deadline.state}`)}
                tone={DEADLINE_TONE[deadline.state]}
              />
            </View>
          ))}
        </Section>
      )}
      {plans.length === 0 ? null : (
        <Section title={t('mobile.job.maintenance')}>
          {plans.map((plan) => (
            <Body key={plan.planId}>
              {t('mobile.job.maintenanceLine', { plan: plan.title, asset: plan.asset.name })}
            </Body>
          ))}
        </Section>
      )}
    </>
  );
}
