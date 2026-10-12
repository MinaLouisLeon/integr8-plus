import { ApiRequestError } from '@integr8/api-client';
import type { CustomRoleBase, Permission } from '@integr8/core';
import { formatNumber, useTranslation } from '@integr8/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { type CompanyRole, type RoleCatalogue, useOperations } from '../api.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { BackLink, buttonClass, cardClass, Failure, Field, inputClass, Loading } from '../ui.js';
import {
  groupLabel,
  permissionGroups,
  permissionLabel,
  permissionList,
  roleDifference,
  useCompanyRoles,
  useRoleCatalogue,
} from './role-parts.js';

/**
 * The company's own roles (ninth round; ADR-0013, G1a). Everybody who reads
 * the people screen sees them: each role's name, the built-in role it is
 * built on and how many people hold it. The owner (`can.manage`) creates,
 * changes and archives them.
 *
 * The editor is a checklist of everything the role may hold, grouped by area:
 * ticked means held, and each line says whether the base holds it, so
 * unticking takes something away from the base and ticking adds something to
 * it. Only `addable` permissions — never the owner's own or Integr8's — are
 * offered to add. What is sent is the difference from the base, which is also
 * shown in words before saving, with the warning that changing what a role
 * holds signs out everybody who holds it.
 */

type Editing = { kind: 'new' } | { kind: 'edit'; role: CompanyRole };

const roleQueryPrefix = ['roles'] as const;

