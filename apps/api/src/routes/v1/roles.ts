import {
  CUSTOM_ROLE_BASES,
  type CustomRoleBase,
  customRoleMayHold,
  customRolePermissions,
  holds,
  type Permission,
  PERMISSIONS,
  permissionsFor,
  type Principal,
  roleRank,
  toUserId,
} from '@integr8/core';
import { type CompanyRole, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { assertMayAssign } from './member-rules.js';
import { iso, isoOrNull, permissionSchema } from './schemas.js';

/**
 * The company's own roles (ninth round; ADR-0013). A role starts from a
 * built-in one — any but the owner — and adds or takes away permissions,
 * never the owner's own or Integr8's. The owner defines them; owners and
 * admins give them out with `member.update_role` (see `members.ts`). A change
 * that alters what a role holds ends its holders' sessions, so their next
 * token carries it.
 */

const TAGS = ['workspace'];

const baseSchema = z.enum(CUSTOM_ROLE_BASES as [CustomRoleBase, ...CustomRoleBase[]]);

const roleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  baseRole: baseSchema,
  added: z.array(permissionSchema),
  removed: z.array(permissionSchema),
  /** Everything the role holds: its base, less what it takes away, with what it adds. */
  permissions: z.array(permissionSchema),
  holders: z.number().int(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

function roleBody(role: CompanyRole, holders: number): z.infer<typeof roleSchema> {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    baseRole: role.baseRole,
    added: role.added,
    removed: role.removed,
    permissions: customRolePermissions(role.baseRole, role),
    holders,
    version: role.version,
    createdAt: iso(role.createdAt),
    archivedAt: isoOrNull(role.archivedAt),
  };
}

// ---------------------------------------------------------------------------
// Shared with the member routes and /v1/me
// ---------------------------------------------------------------------------

/** A member's company role, if they have one and it is in use. */
export async function customRoleOf(
  tx: TenantTransaction,
  userId: string,
): Promise<CompanyRole | undefined> {
  const member = await tx.tenantUsers.findByUserId(toUserId(userId));
  if (member?.customRoleId === null || member === undefined) {
    return undefined;
  }
  return tx.tenantRoles.find(member.customRoleId);
}

/** Every company role's name, archived ones included, for member lists. */
export async function customRoleNames(tx: TenantTransaction): Promise<Map<string, string>> {
  return new Map(
    (await tx.tenantRoles.list({ includeArchived: true })).map((role) => [role.id, role.name]),
  );
}

export function customRoleBody(
  roleId: string | null,
  names: ReadonlyMap<string, string>,
): { id: string; name: string } | null {
  return roleId === null ? null : { id: roleId, name: names.get(roleId) ?? '' };
}

/**
 * Whether this seat may give a member this company role: never above its own
 * rank, the HR base only by the owner, and — below the owner — only a role
 * holding nothing the giver does not hold themselves.
 */
export function assertMayGiveRole(principal: Principal, role: CompanyRole): void {
  assertMayAssign(principal, role.baseRole);
  if (roleRank(role.baseRole) > roleRank(principal.role)) {
    throw unprocessable('role_above_own', 'You cannot give somebody a role above your own.', [
      { field: 'body.customRoleId', code: 'role_above_own', message: 'Above your own role.' },
    ]);
  }
  if (principal.role !== 'owner') {
    const beyond = customRolePermissions(role.baseRole, role).filter(
      (permission) => !holds(principal, permission),
    );
    if (beyond.length > 0) {
      throw unprocessable(
        'role_beyond_own',
        'This role can do things you cannot, so only the owner gives it.',
        [
          {
            field: 'body.customRoleId',
            code: 'role_beyond_own',
            message: 'The owner gives this role.',
            params: { permissions: beyond.join(',') },
          },
        ],
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const roleCatalogueRoute = defineRoute({
  method: 'get',
  path: '/v1/roles/catalogue',
  operationId: 'getRoleCatalogue',
  summary: 'What a company role can be built from',
  description:
    'Each built-in role a company role may start from, with what it holds, and every permission a company role may add (never the owner’s own or Integr8’s).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The catalogue.',
      schema: z.object({
        bases: z.array(z.object({ role: baseSchema, permissions: z.array(permissionSchema) })),
        addable: z.array(permissionSchema),
      }),
    },
  },
  handler: () =>
    Promise.resolve({
      status: 200 as const,
      body: {
        bases: CUSTOM_ROLE_BASES.map((role) => ({ role, permissions: permissionsFor(role) })),
        addable: PERMISSIONS.filter(customRoleMayHold),
      },
    }),
});

export const listRolesRoute = defineRoute({
  method: 'get',
  path: '/v1/roles',
  operationId: 'listCompanyRoles',
  summary: 'The company’s own roles',
  description: 'By name, with how many people hold each. `archived=true` includes archived ones.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.read',
  params: noSchema,
  query: z.object({ archived: z.enum(['true', 'false']).optional() }),
  body: noSchema,
  responses: {
    200: {
      description: 'The roles.',
      schema: z.object({ items: z.array(roleSchema), can: z.object({ manage: z.boolean() }) }),
    },
  },
  handler: async ({ query }, { principal }) => {
    const items = await withTenant(principal.tenantId, async (tx) => {
      const [roles, holders] = await Promise.all([
        tx.tenantRoles.list({ includeArchived: query.archived === 'true' }),
        tx.tenantRoles.holders(),
      ]);
      return roles.map((role) => roleBody(role, holders.get(role.id) ?? 0));
    });
    return { status: 200, body: { items, can: { manage: holds(principal, 'role.manage') } } };
  },
});

const roleInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).nullable().default(null),
  added: z.array(permissionSchema).max(200).default([]),
  removed: z.array(permissionSchema).max(200).default([]),
});

