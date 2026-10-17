'use client';

import { ApiRequestError } from '@integr8/api-client';
import {
  aiLevelAtLeast,
  quotaModeHasDaily,
  quotaModeHasMonthly,
  type Role,
  ROLES,
} from '@integr8/core';
import { formatNumber, formatPercent, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useId, useState } from 'react';
import {
  AiPolicyEditor,
  AiPolicySummary,
  draftFromPolicy,
  draftIsValid,
  formatMicrousd,
  levelLabel,
  pickPolicyFields,
  policyFromDraft,
  type AiPolicyDraft,
  type AiPolicyFields,
} from '~/components/ai-policy-editor';
import { Badge, Panel, StatusBadge } from '~/components/platform-bits';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import {
  formatMicrousdPrecise,
  microsToUsdInput,
  parseSharePercent,
  parseUsdToMicros,
  unassignedFromRefusal,
} from '~/lib/ai-shares';
import { messageForError } from '~/lib/errors';
import { formatBytes, formatDate, formatDuration, formatWhen } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';
import { planLabel } from '~/lib/plans';
import { WebsiteKeysPanel } from './website-keys';

/**
 * One company, and everything you can do to it (P15).
 *
 * The screen a support conversation happens on: what they have, what they have
 * been doing, what has been failing, who to act as, and — at the bottom, on
 * purpose — how to stop serving them and how to close them.
 *
 * The destructive things are last and each asks for a reason in words. That
 * reason is not a formality: it is written to an audit log nobody can edit, and
 * it is the sentence somebody reads a year later trying to understand what
 * happened.
 */
