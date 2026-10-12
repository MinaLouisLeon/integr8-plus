import { GRANTS, type Grant, toUserId, type UserId } from '@integr8/core';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Capabilities a member holds on top of their role (0036; ADR-0010). Read
 * when an access token is minted and by `/v1/me`; who may give which is the
 * API's rule.
 */
export class MemberGrantsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** A member's grants, in the order of {@link GRANTS}. */
  async forUser(userId: UserId | string): Promise<Grant[]> {
    return (await this.forUsers([userId])).get(userId) ?? [];
  }

  async forUsers(userIds: readonly (UserId | string)[]): Promise<Map<string, Grant[]>> {
    const result = new Map<string, Grant[]>();
    if (userIds.length === 0) {
      return result;
    }
    const rows = await this.db
      .selectFrom('member_grants')
      .select(['user_id', 'capability'])
      .where('tenant_id', '=', this.tenantId)
      .where(
        'user_id',
        'in',
        userIds.map((id) => toUserId(id)),
      )
      .execute();
    for (const row of rows) {
      result.set(row.user_id, [...(result.get(row.user_id) ?? []), row.capability]);
    }
    for (const [userId, grants] of result) {
      result.set(
        userId,
        GRANTS.filter((grant) => grants.includes(grant)),
      );
    }
    return result;
  }

  /** Gives a grant; false when the member already holds it. */
  async give(userId: UserId | string, capability: Grant, by: UserId | string): Promise<boolean> {
    const rows = await this.db
      .insertInto('member_grants')
      .values({
        tenant_id: this.tenantId,
        user_id: toUserId(userId),
        capability,
        granted_by: toUserId(by),
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'user_id', 'capability']).doNothing(),
      )
      .returning('capability')
      .execute();
    return rows.length > 0;
  }

  /** Takes a grant away; false when the member did not hold it. */
  async remove(userId: UserId | string, capability: Grant): Promise<boolean> {
    const result = await this.db
      .deleteFrom('member_grants')
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .where('capability', '=', capability)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
