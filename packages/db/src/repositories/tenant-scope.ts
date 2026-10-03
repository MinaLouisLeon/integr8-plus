import type { TenantId } from '@integr8/core';
import type { Transaction } from 'kysely';
import type { Database } from '../schema.js';

/**
 * What every tenant-scoped repository is handed: the tenant it acts for, and
 * the transaction it acts in.
 *
 * It lives in its own module so repositories and `connection.ts` can both
 * depend on it without depending on each other.
 */
export interface TenantScope {
  readonly tenantId: TenantId;
  readonly trx: Transaction<Database>;
}

/**
 * Base for tenant-scoped repositories.
 *
 * Subclasses never write `.where('tenant_id', ...)` themselves; they start from
 * these four builders, each of which has the tenant predicate already applied.
 * Inserts take the `tenant_id` from the scope, so there is no parameter a
 * caller could pass the wrong value to.
 *
 * If one of these helpers loses its predicate, `TenantGuardPlugin` rejects the
 * statement before it reaches Postgres and the isolation suite fails — which is
 * the point of writing the filter in one place instead of forty.
 */
export abstract class TenantScopedRepository {
  protected constructor(protected readonly scope: TenantScope) {}

  protected get tenantId(): TenantId {
    return this.scope.tenantId;
  }

  protected get db(): Transaction<Database> {
    return this.scope.trx;
  }
}
