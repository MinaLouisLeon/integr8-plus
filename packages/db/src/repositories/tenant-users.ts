import {
  type Role,
  roleSchema,
  type TenantId,
  type UserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import type { Selectable } from 'kysely';
import { type MembershipStatus, membershipStatusSchema, type TenantUsersTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface TenantUser {
  id: string;
  tenantId: TenantId;
  userId: UserId;
  email: string;
  displayName: string;
  role: Role;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTenantUserInput {
  userId: UserId | string;
  email: string;
  displayName: string;
  role: Role;
  status?: MembershipStatus;
}

export interface ListTenantUsersOptions {
  /** Include soft-deleted memberships. Off by default. */
  includeDeleted?: boolean;
  limit?: number;
}

/**
 * Memberships of one company.
 *
 * Every method here reads and writes through {@link TenantScopedRepository},
 * so the tenant predicate is applied once, in `#scoped`, rather than repeated
 * in each method where one of them would eventually be missing.
 */
export class TenantUsersRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place a `tenant_users` read is scoped. */
  #scoped() {
    return this.db.selectFrom('tenant_users').where('tenant_users.tenant_id', '=', this.tenantId);
  }

  async list(options: ListTenantUsersOptions = {}): Promise<TenantUser[]> {
    let query = this.#scoped().selectAll().orderBy('created_at', 'asc');

    if (options.includeDeleted !== true) {
      query = query.where('deleted_at', 'is', null);
    }
    if (options.limit !== undefined) {
      query = query.limit(options.limit);
    }

    const rows = await query.execute();
    return rows.map(toDomain);
  }

  async findByUserId(userId: UserId | string): Promise<TenantUser | undefined> {
    const row = await this.#scoped()
      .selectAll()
      .where('user_id', '=', toUserId(userId))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async findByEmail(email: string): Promise<TenantUser | undefined> {
    const row = await this.#scoped()
      .selectAll()
      .where('email', '=', normaliseEmail(email))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * Creates a membership.
   *
   * `tenant_id` comes from the scope and is not a parameter, so there is no way
   * to write a row into another company by passing the wrong argument.
   */
  async create(input: CreateTenantUserInput): Promise<TenantUser> {
    const row = await this.db
      .insertInto('tenant_users')
      .values({
        tenant_id: this.tenantId,
        user_id: toUserId(input.userId),
        email: normaliseEmail(input.email),
        display_name: input.displayName.trim(),
        role: roleSchema.parse(input.role),
        ...(input.status === undefined
          ? {}
          : { status: membershipStatusSchema.parse(input.status) }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async updateRole(userId: UserId | string, role: Role): Promise<TenantUser | undefined> {
    const row = await this.db
      .updateTable('tenant_users')
      .set({ role: roleSchema.parse(role) })
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async updateStatus(
    userId: UserId | string,
    status: MembershipStatus,
  ): Promise<TenantUser | undefined> {
    const row = await this.db
      .updateTable('tenant_users')
      .set({ status: membershipStatusSchema.parse(status) })
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * Soft-deletes a membership.
   *
   * Soft, because `audit_log` rows reference the actor by id and a hard delete
   * would leave history pointing at nothing.
   */
  async softDelete(userId: UserId | string): Promise<boolean> {
    const result = await this.db
      .updateTable('tenant_users')
      .set({ deleted_at: new Date() })
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async countActive(): Promise<number> {
    const row = await this.#scoped()
      .where('deleted_at', 'is', null)
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    return Number.parseInt(row.count, 10);
  }
}

/** Lowercased and trimmed, matching the `tenant_users_email_lowercase` constraint. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toDomain(row: Selectable<TenantUsersTable>): TenantUser {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    userId: toUserId(row.user_id),
    email: row.email,
    displayName: row.display_name,
    role: roleSchema.parse(row.role),
    status: membershipStatusSchema.parse(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
