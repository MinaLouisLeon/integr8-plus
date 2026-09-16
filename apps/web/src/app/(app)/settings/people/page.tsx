'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { apiClient } from '~/lib/session';

/**
 * Who is in this company, and what they may do (P18).
 *
 * The screen for the four routes P18 added. Two things it does that a simpler
 * version would not:
 *
 * - **It says whether the invitation actually left.** The API reports
 *   `emailed`, and an invitation whose message failed is shown as such with a
 *   resend button, rather than a cheerful "sent" that is not true.
 * - **It states the fifteen-minute window.** Suspending or removing somebody
 *   stops them signing in at once, but a session already open can last a
 *   quarter of an hour longer. Somebody dismissing an employee needs to know
 *   that, and the place to tell them is here, not in a document.
 */

const ROLES = ['admin', 'dispatcher', 'engineer', 'viewer'] as const;

type Role = 'owner' | 'admin' | 'dispatcher' | 'engineer' | 'viewer';
type Status = 'invited' | 'active' | 'suspended';

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: Status;
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  emailed: boolean | null;
}

export default function PeoplePage() {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);

  const members = useQuery({
    queryKey: ['members'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/members');
      return data;
    },
  });

  const invitations = useQuery({
    queryKey: ['members', 'invitations'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/members/invitations');
      return data;
    },
  });

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['members'] });
  };

  if (members.isPending) {
    return <LoadingState />;
  }

  if (members.isError || members.data === undefined) {
    return (
      <ErrorState
        requestId={members.error instanceof ApiRequestError ? members.error.requestId : undefined}
        onRetry={() => void members.refetch()}
      />
    );
  }

  return (
    <main className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('workspace.members.manage')}</h1>
        <p className="text-sm text-content-muted">{t('workspace.members.manageSubtitle')}</p>
      </header>

      {notice === null ? null : (
        <p role="status" className="rounded-md bg-surface-muted px-3 py-2 text-sm text-content">
          {notice}
        </p>
      )}

      <InviteForm
        onDone={(message) => {
          setNotice(message);
          refresh();
        }}
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-content">{t('workspace.members.title')}</h2>
        <ul className="flex flex-col gap-2">
          {members.data.items.map((member) => (
            <MemberRow
              key={member.userId}
              member={member as Member}
              onDone={(message) => {
                setNotice(message);
                refresh();
              }}
            />
          ))}
        </ul>
        {/*
          Said here because this is where somebody acts on it, and a person
          removing a dismissed employee deserves to know it is not instant.
        */}
        <p className="text-xs text-content-muted">{t('workspace.members.accessNote')}</p>
      </section>

      {invitations.data === undefined || invitations.data.items.length === 0 ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold text-content">{t('workspace.members.pending')}</h2>
          <ul className="flex flex-col gap-2">
            {invitations.data.items.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation as Invitation}
                onDone={(message) => {
                  setNotice(message);
                  refresh();
                }}
              />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function InviteForm({ onDone }: { onDone: (message: string) => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('engineer');
  const [error, setError] = useState<string | undefined>(undefined);

  const invite = useMutation({
    mutationFn: async () => {
      const { data } = await apiClient().POST('/v1/members/invitations', {
        body: { email, role },
      });
      return data;
    },
    onSuccess: (data) => {
      setEmail('');
      // The honest two-outcome case: the invitation exists either way, but
      // only one of them means somebody received anything.
      onDone(
        data?.emailed === false
          ? t('workspace.members.invitedNoEmail')
          : t('workspace.members.invited', { email }),
      );
    },
    onError: (failure) => {
      setError(messageForError(failure, t));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    invite.mutate();
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" noValidate>
      <div className="min-w-64 flex-1">
        <Field
          label={t('workspace.members.inviteEmail')}
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          {...(error === undefined ? {} : { error })}
        />
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-content">{t('workspace.members.inviteRole')}</span>
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as (typeof ROLES)[number])}
          className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
        >
          {ROLES.map((option) => (
            <option key={option} value={option}>
              {t(`workspace.role.${option}`)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" busy={invite.isPending}>
        {t('workspace.members.inviteSend')}
      </Button>
    </form>
  );
}

function MemberRow({ member, onDone }: { member: Member; onDone: (message: string) => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: async (
      action:
        | { kind: 'role'; role: Role }
        | { kind: 'status'; status: 'active' | 'suspended' }
        | { kind: 'remove' },
    ) => {
      if (action.kind === 'role') {
        await apiClient().PATCH('/v1/members/{userId}/role', {
          params: { path: { userId: member.userId } },
          body: { role: action.role },
        });
        return;
      }
      if (action.kind === 'status') {
        await apiClient().PATCH('/v1/members/{userId}/status', {
          params: { path: { userId: member.userId } },
          body: { status: action.status },
        });
        return;
      }
      await apiClient().DELETE('/v1/members/{userId}', {
        params: { path: { userId: member.userId } },
      });
    },
    onSuccess: () => {
      setError(null);
      onDone('');
    },
    onError: (failure) => {
      // The one refusal worth its own words: a company must keep an owner.
      setError(
        failure instanceof ApiRequestError && failure.code === 'last_owner'
          ? t('workspace.members.lastOwner')
          : messageForError(failure, t),
      );
    },
  });

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-content">{member.displayName}</span>
        <span className="text-content-muted">{member.email}</span>

        <select
          value={member.role}
          onChange={(event) => act.mutate({ kind: 'role', role: event.target.value as Role })}
          disabled={act.isPending}
          className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-content"
          aria-label={t('workspace.members.changeRole')}
        >
          {(['owner', ...ROLES] as Role[]).map((option) => (
            <option key={option} value={option}>
              {t(`workspace.role.${option}`)}
            </option>
          ))}
        </select>

        <span className="text-xs text-content-muted">
          {t(`workspace.members.status.${member.status}`)}
        </span>

        <div className="ms-auto flex gap-2">
          {member.status === 'suspended' ? (
            <Button
              variant="secondary"
              busy={act.isPending}
              onClick={() => act.mutate({ kind: 'status', status: 'active' })}
            >
              {t('workspace.members.reactivate')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              busy={act.isPending}
              onClick={() => {
                if (confirm(t('workspace.members.suspendConfirm', { name: member.displayName }))) {
                  act.mutate({ kind: 'status', status: 'suspended' });
                }
              }}
            >
              {t('workspace.members.suspend')}
            </Button>
          )}
          <Button
            variant="danger"
            busy={act.isPending}
            onClick={() => {
              if (confirm(t('workspace.members.removeConfirm', { name: member.displayName }))) {
                act.mutate({ kind: 'remove' });
              }
            }}
          >
            {t('workspace.members.remove')}
          </Button>
        </div>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

function InvitationRow({
  invitation,
  onDone,
}: {
  invitation: Invitation;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();

  const resend = useMutation({
    mutationFn: async () => {
      await apiClient().POST('/v1/members/invitations/{invitationId}/resend', {
        params: { path: { invitationId: invitation.id } },
      });
    },
    onSuccess: () => onDone(t('workspace.members.resent')),
  });

  const withdraw = useMutation({
    mutationFn: async () => {
      await apiClient().DELETE('/v1/members/invitations/{invitationId}', {
        params: { path: { invitationId: invitation.id } },
      });
    },
    onSuccess: () => onDone(''),
  });

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm">
      <span className="text-content">{invitation.email}</span>
      <span className="text-content-muted">{t(`workspace.role.${invitation.role}`)}</span>
      {invitation.emailed === false ? (
        <span className="text-warning">{t('workspace.members.invitedNoEmail')}</span>
      ) : null}
      <div className="ms-auto flex gap-2">
        <Button variant="secondary" busy={resend.isPending} onClick={() => resend.mutate()}>
          {t('workspace.members.resend')}
        </Button>
        <Button variant="ghost" busy={withdraw.isPending} onClick={() => withdraw.mutate()}>
          {t('workspace.members.withdraw')}
        </Button>
      </div>
    </li>
  );
}
