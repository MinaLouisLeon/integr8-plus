import { type Permission, PERMISSIONS, type Role } from '@integr8/core';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { keys, useOperations } from '../api.js';

/**
 * What the company-roles screens share (ninth round; ADR-0013): permissions
 * grouped by area and named in words, what a role adds to and takes from its
 * base, and how a member's role reads when it is one of the company's own.
 */

/** A permission's area: the part of its name before the first dot (`crm`, `inventory`). */
export type PermissionGroup = Permission extends `${infer Prefix}.${string}` ? Prefix : never;

export function groupOf(permission: Permission): PermissionGroup {
  return permission.slice(0, permission.indexOf('.')) as PermissionGroup;
}

const ORDER: ReadonlyMap<Permission, number> = new Map(
  PERMISSIONS.map((permission, index) => [permission, index]),
);

/** Permissions in the catalogue's own order, which keeps each area together. */
export function inCatalogueOrder(permissions: Iterable<Permission>): Permission[] {
  return [...new Set(permissions)].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
}

/** The permissions, grouped by area, areas and permissions in the catalogue's order. */
export function permissionGroups(
  permissions: Iterable<Permission>,
): { group: PermissionGroup; permissions: Permission[] }[] {
  const groups = new Map<PermissionGroup, Permission[]>();
  for (const permission of inCatalogueOrder(permissions)) {
    const group = groupOf(permission);
    groups.set(group, [...(groups.get(group) ?? []), permission]);
  }
  return [...groups].map(([group, list]) => ({ group, permissions: list }));
}

/** What a role holding `held` adds to its base and takes away from it, as the API takes them. */
export function roleDifference(
  base: readonly Permission[],
  held: ReadonlySet<Permission>,
): { added: Permission[]; removed: Permission[] } {
  const inBase = new Set(base);
  return {
    added: inCatalogueOrder([...held].filter((permission) => !inBase.has(permission))),
    removed: inCatalogueOrder(base.filter((permission) => !held.has(permission))),
  };
}

export function permissionLabel(t: TFunction, permission: Permission): string {
  return t(`roles.permission.${permission}`);
}

export function groupLabel(t: TFunction, group: PermissionGroup): string {
  return t(`roles.group.${group}`);
}

/** A list of permissions in words, joined the reader's way. */
export function permissionList(
  t: TFunction,
  locale: string,
  permissions: readonly Permission[],
): string {
  const words = permissions.map((permission) => permissionLabel(t, permission));
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(words);
  } catch {
    return words.join(', ');
  }
}

/** A member's role in words: their company role "(based on …)", or the built-in role's name. */
export function memberRoleName(
  t: TFunction,
  member: { role: Role; customRole?: { name: string } | null | undefined },
): string {
  const base = t(`workspace.role.${member.role}`);
  return member.customRole === null || member.customRole === undefined
    ? base
    : t('roles.picker.option', { name: member.customRole.name, base });
}

/** The company's roles, archived ones too when asked. */
export function useCompanyRoles(archived = false) {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.roles(archived),
    queryFn: async () =>
      (
        await client.GET('/v1/roles', {
          params: { query: archived ? { archived: 'true' } : {} },
        })
      ).data!,
  });
}

/** Everything a company role is built from: each base role's permissions, and what may be added. */
export function useRoleCatalogue() {
  const { client } = useOperations();
  return useQuery({
    queryKey: keys.roleCatalogue,
    queryFn: async () => (await client.GET('/v1/roles/catalogue')).data!,
    staleTime: Infinity,
  });
}

/** {@link memberRoleName}, bound to the current language. */
export function useMemberRoleName(): (member: Parameters<typeof memberRoleName>[1]) => string {
  const { t } = useTranslation();
  return (member) => memberRoleName(t, member);
}
