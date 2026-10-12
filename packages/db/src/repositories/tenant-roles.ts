import {
  type CustomRoleBase,
  type CustomRoleOverlay,
  isPermission,
  type Permission,
  toUserId,
  type UserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { TenantRolesTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * A company's own roles (0041; ADR-0013): a built-in base and what it adds
 * or takes away. Read when an access token is minted; which permissions a
 * role may add, and who defines and gives them, are the API's rules.
 */

export interface CompanyRole {
  id: string;
  name: string;
  description: string | null;
  baseRole: CustomRoleBase;
  added: Permission[];
  removed: Permission[];
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface TenantRoleInput {
  name: string;
  description: string | null;
  added: readonly Permission[];
  removed: readonly Permission[];
}

export type TenantRoleRefusal = 'not_found' | 'version_conflict' | 'name_taken' | 'in_use';

export class TenantRolesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** By name, archived ones last when asked for. */
  async list(options: { includeArchived?: boolean } = {}): Promise<CompanyRole[]> {
    let select = this.db
      .selectFrom('tenant_roles')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (options.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    return (
      await select
        .orderBy(sql`archived_at is not null`)
        .orderBy(sql`lower(name)`)
        .execute()
    ).map(toRole);
  }

  async find(roleId: string): Promise<CompanyRole | undefined> {
    const row = await this.db
      .selectFrom('tenant_roles')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', roleId)
      .executeTakeFirst();
    return row === undefined ? undefined : toRole(row);
  }

  /** How many members hold each role. */
  async holders(): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom('tenant_users')
      .select(['custom_role_id', sql<number>`count(*)::int`.as('holders')])
      .where('tenant_id', '=', this.tenantId)
      .where('custom_role_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .groupBy('custom_role_id')
      .execute();
    return new Map(rows.map((row) => [row.custom_role_id!, row.holders]));
  }

  /** The members holding a role: whose sessions end when it loses a permission. */
  async holderIds(roleId: string): Promise<UserId[]> {
    const rows = await this.db
      .selectFrom('tenant_users')
      .select('user_id')
      .where('tenant_id', '=', this.tenantId)
      .where('custom_role_id', '=', roleId)
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((row) => toUserId(row.user_id));
  }

  async create(
    input: TenantRoleInput & { baseRole: CustomRoleBase },
    createdBy: UserId | string,
  ): Promise<CompanyRole | 'name_taken'> {
    try {
      const row = await this.db
        .insertInto('tenant_roles')
        .values({
          tenant_id: this.tenantId,
          name: input.name.trim(),
          description: input.description,
          base_role: input.baseRole,
          added: [...input.added],
          removed: [...input.removed],
          created_by: toUserId(createdBy),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toRole(row);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'tenant_roles_name_unique') {
        return 'name_taken';
      }
      throw error;
    }
  }

  async update(
    roleId: string,
    expectedVersion: number,
    input: TenantRoleInput,
  ): Promise<CompanyRole | TenantRoleRefusal> {
    try {
      const row = await this.db
        .updateTable('tenant_roles')
        .set({
          name: input.name.trim(),
          description: input.description,
          added: [...input.added],
          removed: [...input.removed],
          version: sql<number>`version + 1`,
        })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', roleId)
        .where('version', '=', expectedVersion)
        .where('archived_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (row !== undefined) {
        return toRole(row);
      }
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'tenant_roles_name_unique') {
        return 'name_taken';
      }
      throw error;
    }
    return (await this.find(roleId)) === undefined ? 'not_found' : 'version_conflict';
  }

  async archive(roleId: string, expectedVersion: number): Promise<CompanyRole | TenantRoleRefusal> {
    try {
      const row = await this.db
        .updateTable('tenant_roles')
        .set({ archived_at: sql<Date>`now()`, version: sql<number>`version + 1` })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', roleId)
        .where('version', '=', expectedVersion)
        .where('archived_at', 'is', null)
        .returningAll()
        .executeTakeFirst();
      if (row !== undefined) {
        return toRole(row);
      }
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'tenant_roles_in_use') {
        return 'in_use';
      }
      throw error;
    }
    return (await this.find(roleId)) === undefined ? 'not_found' : 'version_conflict';
  }

  /** What a member's token carries: their company role's overlay, if any. */
  async overlayFor(userId: UserId | string): Promise<CustomRoleOverlay | undefined> {
    const row = await this.db
      .selectFrom('tenant_users as u')
      .innerJoin('tenant_roles as r', (join) =>
        join.onRef('r.tenant_id', '=', 'u.tenant_id').onRef('r.id', '=', 'u.custom_role_id'),
      )
      .select(['r.id', 'r.added', 'r.removed'])
      .where('u.tenant_id', '=', this.tenantId)
      .where('u.user_id', '=', toUserId(userId))
      .where('u.deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: row.id,
          added: row.added.filter(isPermission),
          removed: row.removed.filter(isPermission),
        };
  }
}

function toRole(row: Selectable<TenantRolesTable>): CompanyRole {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    baseRole: row.base_role as CustomRoleBase,
    added: row.added.filter(isPermission),
    removed: row.removed.filter(isPermission),
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}
