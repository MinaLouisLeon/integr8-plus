'use client';

import { ApiRequestError } from '@integr8/api-client';
import type { Grant, Role } from '@integr8/core';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { MemberRolePicker } from '@integr8/operations-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { OperationsScreens } from '~/components/operations-screens';
import { Button, ErrorState, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import {
  invitableRoles,
  manageableGrants,
  mayChangeRole,
  mayGiveGrant,
  roleOptions,
} from '~/lib/people';
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
 *
 * Since ADR-0010 it also shows and changes grants: HR or inventory work given
 * on top of a role. Only the owner makes somebody an HR manager, by role,
 * invitation or grant, so nobody else is offered it.
 *
 * Since ADR-0013 a member may hold one of the company's own roles instead of
 * a built-in one: the role picker offers both, and the company roles screen
 * is reached from here.
 */

type Status = 'invited' | 'active' | 'suspended';

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  grants: Grant[];
  /** The company's own role, whose base is `role` (ADR-0013). */
  customRole?: { id: string; name: string } | null;
  status: Status;
  /** Whether this member may use the assistant (docs/ai; ADR-0001). */
  aiEnabled: boolean;
}

/** Who is looking at the screen: their role and what they may do. */
interface Viewer {
  role: Role | undefined;
  permissions: readonly string[];
}

/**
 * A refusal from the member routes in words: the catalogue's message for its
 * code (ADR-0012), except that a plain 403 on a change touching the HR
 * manager role or grant is the owner-only rule, which says more here.
 */
function peopleError(failure: unknown, t: TFunction, touchesHr: boolean): string {
  if (failure instanceof ApiRequestError && failure.code === 'forbidden' && touchesHr) {
    return t('workspace.members.hrOwnerOnly');
  }
  return messageForError(failure, t);
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

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/me');
      return data;
    },
  });
  const viewer: Viewer = { role: me.data?.role, permissions: me.data?.permissions ?? [] };

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
    <OperationsScreens>
      <main className="flex flex-col gap-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('workspace.members.manage')}</h1>
          <p className="text-sm text-content-muted">{t('workspace.members.manageSubtitle')}</p>
        </header>

        {/* The company's own roles (ADR-0013), kept beside the people who hold them. */}
        <Link
          href="/settings/people/roles"
          className="flex flex-col gap-1 self-start rounded-lg border border-border-subtle bg-surface px-4 py-3 text-start hover:bg-surface-muted"
        >
          <span className="text-sm font-semibold text-content">{t('roles.open')}</span>
          <span className="text-xs text-content-muted">{t('roles.openHint')}</span>
        </Link>

        {notice === null || notice === '' ? null : (
          <p role="status" className="rounded-md bg-surface-muted px-3 py-2 text-sm text-content">
            {notice}
          </p>
        )}

        <InviteForm
          viewer={viewer}
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
                member={member}
                viewer={viewer}
                onDone={(message) => {
                  setNotice(message);
                  refresh();
                }}
              />
            ))}
          </ul>
          <p className="text-xs text-content-muted">{t('roles.picker.note')}</p>
          {/*
            Said here because this is where somebody acts on it, and a person
            removing a dismissed employee deserves to know it is not instant.
          */}
          <p className="text-xs text-content-muted">{t('workspace.members.accessNote')}</p>
          <p className="text-xs text-content-muted">{t('workspace.members.grantsNote')}</p>
        </section>

        {invitations.data === undefined || invitations.data.items.length === 0 ? null : (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-content">
              {t('workspace.members.pending')}
            </h2>
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
    </OperationsScreens>
  );
}

