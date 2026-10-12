import { ApiRequestError } from '@integr8/api-client';
import { isPermission, type Role } from '@integr8/core';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { keys, type Member, useOperations } from '../api.js';
import { Failure } from '../ui.js';
import { permissionList, useCompanyRoles } from './role-parts.js';

/**
 * A member's role, changed in place (ADR-0013): the built-in roles this seat
 * may give, then the company's own roles, each read as "Name (based on
 * Dispatcher)". A company role is sent as `{customRoleId}`, a built-in one as
 * `{role}`. A refusal — a role above one's own, or one holding what the giver
 * does not (`role_beyond_own`) — is said in words, with what the giver lacks.
 */

type Choice = { role: Role } | { customRoleId: string };

function valueOf(member: Pick<Member, 'role' | 'customRole'>): string {
  return member.customRole === null || member.customRole === undefined
    ? `role:${member.role}`
    : `custom:${member.customRole.id}`;
}

function choiceOf(value: string): Choice {
  return value.startsWith('custom:')
    ? { customRoleId: value.slice('custom:'.length) }
    : { role: value.slice('role:'.length) as Role };
}

/** What the giver lacks, from a `role_beyond_own` refusal's details, in words. */
function beyondLines(failure: unknown, t: TFunction, locale: string): string[] | undefined {
  if (!(failure instanceof ApiRequestError) || failure.code !== 'role_beyond_own') {
    return undefined;
  }
  const named = failure.details
    .flatMap((detail) => (detail.params?.permissions ?? '').split(','))
    .filter(isPermission);
  return named.length === 0
    ? []
    : [t('roles.picker.beyond', { list: permissionList(t, locale, named) })];
}

export function MemberRolePicker({
  member,
  roles,
  disabled = false,
  disabledHint,
  onChanged,
}: {
  member: Pick<Member, 'userId' | 'displayName' | 'role' | 'customRole'>;
  /** The built-in roles this seat may give this member, the member's own included. */
  roles: readonly Role[];
  disabled?: boolean;
  /** Why the picker is disabled, said as its title. */
  disabledHint?: string;
  /** Called with a sentence for the screen's notice once the change is made. */
  onChanged?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const companyRoles = useCompanyRoles(false);

  // Company roles on a base this seat may give; the member's own always, so
  // the picker shows what they hold.
  const offered = (companyRoles.data?.items ?? []).filter(
    (role) => roles.includes(role.baseRole) || role.id === member.customRole?.id,
  );
  const current = member.customRole;
  const currentMissing =
    current !== null && current !== undefined && !offered.some((role) => role.id === current.id);

  const change = useMutation({
    mutationFn: async (choice: Choice) =>
      (
        await client.PATCH('/v1/members/{userId}/role', {
          params: { path: { userId: member.userId } },
          body: choice,
        })
      ).data!,
    onSuccess: async () => {
      await Promise.all([
        queries.invalidateQueries({ queryKey: keys.members }),
        queries.invalidateQueries({ queryKey: ['roles'] }),
      ]);
      onChanged?.(t('roles.picker.changed', { name: member.displayName }));
    },
  });

  // Making or unmaking an HR manager is the owner's alone; a plain 403 on
  // such a change says so.
  const pendingChoice = change.variables;
  const pendingBase =
    pendingChoice === undefined
      ? undefined
      : 'role' in pendingChoice
        ? pendingChoice.role
        : companyRoles.data?.items.find((role) => role.id === pendingChoice.customRoleId)?.baseRole;
  const touchesHr = member.role === 'hr_manager' || pendingBase === 'hr_manager';
  const lines = beyondLines(change.error, t, locale);

  return (
    <div className="flex flex-col gap-1">
      <select
        value={valueOf(member)}
        onChange={(event) => change.mutate(choiceOf(event.target.value))}
        disabled={disabled || change.isPending}
        className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-sm text-content"
        aria-label={t('workspace.members.changeRole')}
        {...(disabled && disabledHint !== undefined ? { title: disabledHint } : {})}
      >
        <optgroup label={t('roles.picker.builtIn')}>
          {roles.map((role) => (
            <option key={role} value={`role:${role}`}>
              {t(`workspace.role.${role}`)}
            </option>
          ))}
        </optgroup>
        {offered.length === 0 && !currentMissing ? null : (
          <optgroup label={t('roles.picker.company')}>
            {offered.map((role) => (
              <option key={role.id} value={`custom:${role.id}`}>
                {t('roles.picker.option', {
                  name: role.name,
                  base: t(`workspace.role.${role.baseRole}`),
                })}
              </option>
            ))}
            {currentMissing ? (
              <option value={`custom:${current.id}`}>
                {t('roles.picker.option', {
                  name: current.name,
                  base: t(`workspace.role.${member.role}`),
                })}
              </option>
            ) : null}
          </optgroup>
        )}
      </select>
      {change.isError ? (
        <Failure
          error={change.error}
          {...(touchesHr ? { overrides: { forbidden: t('workspace.members.hrOwnerOnly') } } : {})}
          {...(lines === undefined ? {} : { lines })}
        />
      ) : null}
    </div>
  );
}