export default function CompanyPage() {
  const { t } = useTranslation();
  const params = useParams<{ tenantId: string }>();
  const tenantId = params.tenantId;

  const company = useQuery({
    queryKey: ['platform', 'company', tenantId],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/companies/{tenantId}', {
        params: { path: { tenantId } },
      });
      return data;
    },
  });

  if (company.isPending) {
    return <LoadingState />;
  }

  if (company.isError || company.data === undefined) {
    return (
      <ErrorState
        requestId={company.error instanceof ApiRequestError ? company.error.requestId : undefined}
        onRetry={() => void company.refetch()}
      />
    );
  }

  const detail = company.data;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{detail.name}</h1>
          <p className="font-mono text-xs text-content-muted">{detail.slug}</p>
        </div>
        <StatusBadge status={detail.status} deletionScheduledFor={detail.deletionScheduledFor} />
      </header>

      {detail.status === 'suspended' && detail.suspendedReason !== null ? (
        <p className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
          {t('platform.suspend.suspendedSince', {
            when: formatDate(detail.suspendedAt),
            reason: detail.suspendedReason,
          })}
        </p>
      ) : null}

      <Panel title={t('platform.company.overview')}>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Fact label={t('platform.companies.plan')} value={detail.plan} />
          <Fact
            label={t('platform.companies.seats')}
            value={
              detail.seats === null
                ? t('platform.companies.uncapped')
                : t('platform.companies.seatsUsed', {
                    used: detail.activeMembers,
                    total: detail.seats,
                  })
            }
          />
          <Fact label={t('platform.companies.storage')} value={formatBytes(detail.storageBytes)} />
          <Fact label={t('platform.companies.created')} value={formatDate(detail.createdAt)} />
        </dl>
      </Panel>

      <PlanPanel
        tenantId={tenantId}
        plan={detail.plan}
        seats={detail.seats}
        billingMode={detail.billingMode}
      />
      <InvitationsPanel tenantId={tenantId} invitations={detail.invitations} />
      <AppsPanel tenantId={tenantId} settings={detail.settings} />
      <AiPanel tenantId={tenantId} />
      <WebsiteKeysPanel tenantId={tenantId} />
      <AiMembersPanel tenantId={tenantId} />
      <BillingPanel billing={detail.billing} />

      <Panel title={t('platform.company.people')}>
        {detail.owners.length === 0 ? (
          <p className="text-sm text-content-muted">{t('platform.companies.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.owners.map((owner) => (
              <li key={owner.userId} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-content">{owner.email}</span>
                <Badge tone="muted">{owner.role}</Badge>
                {owner.status === 'active' ? null : <Badge tone="warning">{owner.status}</Badge>}
                <ImpersonateButton tenantId={tenantId} userId={owner.userId} name={owner.email} />
                <UnlockButton tenantId={tenantId} userId={owner.userId} />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={t('platform.company.activity')}>
        {detail.activity.length === 0 ? (
          <p className="text-sm text-content-muted">{t('platform.company.noActivity')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-content-muted">
                  <th scope="col" className="py-1 text-start">
                    {t('platform.company.month')}
                  </th>
                  <th scope="col" className="py-1 text-end">
                    {t('platform.company.jobs')}
                  </th>
                  <th scope="col" className="py-1 text-end">
                    {t('platform.company.submissions')}
                  </th>
                  <th scope="col" className="py-1 text-end">
                    {t('platform.company.activeUsers')}
                  </th>
                  <th scope="col" className="py-1 text-end">
                    {t('platform.company.auditedActions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.activity.map((month) => (
                  <tr key={month.month} className="border-b border-border-subtle">
                    <td className="py-1">{month.month}</td>
                    <td className="py-1 text-end tabular-nums">{month.jobs}</td>
                    <td className="py-1 text-end tabular-nums">{month.submissions}</td>
                    <td className="py-1 text-end tabular-nums">{month.activeUsers}</td>
                    <td className="py-1 text-end tabular-nums">{month.auditedActions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <CompanyFlags tenantId={tenantId} flags={detail.featureFlags} />
      <Impersonations tenantId={tenantId} />
      <RecentErrors tenantId={tenantId} />
      <SupportActions tenantId={tenantId} />
      <Lifecycle tenantId={tenantId} name={detail.name} status={detail.status} />
    </main>
  );
}

/**
 * The plan the API enforces, and how the company pays for it.
 *
 * Two modes. `invoiced`: Integr8 bills the company directly, so what is set
 * here is the whole truth — no trial, no checkout, no card portal, and the
 * company's billing screen says "invoiced by Integr8". `self_serve`: the
 * company pays in the app, and the plan here is what they are entitled to
 * while the provider owns status, period and dunning.
 */
function PlanPanel({
  tenantId,
  plan,
  seats,
  billingMode,
}: {
  tenantId: string;
  plan: string;
  seats: number | null;
  billingMode: 'self_serve' | 'invoiced';
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [draftPlan, setDraftPlan] = useState(plan);
  const [draftSeats, setDraftSeats] = useState(seats === null ? '' : String(seats));
  const [draftMode, setDraftMode] = useState<'self_serve' | 'invoiced'>(billingMode);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const save = useMutation({
    mutationFn: async () => {
      await platformClient().PATCH('/v1/platform/companies/{tenantId}/plan', {
        params: { path: { tenantId } },
        body: {
          plan: draftPlan as 'trial' | 'starter' | 'standard' | 'enterprise',
          seats: draftSeats.trim() === '' ? null : Number(draftSeats),
          billingMode: draftMode,
        },
      });
    },
    onSuccess: () => {
      setProblem(undefined);
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId] });
      void queries.invalidateQueries({ queryKey: ['platform', 'companies'] });
    },
    onError: (error) => {
      setProblem(messageForError(error, t));
    },
  });

  const unchanged =
    draftPlan === plan &&
    draftMode === billingMode &&
    (draftSeats.trim() === '' ? null : Number(draftSeats)) === seats;

  return (
    <Panel title={t('platform.plan.title')} description={t('platform.plan.description')}>
      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-content">{t('platform.plan.mode')}</span>
          <select
            value={draftMode}
            onChange={(event) => setDraftMode(event.target.value as 'self_serve' | 'invoiced')}
            className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
          >
            <option value="invoiced">{t('platform.billingMode.invoiced')}</option>
            <option value="self_serve">{t('platform.billingMode.self_serve')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-content">{t('platform.plan.plan')}</span>
          <select
            value={draftPlan}
            onChange={(event) => setDraftPlan(event.target.value)}
            className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
          >
            <option value="trial">trial</option>
            <option value="starter">starter</option>
            <option value="standard">standard</option>
            <option value="enterprise">enterprise</option>
          </select>
        </label>
        <Field
          label={t('platform.plan.seats')}
          hint={t('platform.plan.seatsHint')}
          type="number"
          min={1}
          value={draftSeats}
          onChange={(event) => setDraftSeats(event.target.value)}
        />
        <Button type="submit" busy={save.isPending} disabled={unchanged}>
          {save.isPending ? t('platform.plan.saving') : t('platform.plan.save')}
        </Button>
        {save.isSuccess && unchanged ? (
          <span className="text-sm text-content-muted">{t('platform.plan.saved')}</span>
        ) : null}
        {problem === undefined ? null : (
          <span role="alert" className="text-sm text-danger">
            {problem}
          </span>
        )}
      </form>
    </Panel>
  );
}

/**
 * Who has been invited and not joined yet — the owner, straight after
 * onboarding — and the two ways to get them in.
 *
 * Onboarding does not email the owner by default: Integr8 sets the company up
 * first, and invites the owner from here once there is something to log in to.
 * Either action makes a fresh seven-day link and stops the old one working, so
 * an invitation that expired while the forms were being built is no obstacle.
 */
function InvitationsPanel({
  tenantId,
  invitations,
}: {
  tenantId: string;
  invitations: {
    id: string;
    email: string;
    role: string;
    expiresAt: string;
    expired: boolean;
  }[];
}) {
  const { t } = useTranslation();

  return (
    <Panel
      title={t('platform.invitations.title')}
      description={t('platform.invitations.description')}
    >
      {invitations.length === 0 ? (
        <p className="text-sm text-content-muted">{t('platform.invitations.none')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {invitations.map((invitation) => (
            <InvitationRow key={invitation.id} tenantId={tenantId} invitation={invitation} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function InvitationRow({
  tenantId,
  invitation,
}: {
  tenantId: string;
  invitation: { id: string; email: string; role: string; expiresAt: string; expired: boolean };
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [notice, setNotice] = useState<{ tone: 'ok' | 'problem'; text: string } | undefined>(
    undefined,
  );

  const reissue = useMutation({
    mutationFn: async (sendEmail: boolean) => {
      const { data } = await platformClient().POST(
        '/v1/platform/companies/{tenantId}/invitations/{invitationId}/resend',
        {
          params: { path: { tenantId, invitationId: invitation.id } },
          body: { sendEmail },
        },
      );
      return { data, sendEmail };
    },
    onSuccess: async ({ data, sendEmail }) => {
      if (data === undefined) {
        return;
      }
      if (sendEmail) {
        setNotice(
          data.emailed
            ? { tone: 'ok', text: t('platform.invitations.sent', { email: data.email }) }
            : {
                tone: 'problem',
                text: t('platform.invitations.failed', { problem: data.emailProblem ?? '' }),
              },
        );
      } else if (data.acceptUrl !== null) {
        await navigator.clipboard.writeText(data.acceptUrl);
        setNotice({ tone: 'ok', text: t('platform.invitations.copied') });
      }
      // The invitation was replaced: the list now names the new one.
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId] });
    },
    onError: (error) => {
      setNotice({ tone: 'problem', text: messageForError(error, t) });
    },
  });

  const role = (ROLES as readonly string[]).includes(invitation.role)
    ? t(`workspace.role.${invitation.role as Role}`)
    : invitation.role;

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border-subtle p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium text-content">{invitation.email}</span>
        <Badge tone="muted">{role}</Badge>
        {invitation.expired ? (
          <Badge tone="warning">
            {t('platform.invitations.expired', { date: formatDate(invitation.expiresAt) })}
          </Badge>
        ) : (
          <span className="text-content-muted">
            {t('platform.invitations.waiting', { date: formatDate(invitation.expiresAt) })}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          busy={reissue.isPending && reissue.variables}
          disabled={reissue.isPending}
          onClick={() => reissue.mutate(true)}
        >
          {reissue.isPending && reissue.variables
            ? t('platform.invitations.sending')
            : t('platform.invitations.send')}
        </Button>
        <Button
          variant="secondary"
          busy={reissue.isPending && !reissue.variables}
          disabled={reissue.isPending}
          onClick={() => reissue.mutate(false)}
        >
          {t('platform.invitations.copyLink')}
        </Button>
        {notice === undefined ? null : (
          <span
            role={notice.tone === 'problem' ? 'alert' : 'status'}
            className={notice.tone === 'problem' ? 'text-danger' : 'text-content-muted'}
          >
            {notice.text}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * The company's website and whether its own apps are built (0022).
 *
 * The two brand facts the dashboard owns. The rest of the look is set from the
 * desktop app while acting as the company, where it can be previewed on the
 * real screens; here it is only reported, so whoever onboards a company can see
 * whether that step has been done.
 */
function AppsPanel({
  tenantId,
  settings,
}: {
  tenantId: string;
  settings: {
    websiteUrl: string | null;
    appsEnabled: boolean;
    brandColour: string | null;
    logoMediaId: string | null;
    aiWebEnabled: boolean;
    aiDesktopEnabled: boolean;
    aiMobileEnabled: boolean;
  };
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [website, setWebsite] = useState(settings.websiteUrl ?? '');
  const [appsEnabled, setAppsEnabled] = useState(settings.appsEnabled);
  // Where the assistant appears for this company (ADR-0001 D6). Each app is
  // its own switch: a company can have it on the desktop and off the phones.
  const [aiWeb, setAiWeb] = useState(settings.aiWebEnabled);
  const [aiDesktop, setAiDesktop] = useState(settings.aiDesktopEnabled);
  const [aiMobile, setAiMobile] = useState(settings.aiMobileEnabled);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const websiteOk = website.trim() === '' || /^https:\/\/\S+$/u.test(website.trim());
  const unchanged =
    (website.trim() === '' ? null : website.trim()) === settings.websiteUrl &&
    appsEnabled === settings.appsEnabled &&
    aiWeb === settings.aiWebEnabled &&
    aiDesktop === settings.aiDesktopEnabled &&
    aiMobile === settings.aiMobileEnabled;

  const save = useMutation({
    mutationFn: async () => {
      await platformClient().PATCH('/v1/platform/companies/{tenantId}/settings', {
        params: { path: { tenantId } },
        body: {
          websiteUrl: website.trim() === '' ? null : website.trim(),
          appsEnabled,
          aiWebEnabled: aiWeb,
          aiDesktopEnabled: aiDesktop,
          aiMobileEnabled: aiMobile,
        },
      });
    },
    onSuccess: () => {
      setProblem(undefined);
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId] });
    },
    onError: (error) => {
      setProblem(messageForError(error, t));
    },
  });

  return (
    <Panel title={t('platform.apps.title')} description={t('platform.apps.description')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          <Field
            label={t('platform.apps.website')}
            hint={t('platform.apps.websiteHint')}
            type="url"
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            {...(websiteOk ? {} : { error: t('platform.onboard.websiteInvalid') })}
          />
          <label className="flex items-center gap-2 pb-2 text-sm text-content">
            <input
              type="checkbox"
              checked={appsEnabled}
              onChange={(event) => setAppsEnabled(event.target.checked)}
            />
            {t('platform.apps.buildApps')}
          </label>
        </div>
        <p className="text-xs text-content-muted">{t('platform.apps.buildAppsHint')}</p>
        <div className="flex flex-wrap items-center gap-4 text-sm text-content">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={aiWeb}
              onChange={(event) => setAiWeb(event.target.checked)}
            />
            {t('platform.apps.aiWeb')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={aiDesktop}
              onChange={(event) => setAiDesktop(event.target.checked)}
            />
            {t('platform.apps.aiDesktop')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={aiMobile}
              onChange={(event) => setAiMobile(event.target.checked)}
            />
            {t('platform.apps.aiMobile')}
          </label>
        </div>
        <p className="text-xs text-content-muted">{t('platform.apps.aiChannelsHint')}</p>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Fact
            label={t('platform.apps.brandSummary')}
            value={
              settings.brandColour === null && settings.logoMediaId === null
                ? t('platform.apps.brandUnset')
                : t('platform.apps.brandSet')
            }
          />
        </dl>
        <div className="flex items-center gap-3">
          <Button type="submit" busy={save.isPending} disabled={unchanged || !websiteOk}>
            {save.isPending ? t('platform.apps.saving') : t('platform.apps.save')}
          </Button>
          {save.isSuccess && unchanged ? (
            <span className="text-sm text-content-muted">{t('platform.apps.saved')}</span>
          ) : null}
          {problem === undefined ? null : (
            <span role="alert" className="text-sm text-danger">
              {problem}
            </span>
          )}
        </div>
      </form>
    </Panel>
  );
}

/**
 * The assistant for this company (ADR-0001 D1/D6): what it may do, where that
 * comes from, and how much it has been used.
 *
 * Two modes. `inherit`: the plan's policy applies, and changing the plan
 * changes the assistant with it. `custom`: the policy here applies, whole, and
 * a plan change leaves it alone — which is the warning on screen, because it
 * is the one thing somebody moving a company between plans would not expect.
 */
function AiPanel({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();

  const ai = useQuery({
    queryKey: ['platform', 'company', tenantId, 'ai'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/companies/{tenantId}/ai', {
        params: { path: { tenantId } },
      });
      return data;
    },
  });

  if (ai.isPending) {
    return (
      <Panel title={t('platform.ai.title')}>
        <LoadingState />
      </Panel>
    );
  }

  if (ai.isError || ai.data === undefined) {
    return (
      <Panel title={t('platform.ai.title')}>
        <ErrorState
          requestId={ai.error instanceof ApiRequestError ? ai.error.requestId : undefined}
          onRetry={() => void ai.refetch()}
        />
      </Panel>
    );
  }

  // Keyed by what was read, so a save — or somebody else's — starts a fresh
  // form from the new version rather than keeping a stale draft.
  return (
    <AiPanelForm
      key={`${String(ai.data.override?.version ?? 0)}:${String(ai.data.planPolicy.version)}:${ai.data.plan}`}
      tenantId={tenantId}
      data={ai.data}
    />
  );
}

interface CompanyAi {
  plan: string;
  planPolicy: AiPolicyFields & { version: number };
  override:
    | (AiPolicyFields & {
        mode: 'inherit' | 'custom';
        companyDataToProvider: boolean;
        version: number;
        reason: string | null;
        updatedAt: string;
      })
    | null;
  effective: AiPolicyFields & {
    source: 'plan' | 'custom';
    configuredLevel: AiPolicyFields['level'];
    offReason:
      'global_off' | 'plan_off' | 'custom_off' | 'not_served' | 'provider_unconfigured' | null;
    /** Where the answers come from now, and why the library when it is (ADR-0002 D9–D12). */
    answersFrom: 'model' | 'library';
    libraryReason: 'policy' | 'no_provider' | 'provider_unconfigured' | null;
    companyDataToProvider: boolean;
  };
  maxLevelServed: AiPolicyFields['level'];
  globalEnabled: boolean;
  usage: {
    day: { used: number; reserved: number };
    month: { used: number; reserved: number };
    /** Input plus output tokens, company-wide (ADR-0002 D5). */
    tokens: {
      day: { used: number; reserved: number };
      month: { used: number; reserved: number };
    };
    /** What the members' shares add up to, in percent (ADR-0002 D6). */
    assignedSharePercent: number;
    cost: { spent: number; reserved: number; unknown: number };
    providerCalls: number;
    failedCalls: number;
    dayResetsAt: string;
    monthResetsAt: string;
  };
}

function AiPanelForm({ tenantId, data }: { tenantId: string; data: CompanyAi }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const queries = useQueryClient();
  const companyDataId = useId();
  const { override, effective, usage } = data;
  const hasCustom = override !== null && override.mode === 'custom';

  const [mode, setMode] = useState<'inherit' | 'custom'>(hasCustom ? 'custom' : 'inherit');
  const [draft, setDraft] = useState<AiPolicyDraft>(() =>
    draftFromPolicy(hasCustom ? override : effective),
  );
  const [companyData, setCompanyData] = useState(override?.companyDataToProvider ?? false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const reset = () => {
    setMode(hasCustom ? 'custom' : 'inherit');
    setDraft(draftFromPolicy(hasCustom ? override : effective));
    setCompanyData(override?.companyDataToProvider ?? false);
    setReason('');
    setProblem(undefined);
  };

  const chooseMode = (next: 'inherit' | 'custom') => {
    setMode(next);
    if (next === 'custom' && !hasCustom) {
      // Start from what runs today, so "custom" begins as "the same, but mine".
      setDraft(draftFromPolicy(effective));
    }
  };

  const save = useMutation({
    mutationFn: async (body: {
      mode: 'inherit' | 'custom';
      policy: AiPolicyFields;
      companyDataToProvider: boolean;
      reason: string | null;
    }) => {
      await platformClient().PUT('/v1/platform/companies/{tenantId}/ai', {
        params: { path: { tenantId } },
        body: { ...body, expectedVersion: override?.version ?? null },
      });
    },
    onSuccess: () => {
      setProblem(undefined);
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId, 'ai'] });
    },
    onError: (error) => {
      setProblem(messageForError(error, t));
    },
  });

  const submit = () => {
    save.mutate({
      mode,
      policy: mode === 'custom' ? policyFromDraft(draft) : pickPolicyFields(override ?? effective),
      companyDataToProvider: companyData,
      reason: reason.trim() === '' ? null : reason.trim(),
    });
  };

  // "Reset to plan": the override stays, in inherit mode, with its fields as
  // they are — so switching back to custom later starts where it left off.
  const resetToPlan = () => {
    if (override === null) {
      return;
    }
    save.mutate({
      mode: 'inherit',
      policy: pickPolicyFields(override),
      companyDataToProvider: companyData,
      reason: reason.trim() === '' ? null : reason.trim(),
    });
  };

  const offReason =
    effective.offReason === null
      ? null
      : effective.offReason === 'global_off'
        ? t('platform.ai.offGlobal')
        : effective.offReason === 'plan_off'
          ? t('platform.ai.offPlan')
          : effective.offReason === 'custom_off'
            ? t('platform.ai.offCustom')
            : effective.offReason === 'provider_unconfigured'
              ? t('platform.ai.offProviderUnconfigured')
              : t('platform.ai.offNotServed');

  const libraryReason =
    effective.libraryReason === 'policy'
      ? t('platform.ai.libraryReasonPolicy')
      : effective.libraryReason === 'no_provider'
        ? t('platform.ai.libraryReasonNoProvider')
        : effective.libraryReason === 'provider_unconfigured'
          ? t('platform.ai.libraryReasonUnconfigured')
          : null;

  const dayLimit =
    effective.unlimitedMessages || !quotaModeHasDaily(effective.quotaMode)
      ? null
      : effective.dailyLimit;
  const monthLimit =
    effective.unlimitedMessages || !quotaModeHasMonthly(effective.quotaMode)
      ? null
      : effective.monthlyLimit;

  const canSave = mode === 'inherit' || draftIsValid(draft, t);

  return (
    <Panel title={t('platform.ai.title')} description={t('platform.ai.companyDescription')}>
      {data.globalEnabled ? null : (
        <p className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
          {t('platform.ai.globalOff')}
        </p>
      )}
      {effective.configuredLevel !== 'off' &&
      !aiLevelAtLeast(data.maxLevelServed, effective.configuredLevel) ? (
        <p className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
          {t('platform.ai.levelAboveServed', {
            configured: levelLabel(t, effective.configuredLevel),
            served: levelLabel(t, data.maxLevelServed),
          })}
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <Fact label={t('platform.ai.plan')} value={planLabel(t, data.plan)} />
        <div className="flex flex-col gap-0.5">
          <dt className="text-content-muted">{t('platform.ai.source')}</dt>
          <dd>
            <Badge tone={effective.source === 'custom' ? 'warning' : 'muted'}>
              {effective.source === 'custom'
                ? t('platform.ai.sourceCustom')
                : t('platform.ai.sourcePlan')}
            </Badge>
          </dd>
        </div>
        <Fact label={t('platform.ai.effectiveLevel')} value={levelLabel(t, effective.level)} />
        <Fact
          label={t('platform.ai.configuredLevel')}
          value={levelLabel(t, effective.configuredLevel)}
        />
        {offReason === null ? null : <Fact label={t('platform.ai.offReason')} value={offReason} />}
        {effective.level === 'off' ? null : (
          <Fact
            label={t('platform.ai.answersFrom')}
            value={
              effective.answersFrom === 'library'
                ? t('platform.ai.answersFromLibrary')
                : t('platform.ai.answersFromModel')
            }
          />
        )}
      </dl>
      {effective.level === 'off' || libraryReason === null ? null : (
        <p className="text-sm text-content-muted">{libraryReason}</p>
      )}

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-content">{t('platform.ai.mode')}</span>
          <select
            value={mode}
            onChange={(event) => chooseMode(event.target.value as 'inherit' | 'custom')}
            className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
          >
            <option value="inherit">{t('platform.ai.modeInherit')}</option>
            <option value="custom">{t('platform.ai.modeCustom')}</option>
          </select>
        </label>

        {mode === 'custom' ? (
          <>
            <p className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning">
              {t('platform.ai.overrideWarning')}
            </p>
            <AiPolicyEditor draft={draft} onChange={setDraft} disabled={save.isPending} />
          </>
        ) : (
          <AiPolicySummary policy={data.planPolicy} />
        )}

        <div className="flex items-start gap-2 text-sm">
          <input
            id={companyDataId}
            type="checkbox"
            className="mt-1"
            aria-describedby={`${companyDataId}-hint`}
            checked={companyData}
            onChange={(event) => setCompanyData(event.target.checked)}
          />
          <div className="flex flex-col gap-0.5">
            <label htmlFor={companyDataId} className="font-medium text-content">
              {t('platform.ai.companyData')}
            </label>
            <p id={`${companyDataId}-hint`} className="text-xs text-content-muted">
              {t('platform.ai.companyDataHint')}
            </p>
          </div>
        </div>

        <Field
          label={t('platform.ai.reason')}
          hint={t('platform.ai.reasonHint')}
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" busy={save.isPending} disabled={!canSave}>
            {save.isPending ? t('platform.ai.saving') : t('platform.ai.save')}
          </Button>
          {hasCustom ? (
            <Button
              type="button"
              variant="secondary"
              disabled={save.isPending}
              onClick={resetToPlan}
            >
              {t('platform.ai.resetToPlan')}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" disabled={save.isPending} onClick={reset}>
            {t('common.cancel')}
          </Button>
          {problem === undefined ? null : (
            <span role="alert" className="text-sm text-danger">
              {problem}
            </span>
          )}
        </div>
      </form>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-content">{t('platform.ai.usage')}</h3>
        <UsageBar
          label={t('platform.ai.today')}
          used={usage.day.used}
          reserved={usage.day.reserved}
          limit={dayLimit}
          resetsAt={usage.dayResetsAt}
        />
        <UsageBar
          label={t('platform.ai.thisMonth')}
          used={usage.month.used}
          reserved={usage.month.reserved}
          limit={monthLimit}
          resetsAt={usage.monthResetsAt}
        />
        <UsageBar
          label={t('platform.ai.tokensToday')}
          used={usage.tokens.day.used}
          reserved={usage.tokens.day.reserved}
          limit={effective.dailyTokenLimit ?? null}
          resetsAt={usage.dayResetsAt}
        />
        <UsageBar
          label={t('platform.ai.tokensThisMonth')}
          used={usage.tokens.month.used}
          reserved={usage.tokens.month.reserved}
          limit={effective.monthlyTokenLimit ?? null}
          resetsAt={usage.monthResetsAt}
        />
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Fact
            label={t('platform.ai.assignedShares')}
            value={formatPercent(usage.assignedSharePercent / 100, { locale })}
          />
          <Fact label={t('platform.ai.spent')} value={formatMicrousd(usage.cost.spent, locale)} />
          <Fact
            label={t('platform.ai.reserved')}
            value={formatMicrousd(usage.cost.reserved, locale)}
          />
          <Fact
            label={t('platform.ai.unknown')}
            value={formatMicrousd(usage.cost.unknown, locale)}
          />
          <Fact
            label={t('platform.ai.monthlyCostCap')}
            value={
              effective.monthlyCostCapMicrousd === null
                ? t('platform.ai.noCap')
                : formatMicrousd(effective.monthlyCostCapMicrousd, locale)
            }
          />
          <Fact label={t('platform.ai.providerCalls')} value={usage.providerCalls} />
          <Fact label={t('platform.ai.failedCalls')} value={usage.failedCalls} />
        </dl>
      </div>
    </Panel>
  );
}

/** Used plus reserved against a limit, or just the count when nothing caps it. */
function UsageBar({
  label,
  used,
  reserved,
  limit,
  resetsAt,
}: {
  label: string;
  used: number;
  reserved: number;
  limit: number | null;
  resetsAt: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const total = used + reserved;
  const fraction = limit === null || limit <= 0 ? 0 : Math.min(1, total / limit);
  // Token counts run to millions: grouped digits, or nobody reads them right.
  const n = (value: number) => formatNumber(value, { locale });

  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-content">{label}</span>
        <span className="text-content-muted">
          {limit === null
            ? t('platform.ai.usedNoLimit', { used: n(total) })
            : t('platform.ai.usedOf', { used: n(total), limit: n(limit) })}
          {reserved > 0 ? ` ${t('platform.ai.reservedNote', { reserved: n(reserved) })}` : ''}
          {' · '}
          {t('platform.ai.resetsAt', { when: formatWhen(resetsAt, locale) })}
        </span>
      </div>
      {limit === null ? null : (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(total, limit)}
          className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
        >
          <div
            className={`h-full rounded-full ${fraction >= 1 ? 'bg-danger' : fraction >= 0.8 ? 'bg-warning' : 'bg-accent'}`}
            style={{ width: `${String(Math.round(fraction * 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}

interface AiMember {
  userId: string;
  displayName: string;
  email: string;
  status: string;
  aiEnabled: boolean;
  sharePercent: number | null;
  monthlyCostCapMicrousd: number | null;
  version: number | null;
  messages: { day: number; month: number };
  tokens: { day: number; month: number };
  cost: { spent: number; reserved: number; unknown: number };
}

/**
 * Each member's share of the company's assistant allowance, what they have
 * used, and what they have cost (ADR-0002 D6, D7).
 *
 * The company sees only percentages; this is where the numbers behind them
 * are, and the one place a member's monthly dollar cap is set. A share set
 * here follows the company's own rules — whole percent, the total at most
 * 100% — and the company sees it on its People page as if an owner had set
 * it.
 */
function AiMembersPanel({ tenantId }: { tenantId: string }) {
  const { t, i18n } = useTranslation();
  // The same query as the assistant panel above, so it is read once: under
  // library answers shares and dollar caps decide nothing (ADR-0002 D10).
  const ai = useQuery({
    queryKey: ['platform', 'company', tenantId, 'ai'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/companies/{tenantId}/ai', {
        params: { path: { tenantId } },
      });
      return data;
    },
  });
  const members = useQuery({
    queryKey: ['platform', 'company', tenantId, 'ai', 'members'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/companies/{tenantId}/ai/members', {
        params: { path: { tenantId } },
      });
      return data;
    },
  });

  if (members.isPending) {
    return (
      <Panel title={t('platform.ai.members.title')}>
        <LoadingState />
      </Panel>
    );
  }
  if (members.isError || members.data === undefined) {
    return (
      <Panel title={t('platform.ai.members.title')}>
        <ErrorState
          requestId={members.error instanceof ApiRequestError ? members.error.requestId : undefined}
          onRetry={() => void members.refetch()}
        />
      </Panel>
    );
  }

  const assigned = members.data.assignedSharePercent;
  return (
    <Panel
      title={t('platform.ai.members.title')}
      description={t('platform.ai.members.description', {
        assigned: formatPercent(assigned / 100, { locale: i18n.language }),
        unassigned: formatPercent(Math.max(0, 100 - assigned) / 100, { locale: i18n.language }),
      })}
    >
      {ai.data?.effective.answersFrom === 'library' && ai.data.effective.level !== 'off' ? (
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-content">
          {t('platform.ai.members.libraryNote')}
        </p>
      ) : null}
      {members.data.items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('platform.companies.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {members.data.items.map((member) => (
            // Keyed by version, so a save starts the next edit from what was stored.
            <AiMemberRow
              key={`${member.userId}:${String(member.version ?? 0)}`}
              tenantId={tenantId}
              member={member}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function AiMemberRow({ tenantId, member }: { tenantId: string; member: AiMember }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const queries = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [share, setShare] = useState(
    member.sharePercent === null ? '' : String(member.sharePercent),
  );
  const [cap, setCap] = useState(
    member.monthlyCostCapMicrousd === null ? '' : microsToUsdInput(member.monthlyCostCapMicrousd),
  );
  const [reason, setReason] = useState('');

  const parsedShare = parseSharePercent(share);
  const parsedCap = parseUsdToMicros(cap);
  const shareChanged = parsedShare !== member.sharePercent;
  const capChanged = parsedCap !== member.monthlyCostCapMicrousd;

  const save = useMutation({
    mutationFn: async () => {
      await platformClient().PUT('/v1/platform/companies/{tenantId}/ai/members/{userId}', {
        params: { path: { tenantId, userId: member.userId } },
        body: {
          // Only what changed: a field left out keeps its value, so a new cap
          // cannot trip over the share total and the other way round.
          ...(shareChanged && parsedShare !== 'invalid' ? { sharePercent: parsedShare } : {}),
          ...(capChanged && parsedCap !== 'invalid' ? { monthlyCostCapMicrousd: parsedCap } : {}),
          expectedVersion: member.version,
          reason: reason.trim() === '' ? null : reason.trim(),
        },
      });
    },
    onSuccess: () => {
      setEditing(false);
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId, 'ai'] });
    },
  });

  const n = (value: number) => formatNumber(value, { locale });
  const unassigned = save.isError ? unassignedFromRefusal(save.error) : null;
  const failure = save.isError
    ? [
        messageForError(save.error, t),
        unassigned === null
          ? null
          : t('platform.ai.members.unassignedNow', {
              percent: formatPercent(unassigned / 100, { locale }),
            }),
      ]
        .filter((part): part is string => part !== null)
        .join(' ')
    : undefined;

  return (
    <li className="flex flex-col gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-content">{member.displayName}</span>
        <span className="text-content-muted">{member.email}</span>
        {member.status === 'active' ? null : <Badge tone="warning">{member.status}</Badge>}
        <Badge tone={member.aiEnabled ? 'ok' : 'muted'}>
          {member.aiEnabled
            ? t('platform.ai.members.switchOn')
            : t('platform.ai.members.switchOff')}
        </Badge>
        {editing ? null : (
          <span className="ms-auto">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t('platform.ai.change')}
            </Button>
          </span>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Fact
          label={t('platform.ai.members.share')}
          value={
            member.sharePercent === null
              ? t('platform.ai.members.noShare')
              : formatPercent(member.sharePercent / 100, { locale })
          }
        />
        <Fact
          label={t('platform.ai.members.messages')}
          value={t('platform.ai.members.dayMonth', {
            day: n(member.messages.day),
            month: n(member.messages.month),
          })}
        />
        <Fact
          label={t('platform.ai.members.tokens')}
          value={t('platform.ai.members.dayMonth', {
            day: n(member.tokens.day),
            month: n(member.tokens.month),
          })}
        />
        <Fact
          label={t('platform.ai.members.spend')}
          value={formatMicrousdPrecise(member.cost.spent, locale)}
        />
        <Fact
          label={t('platform.ai.members.reservedUnknown')}
          value={t('platform.ai.members.reservedUnknownValue', {
            reserved: formatMicrousdPrecise(member.cost.reserved, locale),
            unknown: formatMicrousdPrecise(member.cost.unknown, locale),
          })}
        />
        <Fact
          label={t('platform.ai.members.cap')}
          value={
            member.monthlyCostCapMicrousd === null
              ? t('platform.ai.noCap')
              : formatMicrousdPrecise(member.monthlyCostCapMicrousd, locale)
          }
        />
      </dl>

      {editing ? (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label={t('platform.ai.members.shareInput')}
              hint={t('platform.ai.members.shareHint')}
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              step={1}
              value={share}
              disabled={save.isPending}
              onChange={(event) => setShare(event.target.value)}
              {...(parsedShare === 'invalid'
                ? { error: t('platform.ai.members.shareInvalid') }
                : {})}
            />
            <Field
              label={t('platform.ai.members.capInput')}
              hint={t('platform.ai.members.capHint')}
              type="number"
              inputMode="decimal"
              min={0.01}
              step="0.01"
              value={cap}
              disabled={save.isPending}
              onChange={(event) => setCap(event.target.value)}
              {...(parsedCap === 'invalid' ? { error: t('platform.ai.members.capInvalid') } : {})}
            />
            <Field
              label={t('platform.ai.reason')}
              hint={t('platform.ai.reasonHint')}
              maxLength={500}
              value={reason}
              disabled={save.isPending}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              busy={save.isPending}
              disabled={
                parsedShare === 'invalid' ||
                parsedCap === 'invalid' ||
                (!shareChanged && !capChanged)
              }
            >
              {t('platform.ai.save')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={save.isPending}
              onClick={() => {
                setShare(member.sharePercent === null ? '' : String(member.sharePercent));
                setCap(
                  member.monthlyCostCapMicrousd === null
                    ? ''
                    : microsToUsdInput(member.monthlyCostCapMicrousd),
                );
                setReason('');
                save.reset();
                setEditing(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            {failure === undefined ? null : (
              <span role="alert" className="text-sm text-danger">
                {failure}
              </span>
            )}
          </div>
        </form>
      ) : null}
    </li>
  );
}

/**
 * What this company is paying, for whoever is asked "have they paid?" (P17).
 *
 * Read-only. Nothing here changes a subscription: the provider owns that, and a
 * dashboard that could quietly mark a company as paid would be the first place
 * anybody looked after a discrepancy. The provider's own ids are shown so the
 * next question — what does their dashboard say — can be answered in one paste.
 */
function BillingPanel({
  billing,
}: {
  billing: {
    provider: string;
    status: string;
    plan: string;
    interval: string | null;
    currentPeriodEnd: string | null;
    trialEndsAt: string | null;
    pastDueSince: string | null;
    graceEndsAt: string | null;
    remindersSent: number;
    readOnlySince: string | null;
    readOnlyReason: string | null;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
  } | null;
}) {
  const { t } = useTranslation();

  if (billing === null) {
    return (
      <Panel title={t('platform.billing.title')}>
        <p className="text-sm text-content-muted">{t('platform.billing.none')}</p>
      </Panel>
    );
  }

  return (
    <Panel title={t('platform.billing.title')}>
      {billing.readOnlySince === null ? null : (
        <p className="mb-4 rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {t('platform.billing.readOnly', { when: formatDate(billing.readOnlySince) })}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <Fact label={t('platform.billing.status')} value={billing.status} />
        <Fact label={t('platform.companies.plan')} value={billing.plan} />
        <Fact
          label={t('platform.billing.interval')}
          value={
            billing.interval === null
              ? '—'
              : billing.interval === 'year'
                ? t('platform.billing.year')
                : t('platform.billing.month')
          }
        />
        <Fact label={t('platform.billing.provider')} value={billing.provider} />
        <Fact
          label={t('platform.billing.renews')}
          value={billing.currentPeriodEnd === null ? '—' : formatDate(billing.currentPeriodEnd)}
        />
        <Fact
          label={t('platform.billing.trialEnds')}
          value={billing.trialEndsAt === null ? '—' : formatDate(billing.trialEndsAt)}
        />
        <Fact
          label={t('platform.billing.pastDueSince')}
          value={billing.pastDueSince === null ? '—' : formatDate(billing.pastDueSince)}
        />
        <Fact
          label={t('platform.billing.graceEnds')}
          value={billing.graceEndsAt === null ? '—' : formatDate(billing.graceEndsAt)}
        />
        <Fact label={t('platform.billing.remindersSent')} value={String(billing.remindersSent)} />
        <Fact label={t('platform.billing.customerId')} value={billing.providerCustomerId ?? '—'} />
        <Fact
          label={t('platform.billing.subscriptionId')}
          value={billing.providerSubscriptionId ?? '—'}
        />
      </dl>
    </Panel>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-content-muted">{label}</dt>
      <dd className="font-medium text-content">{value}</dd>
    </div>
  );
}

function CompanyFlags({ tenantId, flags }: { tenantId: string; flags: Record<string, boolean> }) {
  const { t } = useTranslation();
  const queries = useQueryClient();

  const set = useMutation({
    mutationFn: async ({ key, enabled }: { key: string; enabled: boolean | null }) => {
      await platformClient().PUT('/v1/platform/companies/{tenantId}/flags/{key}', {
        params: { path: { tenantId, key } },
        body: { enabled },
      });
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId] });
    },
  });

  const all = useQuery({
    queryKey: ['platform', 'flags'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/flags');
      return data?.items ?? [];
    },
  });

  return (
    <Panel title={t('platform.company.flags')}>
      {all.data === undefined || all.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('platform.flags.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {all.data.map((flag) => (
            <li
              key={flag.key}
              className="flex flex-wrap items-center justify-between gap-3 text-sm"
            >
              <span className="flex flex-col">
                <span className="font-mono text-content">{flag.key}</span>
                <span className="text-content-muted">{flag.description}</span>
              </span>
              <span className="flex items-center gap-2">
                <Button
                  variant={flags[flag.key] === true ? 'primary' : 'secondary'}
                  onClick={() => set.mutate({ key: flag.key, enabled: true })}
                >
                  {t('platform.flags.on')}
                </Button>
                <Button
                  variant={flags[flag.key] === false ? 'primary' : 'secondary'}
                  onClick={() => set.mutate({ key: flag.key, enabled: false })}
                >
                  {t('platform.flags.off')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => set.mutate({ key: flag.key, enabled: null })}
                >
                  {t('platform.flags.useDefault')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Starting impersonation.
 *
 * The reason box is the whole ceremony: ten characters minimum, enforced by a
 * check constraint rather than by this form, and kept for ever.
 */
function ImpersonateButton({
  tenantId,
  userId,
  name,
}: {
  tenantId: string;
  userId: string;
  name: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const queries = useQueryClient();

  const start = useMutation({
    mutationFn: async () => {
      const { data } = await platformClient().POST(
        '/v1/platform/companies/{tenantId}/impersonate',
        { params: { path: { tenantId } }, body: { targetUserId: userId, reason } },
      );
      return data;
    },
    onSuccess: () => {
      setOpen(false);
      setReason('');
      void queries.invalidateQueries({ queryKey: ['platform', 'impersonations', tenantId] });
    },
  });

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('platform.impersonate.action')}
      </Button>
    );
  }

  return (
    <form
      className="flex w-full flex-col gap-2 rounded-md border border-border-subtle p-3"
      onSubmit={(event) => {
        event.preventDefault();
        start.mutate();
      }}
    >
      <p className="text-sm font-medium text-content">
        {t('platform.impersonate.title', { name })}
      </p>
      <p className="text-sm text-content-muted">{t('platform.impersonate.body')}</p>
      <Field
        label={t('platform.impersonate.reason')}
        hint={t('platform.impersonate.reasonHint')}
        required
        minLength={10}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        {...(start.isError ? { error: messageForError(start.error, t) } : {})}
      />
      <div className="flex gap-2">
        <Button type="submit" busy={start.isPending} disabled={reason.trim().length < 10}>
          {t('platform.impersonate.submit')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function UnlockButton({ tenantId, userId }: { tenantId: string; userId: string }) {
  const { t } = useTranslation();
  const unlock = useMutation({
    mutationFn: async () => {
      await platformClient().POST('/v1/platform/companies/{tenantId}/users/{userId}/unlock', {
        params: { path: { tenantId, userId } },
        body: { reason: 'Unlocked from the platform dashboard' },
      });
    },
  });

  return (
    <Button variant="secondary" busy={unlock.isPending} onClick={() => unlock.mutate()}>
      {unlock.isSuccess ? t('platform.support.unlocked') : t('platform.support.unlock')}
    </Button>
  );
}

function Impersonations({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const queries = useQueryClient();

  const grants = useQuery({
    queryKey: ['platform', 'impersonations', tenantId],
    queryFn: async () => {
      const { data } = await platformClient().GET(
        '/v1/platform/companies/{tenantId}/impersonations',
        { params: { path: { tenantId } } },
      );
      return data?.items ?? [];
    },
  });

  const end = useMutation({
    mutationFn: async (grantId: string) => {
      await platformClient().POST('/v1/platform/companies/{tenantId}/impersonate/{grantId}/end', {
        params: { path: { tenantId, grantId } },
      });
    },
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['platform', 'impersonations', tenantId] });
    },
  });

  return (
    <Panel title={t('platform.company.impersonations')}>
      {grants.data === undefined || grants.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('platform.audit.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {grants.data.map((grant) => (
            <li
              key={grant.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-2"
            >
              <span className="flex flex-col">
                <span className="text-content">{grant.reason}</span>
                <span className="text-content-muted">
                  {t('platform.impersonate.startedAt')} {formatWhen(grant.startedAt)}
                  {grant.endedAt === null
                    ? ` · ${t('platform.impersonate.stillRunning')}`
                    : ` · ${t('platform.impersonate.duration')} ${
                        formatDuration(grant.durationSeconds) ?? ''
                      }`}
                </span>
              </span>
              {grant.endedAt === null ? (
                <Button variant="danger" busy={end.isPending} onClick={() => end.mutate(grant.id)}>
                  {t('platform.impersonate.stop')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RecentErrors({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const failures = useQuery({
    queryKey: ['platform', 'errors', tenantId],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/companies/{tenantId}/errors', {
        params: { path: { tenantId }, query: { limit: 20 } },
      });
      return data?.items ?? [];
    },
  });

  return (
    <Panel title={t('platform.company.errors')}>
      {failures.data === undefined || failures.data.length === 0 ? (
        <p className="text-sm text-content-muted">{t('platform.company.noErrors')}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {failures.data.map((failure) => (
            <li key={failure.id} className="flex flex-col border-b border-border-subtle pb-2">
              <span className="flex items-center gap-2">
                <span className="font-mono text-content">{failure.queue}</span>
                {failure.deadLettered ? (
                  <Badge tone="danger">{t('platform.company.deadLettered')}</Badge>
                ) : null}
                <span className="flex flex-wrap gap-2 text-content-muted">
                  <span>{t('platform.company.attemptsMade', { count: failure.attempts })}</span>
                  <span>{formatWhen(failure.failedAt)}</span>
                </span>
              </span>
              {failure.lastError === null ? null : (
                <span className="text-content-muted">{failure.lastError}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function SupportActions({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');

  const reset = useMutation({
    mutationFn: async () => {
      await platformClient().POST('/v1/platform/companies/{tenantId}/sync/reset', {
        params: { path: { tenantId } },
        body: { reason },
      });
    },
  });

  return (
    <Panel title={t('platform.support.title')} description={t('platform.support.resetSyncBody')}>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          reset.mutate();
        }}
      >
        <div className="min-w-64 flex-1">
          <Field
            label={t('platform.support.reason')}
            required
            minLength={5}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            {...(reset.isError ? { error: messageForError(reset.error, t) } : {})}
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          busy={reset.isPending}
          disabled={reason.length < 5}
        >
          {t('platform.support.resetSync')}
        </Button>
      </form>
      {reset.isSuccess ? (
        <p className="text-sm text-success">{t('platform.support.resetSyncDone')}</p>
      ) : null}
    </Panel>
  );
}

/**
 * Suspending, exporting and closing.
 *
 * Last on the page and in this order, which is the order they happen in: you
 * suspend before you close, and you cannot close without an export because the
 * database will not let you.
 */
function Lifecycle({
  tenantId,
  name,
  status,
}: {
  tenantId: string;
  name: string;
  status: 'active' | 'suspended' | 'cancelled';
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [suspendReason, setSuspendReason] = useState('');
  const [closeReason, setCloseReason] = useState('');

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['platform', 'company', tenantId] });
    void queries.invalidateQueries({ queryKey: ['platform', 'companies'] });
    void queries.invalidateQueries({ queryKey: ['platform', 'exports', tenantId] });
  };

  const exports = useQuery({
    queryKey: ['platform', 'exports', tenantId],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/companies/{tenantId}/exports', {
        params: { path: { tenantId } },
      });
      return data?.items ?? [];
    },
    // An export runs in the background; this is the one place in the dashboard
    // where something changes without anybody pressing anything.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((row) => row.status === 'pending' || row.status === 'running')
        ? 5_000
        : false,
  });

  const suspend = useMutation({
    mutationFn: async () => {
      await platformClient().POST('/v1/platform/companies/{tenantId}/suspend', {
        params: { path: { tenantId } },
        body: { reason: suspendReason },
      });
    },
    onSuccess: refresh,
  });

  const reactivate = useMutation({
    mutationFn: async () => {
      await platformClient().POST('/v1/platform/companies/{tenantId}/reactivate', {
        params: { path: { tenantId } },
      });
    },
    onSuccess: refresh,
  });

  const startExport = useMutation({
    mutationFn: async () => {
      await platformClient().POST('/v1/platform/companies/{tenantId}/exports', {
        params: { path: { tenantId } },
      });
    },
    onSuccess: refresh,
  });

  const ready = (exports.data ?? []).find((row) => row.status === 'ready');

  const close = useMutation({
    mutationFn: async () => {
      if (ready === undefined) {
        return undefined;
      }
      const { data } = await platformClient().POST('/v1/platform/companies/{tenantId}/deletion', {
        params: { path: { tenantId } },
        body: { exportId: ready.id, reason: closeReason },
      });
      return data;
    },
    onSuccess: refresh,
  });

  const cancelClose = useMutation({
    mutationFn: async () => {
      await platformClient().POST('/v1/platform/companies/{tenantId}/deletion/cancel', {
        params: { path: { tenantId } },
      });
    },
    onSuccess: refresh,
  });

  return (
    <Panel title={t('platform.company.danger')}>
      {status === 'active' ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            suspend.mutate();
          }}
        >
          <div className="min-w-64 flex-1">
            <Field
              label={t('platform.suspend.reason')}
              hint={t('platform.suspend.body')}
              required
              minLength={5}
              value={suspendReason}
              onChange={(event) => setSuspendReason(event.target.value)}
              {...(suspend.isError ? { error: messageForError(suspend.error, t) } : {})}
            />
          </div>
          <Button
            type="submit"
            variant="danger"
            busy={suspend.isPending}
            disabled={suspendReason.trim().length < 5}
          >
            {t('platform.suspend.submit')}
          </Button>
        </form>
      ) : (
        <Button variant="secondary" busy={reactivate.isPending} onClick={() => reactivate.mutate()}>
          {t('platform.suspend.reactivate')}
        </Button>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            busy={startExport.isPending}
            onClick={() => startExport.mutate()}
          >
            {t('platform.lifecycle.export')}
          </Button>
          {startExport.isSuccess ? (
            <span className="text-sm text-content-muted">
              {t('platform.lifecycle.exportQueued')}
            </span>
          ) : null}
        </div>

        {(exports.data ?? []).length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm">
            {(exports.data ?? []).map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2">
                <span className="text-content-muted">
                  {t('platform.lifecycle.taken')} {formatWhen(row.createdAt)}
                </span>
                {row.status === 'ready' ? (
                  <Badge tone="ok">
                    {t('platform.lifecycle.exportReady', {
                      size: formatBytes(row.byteSize ?? 0),
                    })}
                  </Badge>
                ) : null}
                {row.status === 'failed' ? (
                  <Badge tone="danger">{t('platform.lifecycle.exportFailed')}</Badge>
                ) : null}
                {row.status === 'pending' ? (
                  <Badge tone="muted">{t('platform.lifecycle.exportPending')}</Badge>
                ) : null}
                {row.status === 'running' ? (
                  <Badge tone="muted">{t('platform.lifecycle.exportRunning')}</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <form
        className="flex flex-col gap-3 rounded-md border border-danger-subtle p-3"
        onSubmit={(event) => {
          event.preventDefault();
          close.mutate();
        }}
      >
        <p className="text-sm font-medium text-content">
          {t('platform.lifecycle.scheduleTitle', { name })}
        </p>
        <p className="text-sm text-content-muted">
          {t('platform.lifecycle.scheduleBody', { days: 7 })}
        </p>

        {ready === undefined ? (
          <p className="text-sm text-warning">{t('platform.lifecycle.needsExport')}</p>
        ) : (
          <>
            <Field
              label={t('platform.lifecycle.reason')}
              required
              minLength={10}
              value={closeReason}
              onChange={(event) => setCloseReason(event.target.value)}
              {...(close.isError ? { error: messageForError(close.error, t) } : {})}
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="danger"
                busy={close.isPending}
                disabled={closeReason.trim().length < 10}
              >
                {t('platform.lifecycle.schedule')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                busy={cancelClose.isPending}
                onClick={() => cancelClose.mutate()}
              >
                {t('platform.lifecycle.cancel')}
              </Button>
            </div>
          </>
        )}

        {close.isSuccess && close.data !== undefined ? (
          // The date comes back from the server rather than being worked out
          // here: the cooling-off period is the API's decision, and a date this
          // screen calculated could disagree with the one the purge uses.
          <p className="text-sm text-danger">
            {t('platform.lifecycle.scheduled', { when: formatDate(close.data.purgeAfter) })}
          </p>
        ) : null}
        {cancelClose.isSuccess ? (
          <p className="text-sm text-success">{t('platform.lifecycle.cancelled')}</p>
        ) : null}
      </form>
    </Panel>
  );
}
