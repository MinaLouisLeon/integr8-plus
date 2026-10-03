import {
  type Role,
  roleSchema,
  type TenantId,
  type UserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import type { Kysely } from 'kysely';
import { type Database, type MembershipStatus, membershipStatusSchema } from '../schema.js';

export interface AuthMembership {
  tenantId: TenantId;
  userId: UserId;
  role: Role;
  status: MembershipStatus;
}

/**
 * "Which companies does this person belong to?"
 *
 * The first question sign-in asks and the one question the tenancy model cannot
 * answer, because answering it means looking at every company at once. It is
 * served by the `auth_memberships` view, which reads past row-level security on
 * purpose and exposes four columns to make that safe: an identity, a company, a
 * role, a status. No email, no name, nothing about anybody else.
 *
 * Reached only by the `integr8_auth` role. Once a company has been chosen,
 * everything else goes through the ordinary tenant path.
 */
export class AuthMembershipsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every active company this identity belongs to. */
  async listForUser(userId: UserId | string): Promise<AuthMembership[]> {
    const rows = await this.db
      .selectFrom('auth_memberships')
      .selectAll()
      .where('user_id', '=', toUserId(userId))
      .orderBy('tenant_id', 'asc')
      .execute();

    return rows.map(toDomain);
  }

  /**
   * One membership, or nothing.
   *
   * This is the check behind a tenant switch: holding a valid token for company
   * A says nothing about whether the same person may act for company B, and
   * this is where that is established rather than assumed.
   */
  async find(
    userId: UserId | string,
    tenantId: TenantId | string,
  ): Promise<AuthMembership | undefined> {
    const row = await this.db
      .selectFrom('auth_memberships')
      .selectAll()
      .where('user_id', '=', toUserId(userId))
      .where('tenant_id', '=', toTenantId(tenantId))
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }
}

/** True when a membership may be used to sign in right now. */
export function isUsableMembership(membership: AuthMembership): boolean {
  return membership.status === 'active';
}

function toDomain(row: {
  tenant_id: string;
  user_id: string;
  role: string;
  status: string;
}): AuthMembership {
  return {
    tenantId: toTenantId(row.tenant_id),
    userId: toUserId(row.user_id),
    role: roleSchema.parse(row.role),
    status: membershipStatusSchema.parse(row.status),
  };
}