function InviteForm({ viewer, onDone }: { viewer: Viewer; onDone: (message: string) => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('engineer');
  const roles = invitableRoles(viewer.role);
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
      setError(peopleError(failure, t, role === 'hr_manager'));
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
          onChange={(event) => setRole(event.target.value as Role)}
          className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-content"
        >
          {roles.map((option) => (
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

type MemberAction =
  | { kind: 'grant'; grant: Grant; give: boolean }
  | { kind: 'status'; status: 'active' | 'suspended' }
  | { kind: 'ai'; enabled: boolean }
  | { kind: 'remove' };

function MemberRow({
  member,
  viewer,
  onDone,
}: {
  member: Member;
  viewer: Viewer;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const grants = manageableGrants(viewer.role, viewer.permissions);
  const roleLocked = !mayChangeRole(viewer.role, member.role);
  const mayToggleAi = viewer.permissions.includes('member.update_role');

  const act = useMutation({
    mutationFn: async (action: MemberAction) => {
      if (action.kind === 'grant') {
        const params = { path: { userId: member.userId, capability: action.grant } };
        await (action.give
          ? apiClient().PUT('/v1/members/{userId}/grants/{capability}', { params })
          : apiClient().DELETE('/v1/members/{userId}/grants/{capability}', { params }));
        return;
      }
      if (action.kind === 'status') {
        await apiClient().PATCH('/v1/members/{userId}/status', {
          params: { path: { userId: member.userId } },
          body: { status: action.status },
        });
        return;
      }
      if (action.kind === 'ai') {
        await apiClient().PATCH('/v1/members/{userId}/ai', {
          params: { path: { userId: member.userId } },
          body: { aiEnabled: action.enabled },
        });
        // The member's own menu follows this switch.
        void queries.invalidateQueries({ queryKey: ['ai', 'capabilities'] });
        return;
      }
      await apiClient().DELETE('/v1/members/{userId}', {
        params: { path: { userId: member.userId } },
      });
    },
    onSuccess: (_result, action) => {
      setError(null);
      if (action.kind === 'grant') {
        const words = { name: member.displayName, grant: t(`workspace.grant.${action.grant}`) };
        onDone(
          action.give
            ? t('workspace.members.grantGiven', words)
            : t('workspace.members.grantRemoved', words),
        );
        return;
      }
      onDone('');
    },
    onError: (failure, action) => {
      const touchesHr = action.kind === 'grant' && action.grant === 'hr_manager';
      setError(peopleError(failure, t, touchesHr));
    },
  });

  return (
    <li className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-content">{member.displayName}</span>
        <span className="text-content-muted">{member.email}</span>

        {/*
          Built-in roles and the company's own (ADR-0013); a refusal is said
          under the picker, in words.
        */}
        <MemberRolePicker
          member={member}
          roles={roleOptions(viewer.role, member.role)}
          disabled={act.isPending || roleLocked}
          disabledHint={t('workspace.members.hrOwnerOnly')}
          onChanged={onDone}
        />

        <span className="text-xs text-content-muted">
          {t(`workspace.members.status.${member.status}`)}
        </span>

        {mayToggleAi ? (
          <label className="flex items-center gap-1.5 text-xs text-content">
            <input
              type="checkbox"
              checked={member.aiEnabled}
              disabled={act.isPending}
              aria-label={t('workspace.members.ai.toggle', { name: member.displayName })}
              onChange={(event) => act.mutate({ kind: 'ai', enabled: event.target.checked })}
            />
            {t('workspace.members.ai.label')}
          </label>
        ) : (
          <span className="text-xs text-content-muted">
            {member.aiEnabled ? t('workspace.members.ai.on') : t('workspace.members.ai.off')}
          </span>
        )}

        {member.grants.length === 0 ? null : (
          <span className="flex flex-wrap items-center gap-1 text-xs text-content-muted">
            <span>{t('workspace.members.grants')}</span>
            {member.grants.map((grant) => (
              <span
                key={grant}
                className="rounded-full border border-accent px-2 py-0.5 font-medium text-content"
              >
                {t(`workspace.grant.${grant}`)}
              </span>
            ))}
          </span>
        )}

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
      {grants.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {grants.map((grant) => {
            const name = t(`workspace.grant.${grant}`);
            if (member.grants.includes(grant)) {
              return (
                <Button
                  key={grant}
                  variant="ghost"
                  busy={act.isPending}
                  onClick={() => act.mutate({ kind: 'grant', grant, give: false })}
                >
                  {t('workspace.members.grantRemove', { grant: name })}
                </Button>
              );
            }
            return mayGiveGrant(member, grant) ? (
              <Button
                key={grant}
                variant="ghost"
                busy={act.isPending}
                onClick={() => act.mutate({ kind: 'grant', grant, give: true })}
              >
                {t('workspace.members.grantGive', { grant: name })}
              </Button>
            ) : null;
          })}
        </div>
      )}
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