/**
 * What a role adds and takes away, checked against its base: it adds only what
 * a company role may hold and the base does not, and takes away only what the
 * base holds.
 */
function checkedLists(
  base: CustomRoleBase,
  input: { added: readonly Permission[]; removed: readonly Permission[] },
): { added: Permission[]; removed: Permission[] } {
  const baseHolds = new Set(permissionsFor(base));
  const refused = input.added.filter((permission) => !customRoleMayHold(permission));
  if (refused.length > 0) {
    throw unprocessable('permission_not_addable', 'A company role cannot hold that.', [
      {
        field: 'body.added',
        code: 'permission_not_addable',
        message: 'Not for a company role.',
        params: { permissions: refused.join(',') },
      },
    ]);
  }
  return {
    added: [...new Set(input.added)].filter((permission) => !baseHolds.has(permission)).sort(),
    removed: [...new Set(input.removed)].filter((permission) => baseHolds.has(permission)).sort(),
  };
}

async function audit(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  roleId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: context.principal.userId,
    actorLabel: context.principal.userId,
    action,
    resourceType: 'tenant_role',
    resourceId: roleId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata,
  });
}

export const createRoleRoute = defineRoute({
  method: 'post',
  path: '/v1/roles',
  operationId: 'createCompanyRole',
  summary: 'Define a company role',
  description:
    'Built on a built-in role (not the owner), adding or taking away permissions. Only the owner. 422 `permission_not_addable`; 409 `name_taken`. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'role.manage',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: roleInput.extend({ baseRole: baseSchema }),
  responses: {
    201: { description: 'The role.', schema: roleSchema },
    409: { description: 'Another role has this name (`name_taken`).' },
    422: { description: 'A permission a company role cannot hold (`permission_not_addable`).' },
  },
  handler: async ({ body }, context) => {
    const role = await withTenant(context.principal.tenantId, async (tx) => {
      const lists = checkedLists(body.baseRole, body);
      const created = await tx.tenantRoles.create(
        { name: body.name, description: body.description, baseRole: body.baseRole, ...lists },
        context.principal.userId,
      );
      if (created === 'name_taken') {
        throw conflict('name_taken', 'Another role has this name.');
      }
      await audit(tx, context, 'role.created', created.id, {
        baseRole: created.baseRole,
        added: created.added,
        removed: created.removed,
      });
      return roleBody(created, 0);
    });
    return { status: 201, body: role };
  },
});

