'use client';

import { ApiRequestError } from '@integr8/api-client';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Badge, Panel } from '~/components/platform-bits';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { formatWhen } from '~/lib/platform-format';
import { platformClient } from '~/lib/platform-session';

/**
 * Integr8's own staff: who can sign in to this dashboard.
 *
 * Everybody signed in sees the list. Adding and removing people is for staff
 * managers only — accounts made with the terminal command on the server — and
 * the API enforces that; this screen just does not offer what would be
 * refused. A terminal account is never changed from here at all, so the power
 * to manage staff stays with whoever holds the server.
 *
 * New credentials are shown once, in a panel the manager dismisses after
 * sending them on, and are never fetched again.
 */

interface StaffMember {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  canManageStaff: boolean;
  addedBy: { id: string; displayName: string } | null;
  ready: boolean;
  createdAt: string;
  lastSignedInAt: string | null;
  isYou: boolean;
}

interface IssuedCredentials {
  member: StaffMember;
  password: string;
  totpSecret: string;
  totpUri: string;
}

const STAFF_KEY = ['platform', 'staff'] as const;

/** The staff screen's own refusals, worded; everything else as anywhere. */
function staffError(error: unknown, t: TFunction): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'staff_manager_only':
        return t('platform.staff.errorManagerOnly');
      case 'staff_exists':
        return t('platform.staff.errorExists');
      case 'terminal_account':
        return t('platform.staff.errorTerminal');
    }
  }
  return messageForError(error, t);
}

export default function StaffPage() {
  const { t } = useTranslation();
  const [issued, setIssued] = useState<IssuedCredentials | undefined>(undefined);

  const me = useQuery({
    queryKey: ['platform', 'me'],
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/me');
      return data;
    },
  });

  const staff = useQuery({
    queryKey: STAFF_KEY,
    queryFn: async () => {
      const { data } = await platformClient().GET('/v1/platform/staff');
      return data?.items ?? [];
    },
  });

  const canManage = me.data?.canManageStaff === true;

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.staff.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.staff.subtitle')}</p>
        {me.isSuccess ? (
          <p className="text-sm text-content-muted">
            {canManage ? t('platform.staff.managerNote') : t('platform.staff.viewerNote')}
          </p>
        ) : null}
      </header>

      {issued === undefined ? null : (
        <CredentialsPanel issued={issued} onDone={() => setIssued(undefined)} />
      )}

      {canManage ? <AddStaffForm onIssued={setIssued} /> : null}

      <Panel
        title={t('platform.staff.listTitle')}
        {...(canManage ? { description: t('platform.staff.restoreHint') } : {})}
      >
        {staff.isPending ? <LoadingState /> : null}

        {staff.isError ? (
          <ErrorState
            requestId={staff.error instanceof ApiRequestError ? staff.error.requestId : undefined}
            onRetry={() => void staff.refetch()}
          />
        ) : null}

        {staff.isSuccess && staff.data.length === 0 ? (
          <EmptyState title={t('platform.staff.empty')} />
        ) : null}

        {staff.isSuccess && staff.data.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {staff.data.map((member) => (
              <StaffRow
                key={member.id}
                member={member}
                canManage={canManage}
                onIssued={setIssued}
              />
            ))}
          </ul>
        ) : null}
      </Panel>
    </main>
  );
}