export function CompanyRolesScreen({ peoplePath }: { peoplePath?: string } = {}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const roles = useCompanyRoles(showArchived);
  const catalogue = useRoleCatalogue();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const manage = roles.data?.can.manage === true;

  const archive = useMutation({
    mutationFn: async (role: CompanyRole) =>
      (
        await client.POST('/v1/roles/{roleId}/archive', {
          params: { path: { roleId: role.id } },
          body: { expectedVersion: role.version },
        })
      ).data!,
    onSuccess: async (role) => {
      setNotice(t('roles.archived', { name: role.name }));
      await queries.invalidateQueries({ queryKey: roleQueryPrefix });
    },
  });

  const reload = () => {
    archive.reset();
    void queries.invalidateQueries({ queryKey: roleQueryPrefix });
  };

  return (
    <div className="flex flex-col gap-6 text-start">
      {peoplePath === undefined ? null : <BackLink to={peoplePath} label={t('roles.back')} />}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-content">{t('roles.title')}</h1>
        <p className="max-w-prose text-sm text-content-muted">{t('roles.intro')}</p>
      </header>

      {notice === null ? null : (
        <p role="status" className="rounded-md bg-surface-muted px-3 py-2 text-sm text-content">
          {notice}
        </p>
      )}

      {editing !== null && catalogue.data !== undefined ? (
        <RoleEditor
          key={editing.kind === 'edit' ? editing.role.id : 'new'}
          editing={editing}
          catalogue={catalogue.data}
          onCancel={() => setEditing(null)}
          onDone={(message) => {
            setEditing(null);
            setNotice(message);
          }}
        />
      ) : roles.isPending || (editing !== null && catalogue.isPending) ? (
        <Loading />
      ) : roles.isError ? (
        <Failure error={roles.error} onRetry={() => void roles.refetch()} />
      ) : editing !== null && catalogue.isError ? (
        <Failure error={catalogue.error} onRetry={() => void catalogue.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-content">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              {t('roles.showArchived')}
            </label>
            {manage ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => {
                  setNotice(null);
                  archive.reset();
                  setEditing({ kind: 'new' });
                }}
              >
                {t('roles.create')}
              </button>
            ) : null}
          </div>

          {archive.isError ? (
            <Failure
              error={archive.error}
              actions={
                <button type="button" className={buttonClass.secondary} onClick={reload}>
                  {t('roles.reload')}
                </button>
              }
            />
          ) : null}

          {roles.data.items.length === 0 ? (
            <p className="py-8 text-center text-sm text-content-muted">{t('roles.empty')}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('roles.title')}</caption>
                <thead className="border-b border-border-subtle text-xs text-content-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2 text-start font-medium">
                      {t('roles.column.name')}
                    </th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">
                      {t('roles.column.base')}
                    </th>
                    <th scope="col" className="px-4 py-2 text-end font-medium">
                      {t('roles.column.holders')}
                    </th>
                    {manage ? (
                      <th scope="col" className="px-4 py-2 text-end font-medium">
                        {t('roles.column.actions')}
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {roles.data.items.map((role) => (
                    <tr key={role.id}>
                      <th scope="row" className="px-4 py-3 text-start font-normal">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-content" dir="auto">
                            {role.name}
                          </span>
                          {role.archivedAt === null ? null : (
                            <span className="rounded-full border border-border-subtle px-2 py-0.5 text-xs text-content-muted">
                              {t('roles.archivedBadge')}
                            </span>
                          )}
                        </span>
                        {role.description === null ? null : (
                          <span className="block text-xs text-content-muted" dir="auto">
                            {role.description}
                          </span>
                        )}
                      </th>
                      <td className="px-4 py-3 text-content">
                        {t(`workspace.role.${role.baseRole}`)}
                      </td>
                      <td className="px-4 py-3 text-end tabular-nums text-content">
                        {formatNumber(role.holders, { locale })}
                      </td>
                      {manage ? (
                        <td className="px-4 py-3">
                          {role.archivedAt === null ? (
                            <span className="flex flex-wrap justify-end gap-2">
                              <button
                                type="button"
                                className={buttonClass.secondary}
                                aria-label={t('roles.editNamed', { name: role.name })}
                                onClick={() => {
                                  setNotice(null);
                                  archive.reset();
                                  setEditing({ kind: 'edit', role });
                                }}
                              >
                                {t('roles.edit')}
                              </button>
                              <button
                                type="button"
                                className={buttonClass.danger}
                                aria-label={t('roles.archiveNamed', { name: role.name })}
                                disabled={archive.isPending}
                                onClick={() => {
                                  setNotice(null);
                                  archive.mutate(role);
                                }}
                              >
                                {t('roles.archive')}
                              </button>
                            </span>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {manage ? null : <p className="text-sm text-content-muted">{t('roles.readOnly')}</p>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

function sameSet(a: ReadonlySet<Permission>, b: readonly Permission[]): boolean {
  return a.size === new Set(b).size && b.every((permission) => a.has(permission));
}

function RoleEditor({
  editing,
  catalogue,
  onCancel,
  onDone,
}: {
  editing: Editing;
  catalogue: RoleCatalogue;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queries = useQueryClient();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const existing = editing.kind === 'edit' ? editing.role : undefined;

  const bases = catalogue.bases.map((entry) => entry.role);
  const [base, setBase] = useState<CustomRoleBase>(
    existing?.baseRole ?? (bases.includes('dispatcher') ? 'dispatcher' : bases[0]!),
  );
  const basePermissions = useMemo(
    () => catalogue.bases.find((entry) => entry.role === base)?.permissions ?? [],
    [catalogue, base],
  );
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [held, setHeld] = useState<ReadonlySet<Permission>>(
    () => new Set(existing?.permissions ?? basePermissions),
  );
  const [tried, setTried] = useState(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Everything the checklist offers: what the base holds (to keep or take
  // away) and what a company role may add.
  const groups = useMemo(
    () => permissionGroups([...basePermissions, ...catalogue.addable]),
    [basePermissions, catalogue.addable],
  );
  const inBase = useMemo(() => new Set(basePermissions), [basePermissions]);
  const difference = roleDifference(basePermissions, held);
  const baseName = t(`workspace.role.${base}`);
  const holdingChanged = existing !== undefined && !sameSet(held, existing.permissions);

  const body = {
    name: name.trim(),
    description: description.trim() === '' ? null : description.trim(),
    added: difference.added,
    removed: difference.removed,
  };
  // One key per request body: a retry replays, a changed role is a new request.
  const idempotencyKey = useIdempotencyKey({ ...body, base });

  const save = useMutation({
    mutationFn: async () =>
      existing === undefined
        ? (
            await client.POST('/v1/roles', {
              params: { header: { 'Idempotency-Key': idempotencyKey } },
              body: { ...body, baseRole: base },
            })
          ).data!
        : (
            await client.PUT('/v1/roles/{roleId}', {
              params: { path: { roleId: existing.id } },
              body: { ...body, expectedVersion: existing.version },
            })
          ).data!,
    onSuccess: async (role) => {
      await queries.invalidateQueries({ queryKey: roleQueryPrefix });
      onDone(t(existing === undefined ? 'roles.created' : 'roles.saved', { name: role.name }));
    },
  });

  const toggle = (permission: Permission, on: boolean) => {
    save.reset();
    setHeld((current) => {
      const next = new Set(current);
      if (on) {
        next.add(permission);
      } else {
        next.delete(permission);
      }
      return next;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (name.trim() !== '') {
      save.mutate();
    }
  };

  const nameMissing = tried && name.trim() === '';
  const conflict = save.error instanceof ApiRequestError && save.error.code === 'version_conflict';

  return (
    <form aria-labelledby={headingId} className={cardClass} noValidate onSubmit={submit}>
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold text-content outline-none"
      >
        {existing === undefined
          ? t('roles.editor.newTitle')
          : t('roles.editor.editTitle', { name: existing.name })}
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t('roles.editor.name')}
          {...(nameMissing ? { hint: t('roles.editor.nameRequired') } : {})}
        >
          {(id, describedBy) => (
            <input
              id={id}
              type="text"
              dir="auto"
              required
              maxLength={60}
              aria-describedby={describedBy}
              aria-invalid={nameMissing}
              className={inputClass}
              value={name}
              onChange={(event) => {
                save.reset();
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        {existing === undefined ? (
          <Field label={t('roles.editor.base')} hint={t('roles.editor.baseHint')}>
            {(id, describedBy) => (
              <select
                id={id}
                aria-describedby={describedBy}
                className={inputClass}
                value={base}
                onChange={(event) => {
                  const next = event.target.value as CustomRoleBase;
                  save.reset();
                  setBase(next);
                  // A new base starts from what it holds.
                  setHeld(
                    new Set(
                      catalogue.bases.find((entry) => entry.role === next)?.permissions ?? [],
                    ),
                  );
                }}
              >
                {bases.map((role) => (
                  <option key={role} value={role}>
                    {t(`workspace.role.${role}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <p className="self-end text-sm text-content-muted">
            {t('roles.editor.baseFixed', { role: baseName })}
          </p>
        )}

        <Field
          label={t('roles.editor.description')}
          hint={t('roles.editor.descriptionHint')}
          className="sm:col-span-2"
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              dir="auto"
              rows={2}
              maxLength={500}
              aria-describedby={describedBy}
              className={inputClass}
              value={description}
              onChange={(event) => {
                save.reset();
                setDescription(event.target.value);
              }}
            />
          )}
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-base font-semibold text-content">
          {t('roles.editor.permissions')}
        </legend>
        <p className="text-sm text-content-muted">{t('roles.editor.permissionsHint')}</p>
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map(({ group, permissions }) => (
            <fieldset
              key={group}
              className="flex flex-col gap-2 rounded-md border border-border-subtle p-3"
            >
              <legend className="px-1 text-sm font-medium text-content">
                {groupLabel(t, group)}
              </legend>
              <ul className="flex flex-col gap-2">
                {permissions.map((permission) => (
                  <PermissionLine
                    key={permission}
                    permission={permission}
                    checked={held.has(permission)}
                    inBase={inBase.has(permission)}
                    baseName={baseName}
                    onChange={(on) => toggle(permission, on)}
                  />
                ))}
              </ul>
            </fieldset>
          ))}
        </div>
      </fieldset>

      <section
        aria-labelledby={`${headingId}-summary`}
        className="flex flex-col gap-1 rounded-md bg-surface-muted p-3 text-sm text-content"
      >
        <h3 id={`${headingId}-summary`} className="font-medium">
          {t('roles.editor.summary', { role: baseName })}
        </h3>
        {difference.added.length === 0 && difference.removed.length === 0 ? (
          <p>{t('roles.editor.same', { role: baseName })}</p>
        ) : (
          <>
            {difference.added.length === 0 ? null : (
              <p>{t('roles.editor.adds', { list: permissionList(t, locale, difference.added) })}</p>
            )}
            {difference.removed.length === 0 ? null : (
              <p>
                {t('roles.editor.removes', {
                  list: permissionList(t, locale, difference.removed),
                })}
              </p>
            )}
          </>
        )}
      </section>

      {holdingChanged ? (
        <p
          role="status"
          className="rounded-md border border-warning bg-warning-subtle p-3 text-sm text-content"
        >
          {t('roles.editor.signOutWarning', {
            holders: formatNumber(existing?.holders ?? 0, { locale }),
          })}
        </p>
      ) : null}

      {save.isError ? (
        <Failure
          error={save.error}
          {...(conflict
            ? {
                actions: (
                  <button
                    type="button"
                    className={buttonClass.secondary}
                    onClick={() => {
                      void queries.invalidateQueries({ queryKey: roleQueryPrefix });
                      onCancel();
                    }}
                  >
                    {t('roles.reload')}
                  </button>
                ),
              }
            : {})}
        />
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonClass.secondary} onClick={onCancel}>
          {t('roles.editor.cancel')}
        </button>
        <button type="submit" className={buttonClass.primary} disabled={save.isPending}>
          {save.isPending
            ? t('roles.editor.saving')
            : existing === undefined
              ? t('roles.editor.create')
              : t('roles.editor.save')}
        </button>
      </div>
    </form>
  );
}

function PermissionLine({
  permission,
  checked,
  inBase,
  baseName,
  onChange,
}: {
  permission: Permission;
  checked: boolean;
  inBase: boolean;
  baseName: string;
  onChange: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-sm text-content">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={`${id}-base`}
          onChange={(event) => onChange(event.target.checked)}
        />
        {permissionLabel(t, permission)}
      </label>
      <span
        id={`${id}-base`}
        className={`text-xs ${inBase ? 'text-content-muted' : 'text-accent'}`}
      >
        {inBase
          ? t('roles.editor.inBase', { role: baseName })
          : t('roles.editor.notInBase', { role: baseName })}
      </span>
    </li>
  );
}
