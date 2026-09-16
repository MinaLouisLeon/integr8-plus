'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, Panel, StatusBadge } from '~/components/platform-bits';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { formatBytes, formatDate, formatDuration, formatWhen } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

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
                <span className="text-content-muted">
                  {t('platform.company.attempts')} {failure.attempts} ·{' '}
                  {formatWhen(failure.failedAt)}
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
