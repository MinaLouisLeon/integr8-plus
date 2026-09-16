'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Badge, Panel } from '~/components/platform-bits';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { formatBytes } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

type Plan = 'trial' | 'starter' | 'standard' | 'enterprise';

/**
 * What each plan allows (P16).
 *
 * Editable here rather than in a deploy, because a limit that needs an engineer
 * to change it is a limit somebody works around by not setting one. Changing a
 * number takes effect for every company on that plan within the minute the
 * API's cache allows.
 *
 * Plan definitions in full — seats, forms, submissions, modules — are P17. This
 * is the storage half, which is the half that costs money the moment it is
 * wrong.
 */
export default function PlansPage() {
  const { t } = useTranslation();

  const plans = useQuery({
    queryKey: ['platform', 'plans'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/plans');
      return data?.items ?? [];
    },
  });

  if (plans.isPending) {
    return <LoadingState />;
  }

  if (plans.isError) {
    return (
      <ErrorState
        requestId={plans.error instanceof ApiRequestError ? plans.error.requestId : undefined}
        onRetry={() => void plans.refetch()}
      />
    );
  }

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.plans.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.plans.subtitle')}</p>
      </header>

      {plans.data.map((plan) => (
        <PlanRow key={plan.plan} plan={plan} />
      ))}
    </main>
  );
}

interface Allowance {
  plan: Plan;
  storageBytes: number | null;
  retentionDays: number | null;
  overage: 'block' | 'allow';
  warnAtPercent: number;
}

function PlanRow({ plan }: { plan: Allowance }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [editing, setEditing] = useState(false);

  // Gigabytes in the form, bytes on the wire: nobody types 107374182400.
  const [gigabytes, setGigabytes] = useState(
    plan.storageBytes === null ? '' : String(plan.storageBytes / 1_000_000_000),
  );
  const [retentionDays, setRetentionDays] = useState(
    plan.retentionDays === null ? '' : String(plan.retentionDays),
  );
  const [overage, setOverage] = useState<'block' | 'allow'>(plan.overage);
  const [warnAtPercent, setWarnAtPercent] = useState(String(plan.warnAtPercent));

  const save = useMutation({
    mutationFn: async () => {
      await platformClient().PATCH('/v1/platform/plans/{plan}', {
        params: { path: { plan: plan.plan } },
        body: {
          storageBytes:
            gigabytes.trim() === '' ? null : Math.round(Number(gigabytes) * 1_000_000_000),
          retentionDays: retentionDays.trim() === '' ? null : Number(retentionDays),
          overage,
          warnAtPercent: Number(warnAtPercent),
        },
      });
    },
    onSuccess: () => {
      setEditing(false);
      void queries.invalidateQueries({ queryKey: ['platform', 'plans'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  if (!editing) {
    return (
      <Panel
        title={plan.plan}
        actions={
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {t('platform.plans.edit')}
          </Button>
        }
      >
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Fact
            label={t('platform.plans.storage')}
            value={
              plan.storageBytes === null
                ? t('platform.plans.uncapped')
                : formatBytes(plan.storageBytes)
            }
          />
          <Fact
            label={t('platform.plans.retention')}
            value={
              plan.retentionDays === null
                ? t('platform.plans.retentionForever')
                : t('platform.plans.retentionDays', { count: plan.retentionDays })
            }
          />
          <div className="flex flex-col gap-0.5">
            <dt className="text-content-muted">{t('platform.plans.overage')}</dt>
            <dd>
              <Badge tone={plan.overage === 'block' ? 'warning' : 'muted'}>
                {plan.overage === 'block'
                  ? t('platform.plans.overageBlock')
                  : t('platform.plans.overageAllow')}
              </Badge>
            </dd>
          </div>
          <Fact label={t('platform.plans.warnAt')} value={`${String(plan.warnAtPercent)}%`} />
        </dl>
      </Panel>
    );
  }

  return (
    <Panel title={plan.plan}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={`${t('platform.plans.storage')} (GB)`}
            hint={t('platform.plans.uncappedHint')}
            type="number"
            min={1}
            value={gigabytes}
            onChange={(event) => setGigabytes(event.target.value)}
          />
          <Field
            label={t('platform.plans.retention')}
            hint={t('platform.plans.retentionForever')}
            type="number"
            min={1}
            value={retentionDays}
            onChange={(event) => setRetentionDays(event.target.value)}
          />
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-content">{t('platform.plans.overage')}</span>
            <select
              value={overage}
              onChange={(event) => setOverage(event.target.value as 'block' | 'allow')}
              className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
            >
              <option value="block">{t('platform.plans.overageBlock')}</option>
              <option value="allow">{t('platform.plans.overageAllow')}</option>
            </select>
          </label>
          <Field
            label={`${t('platform.plans.warnAt')} (%)`}
            type="number"
            min={1}
            max={100}
            value={warnAtPercent}
            onChange={(event) => setWarnAtPercent(event.target.value)}
            {...(save.isError ? { error: messageForError(save.error, t) } : {})}
          />
        </div>

        <div className="flex gap-2">
          <Button type="submit" busy={save.isPending}>
            {t('platform.plans.save')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-content-muted">{label}</dt>
      <dd className="font-medium text-content">{value}</dd>
    </div>
  );
}
