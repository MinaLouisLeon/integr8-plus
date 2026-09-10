import { type TenantId, toTenantId } from '@integr8/core';
import type { Kysely, Selectable } from 'kysely';
import {
  type Database,
  type TenantStatus,
  tenantStatusSchema,
  type TenantsTable,
} from '../schema.js';

export interface Tenant {
  id: TenantId;
  slug: string;
  name: string;
  status: TenantStatus;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface CreateTenantInput {
  slug: string;
  name: string;
  status?: TenantStatus;
}

/**
 * Companies themselves.
 *
 * Deliberately *not* tenant-scoped: creating a company is by definition an act
 * outside every company, so this repository runs on the platform data source,
 * as the schema owner, where RLS does not apply. That is a privilege, and P03
 * puts platform authentication and a mandatory audit entry in front of every
 * caller. Nothing serving a tenant request may construct one.
 *
 * A tenant request that needs to read its *own* company row does so through the
 * tenant data source, where the `tenants_own_row` policy limits it to one row.
 */
export class TenantsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateTenantInput): Promise<Tenant> {
    const row = await this.db
      .insertInto('tenants')
      .values({
        slug: input.slug.trim().toLowerCase(),
        name: input.name.trim(),
        ...(input.status === undefined ? {} : { status: tenantStatusSchema.parse(input.status) }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async findById(tenantId: TenantId | string): Promise<Tenant | undefined> {
    const row = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', toTenantId(tenantId))
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async findBySlug(slug: string): Promise<Tenant | undefined> {
    const row = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('slug', '=', slug.trim().toLowerCase())
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async list(options: { includeDeleted?: boolean } = {}): Promise<Tenant[]> {
    let query = this.db.selectFrom('tenants').selectAll().orderBy('created_at', 'asc');
    if (options.includeDeleted !== true) {
      query = query.where('deleted_at', 'is', null);
    }
    return (await query.execute()).map(toDomain);
  }

  async setStatus(tenantId: TenantId | string, status: TenantStatus): Promise<Tenant | undefined> {
    const row = await this.db
      .updateTable('tenants')
      .set({ status: tenantStatusSchema.parse(status) })
      .where('id', '=', toTenantId(tenantId))
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * Soft-deletes a company. Hard deletion is not offered: `audit_log.tenant_id`
   * is `on delete restrict`, so the history would block it anyway, and that is
   * the correct answer rather than an obstacle to route around.
   */
  async softDelete(tenantId: TenantId | string): Promise<boolean> {
    const result = await this.db
      .updateTable('tenants')
      .set({ deleted_at: new Date(), status: 'cancelled' })
      .where('id', '=', toTenantId(tenantId))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}

function toDomain(row: Selectable<TenantsTable>): Tenant {
  return {
    id: toTenantId(row.id),
    slug: row.slug,
    name: row.name,
    status: tenantStatusSchema.parse(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
