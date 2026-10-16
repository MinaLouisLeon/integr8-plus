'use client';

import { ApiRequestError } from '@integr8/api-client';
import { aiLevelAtLeast } from '@integr8/core';
import {
  formatCurrency,
  formatList,
  formatNumber,
  formatPercent,
  type TFunction,
  useTranslation,
} from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  AiPolicyEditor,
  AiPolicySummary,
  draftFromPolicy,
  draftIsValid,
  levelLabel,
  policyFromDraft,
  type AiPolicyDraft,
  type AiPolicyFields,
} from '~/components/ai-policy-editor';
import { Badge, Panel } from '~/components/platform-bits';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { formatBytes } from '~/lib/platform-format';
import { planLabel } from '~/lib/plans';
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

  // What each plan allows of the assistant (ADR-0001 D1): its own request,
  // because it is its own table and its own version number.
  const aiPlans = useQuery({
    queryKey: ['platform', 'ai', 'plans'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/ai/plans');
      return data;
    },
  });

  if (plans.isPending || aiPlans.isPending) {
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

  if (aiPlans.isError || aiPlans.data === undefined) {
    return (
      <ErrorState
        requestId={aiPlans.error instanceof ApiRequestError ? aiPlans.error.requestId : undefined}
        onRetry={() => void aiPlans.refetch()}
      />
    );
  }

  const ai = aiPlans.data;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.plans.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.plans.subtitle')}</p>
      </header>

      <div
        className={`flex flex-col gap-1 rounded-md px-3 py-2 text-sm ${
          ai.globalEnabled ? 'bg-surface-muted text-content' : 'bg-warning-subtle text-warning'
        }`}
      >
        <p>{ai.globalEnabled ? t('platform.ai.globalOn') : t('platform.ai.globalOff')}</p>
        <p>{t('platform.ai.maxLevelServed', { level: levelLabel(t, ai.maxLevelServed) })}</p>
      </div>

      <ProviderPanel />

      {plans.data.map((plan) => {
        const aiPolicy = ai.items.find((item) => item.plan === plan.plan);
        return (
          <div key={plan.plan} className="flex flex-col gap-3">
            <PlanRow plan={plan} />
            {aiPolicy === undefined ? null : (
              <AiPlanRow
                key={`${aiPolicy.plan}:${String(aiPolicy.version)}`}
                policy={aiPolicy}
                maxLevelServed={ai.maxLevelServed}
              />
            )}
          </div>
        );
      })}
    </main>
  );
}

interface Allowance {
  plan: Plan;
  storageBytes: number | null;
  retentionDays: number | null;
  overage: 'block' | 'allow';
  warnAtPercent: number;
  /** What the plan allows and costs (P17). */
  seats: number | null;
  submissionsPerMonth: number | null;
  priceCents: number | null;
  currency: string | null;
  providerPriceMonthly: string | null;
  providerPriceYearly: string | null;
}

function PlanRow({ plan }: { plan: Allowance }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
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
  const [seats, setSeats] = useState(plan.seats === null ? '' : String(plan.seats));
  const [submissions, setSubmissions] = useState(
    plan.submissionsPerMonth === null ? '' : String(plan.submissionsPerMonth),
  );
  // Whole units in the form, minor units on the wire: nobody types 4900.
  const [price, setPrice] = useState(plan.priceCents === null ? '' : String(plan.priceCents / 100));
  const [currency, setCurrency] = useState(plan.currency ?? '');
  const [priceMonthly, setPriceMonthly] = useState(plan.providerPriceMonthly ?? '');
  const [priceYearly, setPriceYearly] = useState(plan.providerPriceYearly ?? '');

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
          seats: seats.trim() === '' ? null : Number(seats),
          submissionsPerMonth: submissions.trim() === '' ? null : Number(submissions),
          // The two travel together — the database refuses one without the
          // other, because a price with no currency is a number nobody can
          // render.
          priceCents: price.trim() === '' ? null : Math.round(Number(price) * 100),
          currency: price.trim() === '' ? null : currency.trim().toUpperCase(),
          providerPriceMonthly: priceMonthly.trim() === '' ? null : priceMonthly.trim(),
          providerPriceYearly: priceYearly.trim() === '' ? null : priceYearly.trim(),
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
        title={planLabel(t, plan.plan)}
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
          <Fact
            label={t('platform.plans.warnAt')}
            value={formatPercent(plan.warnAtPercent / 100, { locale })}
          />
          <Fact
            label={t('platform.plans.seats')}
            value={plan.seats === null ? t('platform.plans.uncapped') : String(plan.seats)}
          />
          <Fact
            label={t('platform.plans.submissions')}
            value={
              plan.submissionsPerMonth === null
                ? t('platform.plans.uncapped')
                : String(plan.submissionsPerMonth)
            }
          />
          <Fact
            label={t('platform.plans.price')}
            value={
              plan.priceCents === null
                ? t('platform.plans.unpriced')
                : plan.currency === null
                  ? String(plan.priceCents / 100)
                  : formatCurrency(plan.priceCents / 100, plan.currency, { locale })
            }
          />
          {/*
            A plan with no provider price cannot be bought, and the checkout
            says so rather than sending somebody to a page that fails. Shown
            here so it is fixed before a customer finds it.
          */}
          <Fact
            label={t('platform.plans.providerPriceMonthly')}
            value={plan.providerPriceMonthly ?? t('platform.plans.unpriced')}
          />
        </dl>
      </Panel>
    );
  }

  return (
    <Panel title={planLabel(t, plan.plan)}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('platform.plans.storageGb')}
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
            label={t('platform.plans.warnAtPercent')}
            type="number"
            min={1}
            max={100}
            value={warnAtPercent}
            onChange={(event) => setWarnAtPercent(event.target.value)}
          />
          <Field
            label={t('platform.plans.seats')}
            hint={t('platform.plans.uncappedHint')}
            type="number"
            min={1}
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
          />
          <Field
            label={t('platform.plans.submissions')}
            hint={t('platform.plans.uncappedHint')}
            type="number"
            min={1}
            value={submissions}
            onChange={(event) => setSubmissions(event.target.value)}
          />
          <Field
            label={t('platform.plans.price')}
            hint={t('platform.plans.priceHint')}
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          <Field
            label={t('platform.plans.currency')}
            maxLength={3}
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          />
          <Field
            label={t('platform.plans.providerPriceMonthly')}
            hint={t('platform.plans.providerPriceHint')}
            value={priceMonthly}
            onChange={(event) => setPriceMonthly(event.target.value)}
          />
          <Field
            label={t('platform.plans.providerPriceYearly')}
            value={priceYearly}
            onChange={(event) => setPriceYearly(event.target.value)}
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