const roleParams = z.object({ roleId: z.uuid() });

export const updateRoleRoute = defineRoute({
  method: 'put',
  path: '/v1/roles/:roleId',
  operationId: 'updateCompanyRole',
  summary: 'Change a company role',
  description:
    'Its name, description, and what it adds and takes away; its base never changes. When what it holds changes, everybody holding it is signed out, so their next token carries the change. Only the owner.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'role.manage',
  params: roleParams,
  query: noSchema,
  body: roleInput.extend({ expectedVersion: z.number().int().min(1) }),
  responses: {
    200: { description: 'The role.', schema: roleSchema },
    404: { description: 'No such role.' },
    409: {
      description:
        'Changed elsewhere (`version_conflict`) or another role has this name (`name_taken`).',
    },
    422: { description: 'A permission a company role cannot hold (`permission_not_addable`).' },
  },
  handler: async ({ params, body }, context) => {
    const { tenantId } = context.principal;
    const result = await withTenant(tenantId, async (tx) => {
      const current = await tx.tenantRoles.find(params.roleId);
      if (current?.archivedAt !== null) {
        throw notFound('This role does not exist.');
      }
      const lists = checkedLists(current.baseRole, body);
      const updated = await tx.tenantRoles.update(current.id, body.expectedVersion, {
        name: body.name,
        description: body.description,
        ...lists,
      });
      if (updated === 'name_taken') {
        throw conflict('name_taken', 'Another role has this name.');
      }
      if (updated === 'not_found') {
        throw notFound('This role does not exist.');
      }
      if (typeof updated === 'string') {
        throw conflict('version_conflict', 'Somebody else changed this role. Reload it.');
      }
      const before = new Set(customRolePermissions(current.baseRole, current));
      const after = new Set(customRolePermissions(updated.baseRole, updated));
      const changed =
        before.size !== after.size || [...before].some((permission) => !after.has(permission));
      await audit(tx, context, 'role.updated', updated.id, {
        added: updated.added,
        removed: updated.removed,
        permissionsChanged: changed,
      });
      const holders = await tx.tenantRoles.holderIds(updated.id);
      return { role: roleBody(updated, holders.length), holders: changed ? holders : [] };
    });
    for (const holder of result.holders) {
      await context.services.sessions.revokeAllForUser(tenantId, holder, 'revoked_by_admin');
    }
    return { status: 200, body: result.role };
  },
});

export const archiveRoleRoute = defineRoute({
  method: 'post',
  path: '/v1/roles/:roleId/archive',
  operationId: 'archiveCompanyRole',
  summary: 'Retire a company role nobody holds',
  description: 'Only the owner. 409 `role_in_use` while somebody holds it.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'role.manage',
  params: roleParams,
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().min(1) }),
  responses: {
    200: { description: 'The role, archived.', schema: roleSchema },
    404: { description: 'No such role.' },
    409: { description: 'Somebody holds it (`role_in_use`), or it changed (`version_conflict`).' },
  },
  handler: async ({ params, body }, context) => {
    const role = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.tenantRoles.archive(params.roleId, body.expectedVersion);
      if (result === 'not_found') {
        throw notFound('This role does not exist.');
      }
      if (result === 'in_use') {
        throw conflict('role_in_use', 'Somebody holds this role. Give them another first.');
      }
      if (typeof result === 'string') {
        throw conflict('version_conflict', 'Somebody else changed this role. Reload it.');
      }
      await audit(tx, context, 'role.archived', result.id, {});
      return roleBody(result, 0);
    });
    return { status: 200, body: role };
  },
});

export const roleRoutes = [
  roleCatalogueRoute,
  listRolesRoute,
  createRoleRoute,
  updateRoleRoute,
  archiveRoleRoute,
];