function AddStaffForm({ onIssued }: { onIssued: (issued: IssuedCredentials) => void }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');

  const add = useMutation({
    mutationFn: async () => {
      const { data } = await platformClient().POST('/v1/platform/staff', {
        body: { email: email.trim(), displayName: displayName.trim() },
      });
      return data;
    },
    onSuccess: (data) => {
      if (data === undefined) {
        return;
      }
      onIssued(data);
      setEmail('');
      setDisplayName('');
      void queries.invalidateQueries({ queryKey: STAFF_KEY });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };

  return (
    <Panel title={t('platform.staff.addTitle')} description={t('platform.staff.addDescription')}>
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field
            label={t('platform.staff.name')}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={120}
            required
            autoComplete="off"
          />
        </div>
        <div className="flex-1">
          <Field
            label={t('platform.staff.email')}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={320}
            required
            autoComplete="off"
          />
        </div>
        <Button
          type="submit"
          busy={add.isPending}
          disabled={add.isPending || email.trim() === '' || displayName.trim() === ''}
        >
          {add.isPending ? t('platform.staff.adding') : t('platform.staff.add')}
        </Button>
      </form>
      {add.isError ? (
        <p role="alert" className="text-sm text-danger">
          {staffError(add.error, t)}
        </p>
      ) : null}
    </Panel>
  );
}

function StaffRow({
  member,
  canManage,
  onIssued,
}: {
  member: StaffMember;
  canManage: boolean;
  onIssued: (issued: IssuedCredentials) => void;
}) {
  const { t, i18n } = useTranslation();
  const queries = useQueryClient();
  const [confirming, setConfirming] = useState<'reset' | 'remove' | undefined>(undefined);

  const reset = useMutation({
    mutationFn: async () => {
      const { data } = await platformClient().POST(
        '/v1/platform/staff/{platformUserId}/credentials',
        { params: { path: { platformUserId: member.id } } },
      );
      return data;
    },
    onSuccess: (data) => {
      setConfirming(undefined);
      if (data !== undefined) {
        onIssued(data);
      }
      void queries.invalidateQueries({ queryKey: STAFF_KEY });
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      await platformClient().DELETE('/v1/platform/staff/{platformUserId}', {
        params: { path: { platformUserId: member.id } },
      });
    },
    onSuccess: () => {
      setConfirming(undefined);
      void queries.invalidateQueries({ queryKey: STAFF_KEY });
    },
  });

  // Only accounts added from the dashboard, still on the staff, can be changed
  // here; the API refuses the rest, so the buttons are not offered.
  const changeable = canManage && member.isActive && !member.canManageStaff && !member.isYou;
  const busy = reset.isPending || remove.isPending;
  const failure = reset.error ?? remove.error;

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border-subtle p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-content">{member.displayName}</span>
        <span className="text-content-muted">{member.email}</span>
        {member.isYou ? <Badge tone="ok">{t('platform.staff.you')}</Badge> : null}
        {member.canManageStaff ? (
          <Badge tone="warning">{t('platform.staff.terminal')}</Badge>
        ) : (
          <Badge tone="muted">
            {member.addedBy === null
              ? t('platform.staff.addedFromDashboard')
              : t('platform.staff.addedBy', { name: member.addedBy.displayName })}
          </Badge>
        )}
        {member.isActive ? null : <Badge tone="danger">{t('platform.staff.removedBadge')}</Badge>}
        {member.isActive && !member.ready ? (
          <Badge tone="warning">{t('platform.staff.notReady')}</Badge>
        ) : null}
      </div>

      <p className="text-content-muted">
        {member.lastSignedInAt === null
          ? t('platform.staff.neverSignedIn')
          : t('platform.staff.lastSignedIn', {
              when: formatWhen(member.lastSignedInAt, i18n.language),
            })}
        {canManage && member.canManageStaff && member.isActive
          ? ` · ${t('platform.staff.terminalHint')}`
          : null}
      </p>

      {changeable && confirming === undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setConfirming('reset')}>
            {t('platform.staff.reset')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => setConfirming('remove')}>
            {t('platform.staff.remove')}
          </Button>
        </div>
      ) : null}

      {changeable && confirming !== undefined ? (
        <div
          role="group"
          aria-label={
            confirming === 'reset' ? t('platform.staff.reset') : t('platform.staff.remove')
          }
          className="flex flex-col gap-2 rounded-md bg-surface-muted p-3"
        >
          <p className="text-content">
            {confirming === 'reset'
              ? t('platform.staff.resetConfirm', { name: member.displayName })
              : t('platform.staff.removeConfirm', { name: member.displayName })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {confirming === 'reset' ? (
              <Button busy={reset.isPending} disabled={busy} onClick={() => reset.mutate()}>
                {reset.isPending ? t('platform.staff.resetting') : t('platform.staff.resetYes')}
              </Button>
            ) : (
              <Button
                variant="danger"
                busy={remove.isPending}
                disabled={busy}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? t('platform.staff.removing') : t('platform.staff.removeYes')}
              </Button>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(undefined)}>
              {t('platform.staff.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {remove.isSuccess ? (
        <p role="status" className="text-content-muted">
          {t('platform.staff.removed', { name: member.displayName })}
        </p>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="text-danger">
          {staffError(failure, t)}
        </p>
      )}
    </li>
  );
}

function CredentialsPanel({ issued, onDone }: { issued: IssuedCredentials; onDone: () => void }) {
  const { t } = useTranslation();
  const name = issued.member.displayName;

  return (
    <section
      aria-labelledby="staff-credentials-title"
      className="flex flex-col gap-3 rounded-lg border border-warning bg-warning-subtle p-4"
    >
      <h2 id="staff-credentials-title" className="text-base font-semibold text-content">
        {t('platform.staff.credentialsTitle', { name })}
      </h2>
      <p className="text-sm text-content">{t('platform.staff.credentialsHint', { name })}</p>
      <dl className="flex flex-col gap-2 text-sm">
        <SecretLine label={t('platform.staff.email')} value={issued.member.email} />
        <SecretLine label={t('platform.staff.password')} value={issued.password} />
        <SecretLine label={t('platform.staff.secret')} value={issued.totpSecret} />
        <SecretLine label={t('platform.staff.uri')} value={issued.totpUri} />
      </dl>
      <div>
        <Button onClick={onDone}>{t('platform.staff.done')}</Button>
      </div>
    </section>
  );
}

function SecretLine({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard refused (an insecure page, a denied permission): the value
      // is on screen to select by hand.
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <dt className="min-w-40 font-medium text-content">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center gap-2">
        <code
          dir="ltr"
          className="min-w-0 flex-1 break-all rounded bg-surface px-2 py-1 text-content"
        >
          {value}
        </code>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? t('platform.staff.copied') : t('platform.staff.copy')}
        </Button>
      </dd>
    </div>
  );
}