interface AiPlanPolicy extends AiPolicyFields {
  plan: Plan;
  version: number;
  updatedAt: string;
}

/**
 * What a plan allows of the assistant (ADR-0001 D1).
 *
 * Saved whole with the version that was read: two people editing the same
 * plan get a 409 for the second, not a silent merge of half of each. The row
 * is keyed by version above, so a save that succeeds re-reads into a fresh
 * form rather than keeping stale state.
 */
function AiPlanRow({
  policy,
  maxLevelServed,
}: {
  policy: AiPlanPolicy;
  maxLevelServed: AiPolicyFields['level'];
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AiPolicyDraft>(() => draftFromPolicy(policy));
  const [reason, setReason] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      await platformClient().PUT('/v1/platform/ai/plans/{plan}', {
        params: { path: { plan: policy.plan } },
        body: {
          policy: policyFromDraft(draft),
          expectedVersion: policy.version,
          reason: reason.trim() === '' ? null : reason.trim(),
        },
      });
    },
    onSuccess: () => {
      setEditing(false);
      setReason('');
      void queries.invalidateQueries({ queryKey: ['platform', 'ai', 'plans'] });
    },
  });

  const title = t('platform.ai.planTitle', { plan: planLabel(t, policy.plan) });
  const aboveServed =
    !aiLevelAtLeast(maxLevelServed, policy.level) && policy.level !== 'off' ? (
      <p className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
        {t('platform.ai.levelAboveServed', {
          configured: levelLabel(t, policy.level),
          served: levelLabel(t, maxLevelServed),
        })}
      </p>
    ) : null;

  if (!editing) {
    return (
      <Panel
        title={title}
        description={t('platform.ai.planDescription')}
        actions={
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(draftFromPolicy(policy));
              setEditing(true);
            }}
          >
            {t('platform.ai.change')}
          </Button>
        }
      >
        {aboveServed}
        <AiPolicySummary policy={policy} />
      </Panel>
    );
  }

  return (
    <Panel title={title} description={t('platform.ai.planDescription')}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        {aboveServed}
        <AiPolicyEditor draft={draft} onChange={setDraft} disabled={save.isPending} />
        <Field
          label={t('platform.ai.reason')}
          hint={t('platform.ai.reasonHint')}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          {...(save.isError ? { error: messageForError(save.error, t) } : {})}
        />
        <div className="flex gap-2">
          <Button type="submit" busy={save.isPending} disabled={!draftIsValid(draft, t)}>
            {t('platform.ai.save')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

type ModelLevel = 'help' | 'insights' | 'agent';

const MODEL_LEVELS: readonly ModelLevel[] = ['agent', 'insights', 'help'];

/**
 * Which AI provider answers, and whether it can (ADR-0002 D2, D3, D8).
 *
 * Here, beside the plans, because a plan that allows the assistant is worth
 * nothing while the provider is not ready, and this is where somebody looks
 * first when a company says it has gone. The problems are the server's own
 * sentences, written for whoever holds the deployment's settings, so they are
 * shown as they come. Provider and model names are for Integr8's eyes only;
 * no company screen ever shows them. `AI_PROVIDER=none` is no provider by
 * choice: every company is answered from the help library (ADR-0002 D12), so
 * the panel says so instead of listing models.
 */
function ProviderPanel() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const providers = useQuery({
    queryKey: ['platform', 'ai', 'providers'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/ai/providers');
      return data;
    },
  });

  if (providers.isPending) {
    return (
      <Panel title={t('platform.ai.provider.title')}>
        <LoadingState />
      </Panel>
    );
  }
  if (providers.isError || providers.data === undefined) {
    return (
      <Panel title={t('platform.ai.provider.title')}>
        <ErrorState
          requestId={
            providers.error instanceof ApiRequestError ? providers.error.requestId : undefined
          }
          onRetry={() => void providers.refetch()}
        />
      </Panel>
    );
  }

  const data = providers.data;
  const yes = t('platform.ai.provider.yes');
  const no = t('platform.ai.provider.no');

  return (
    <Panel
      title={t('platform.ai.provider.title')}
      description={t('platform.ai.provider.description')}
    >
      {data.creditPauseSeconds === null ? null : (
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {t('platform.ai.provider.creditPaused', {
            seconds: formatNumber(data.creditPauseSeconds, { locale }),
          })}
        </p>
      )}
      {data.libraryOnly ? (
        <p className="text-sm text-content">{t('platform.ai.provider.libraryOnly')}</p>
      ) : null}
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <Fact label={t('platform.ai.provider.active')} value={providerLabel(t, data.active)} />
        {data.libraryOnly ? null : (
          <div className="flex flex-col gap-0.5">
            <dt className="text-content-muted">{t('platform.ai.provider.state')}</dt>
            <dd>
              <Badge tone={data.ready ? 'ok' : 'danger'}>
                {data.ready ? t('platform.ai.provider.ready') : t('platform.ai.provider.notReady')}
              </Badge>
            </dd>
          </div>
        )}
        <Fact
          label={t('platform.ai.provider.served')}
          value={
            data.servedLevels.length === 0
              ? t('platform.ai.provider.servedNone')
              : formatList(
                  data.servedLevels.map((level) => levelLabel(t, level)),
                  { locale },
                )
          }
        />
      </dl>

      {data.problems.length === 0 ? null : (
        <div className="flex flex-col gap-1 text-sm">
          <h3 className="font-semibold text-content">{t('platform.ai.provider.problems')}</h3>
          <ul className="flex list-disc flex-col gap-0.5 ps-5 text-content">
            {data.problems.map((problem) => (
              // The server's own words, in English: marked so a reader set to Arabic hears them right.
              <li key={problem} lang="en" dir="ltr" className="text-start">
                {problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.libraryOnly ? null : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-content-muted">
                  <th scope="col" className="py-1 text-start">
                    {t('platform.ai.level')}
                  </th>
                  <th scope="col" className="py-1 text-start">
                    {t('platform.ai.provider.model')}
                  </th>
                  <th scope="col" className="py-1 text-start">
                    {t('platform.ai.provider.priceListed')}
                  </th>
                  <th scope="col" className="py-1 text-start">
                    {t('platform.ai.provider.cachedPriced')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {MODEL_LEVELS.map((level) => {
                  const price = data.prices[level];
                  const model = data.models[level];
                  return (
                    <tr key={level} className="border-b border-border-subtle">
                      <td className="py-1">{levelLabel(t, level)}</td>
                      <td className="py-1" dir="ltr">
                        {model ?? t('platform.ai.provider.noModel')}
                      </td>
                      <td className="py-1">
                        <Badge tone={price.listed ? 'ok' : model === null ? 'muted' : 'warning'}>
                          {price.listed ? yes : no}
                        </Badge>
                      </td>
                      <td className="py-1">
                        <Badge tone={price.cachedInputPriced ? 'ok' : 'muted'}>
                          {price.cachedInputPriced ? yes : no}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-content-muted">{t('platform.ai.provider.pricesNote')}</p>
        </>
      )}
    </Panel>
  );
}

function providerLabel(
  t: TFunction,
  provider: 'none' | 'recording' | 'groq' | 'gemini' | 'anthropic' | 'openai',
): string {
  switch (provider) {
    case 'none':
      return t('platform.ai.provider.none');
    case 'recording':
      return t('platform.ai.provider.recording');
    case 'groq':
      return 'Groq';
    case 'gemini':
      return 'Gemini';
    case 'anthropic':
      return 'Anthropic';
    case 'openai':
      return 'OpenAI';
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-content-muted">{label}</dt>
      <dd className="font-medium text-content">{value}</dd>
    </div>
  );
}
