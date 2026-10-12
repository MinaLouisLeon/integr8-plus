import { formatCalendarDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { keys, useOperations } from '../api.js';
import { BackLink, buttonClass, cardClass, Field, inputClass, Loading } from '../ui.js';
import {
  AppLink,
  ManufacturingFailure,
  ManufacturingGate,
  useManufacturingSeat,
} from './manufacturing-parts.js';

/**
 * Material planning (seventh round; ADR-0011): the recent runs, and — for
 * those who keep manufacturing — running a new one for the coming days.
 */
export function MaterialPlanListScreen() {
  return (
    <ManufacturingGate>
      <MaterialPlanList />
    </ManufacturingGate>
  );
}

const isHorizon = (text: string) =>
  /^\d{1,3}$/u.test(text) && Number(text) >= 1 && Number(text) <= 365;

function MaterialPlanList() {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const seat = useManufacturingSeat();
  const [horizon, setHorizon] = useState('30');

  const plans = useQuery({
    queryKey: keys.materialPlans,
    queryFn: async () =>
      (await client.GET('/v1/manufacturing/plans', { params: { query: { limit: 20 } } })).data!
        .items,
  });
  // One key per horizon asked for, so a retry replays rather than plans twice.
  const idempotencyKey = useMemo(() => (horizon === '' ? '' : crypto.randomUUID()), [horizon]);
  const run = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/manufacturing/plans', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { horizonDays: Number(horizon) },
        })
      ).data!,
    onSuccess: async (plan) => {
      queries.setQueryData(keys.materialPlan(plan.id), plan);
      await queries.invalidateQueries({ queryKey: keys.materialPlans });
      navigate(paths.materialPlan(plan.id));
    },
  });

  return (
    <div className="flex flex-col gap-6 text-start">
      <BackLink
        to={paths.inventory}
        label={t('nav.backTo', { title: t('inventory.overview.title') })}
      />
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('manufacturing.plans.title')}</h1>
        <p className="max-w-prose text-sm text-content-muted">{t('manufacturing.plans.intro')}</p>
      </header>

      {seat.manage ? (
        <form
          aria-label={t('manufacturing.plans.run')}
          className={`${cardClass} sm:flex-row sm:items-end`}
          onSubmit={(event) => {
            event.preventDefault();
            if (isHorizon(horizon)) {
              run.mutate();
            }
          }}
        >
          <Field
            label={t('manufacturing.plans.horizon')}
            hint={t('manufacturing.plans.horizonHint')}
            className="sm:w-48"
          >
            {(id, describedBy) => (
              <input
                id={id}
                required
                inputMode="numeric"
                dir="ltr"
                pattern="\d{1,3}"
                aria-describedby={describedBy}
                className={inputClass}
                value={horizon}
                onChange={(event) => setHorizon(event.target.value.trim())}
              />
            )}
          </Field>
          <button
            type="submit"
            className={buttonClass.primary}
            disabled={!isHorizon(horizon) || run.isPending}
          >
            {run.isPending ? t('manufacturing.plans.running') : t('manufacturing.plans.run')}
          </button>
        </form>
      ) : null}
      {run.isError ? <ManufacturingFailure error={run.error} /> : null}

      <section aria-labelledby="manufacturing-plans" className="flex flex-col gap-3">
        <h2 id="manufacturing-plans" className="text-base font-semibold text-content">
          {t('manufacturing.plans.recent')}
        </h2>
        {plans.isPending ? (
          <Loading />
        ) : plans.isError ? (
          <ManufacturingFailure error={plans.error} onRetry={() => void plans.refetch()} />
        ) : plans.data.length === 0 ? (
          <p className="py-8 text-center text-sm text-content-muted">
            {t('manufacturing.plans.empty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface">
            {plans.data.map((plan) => (
              <li
                key={plan.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <AppLink
                  to={paths.materialPlan(plan.id)}
                  className="font-medium text-accent underline-offset-4 hover:underline"
                >
                  {t('manufacturing.plans.upTo', {
                    date: formatCalendarDate(plan.horizonEnd, { locale }),
                  })}
                </AppLink>
                <span className="text-sm text-content-muted">
                  {t('manufacturing.plans.runBy', {
                    name: plan.runBy.name,
                    date: formatDateTime(plan.runAt, { locale }),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
