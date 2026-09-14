import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { SavedViewsTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface SavedView {
  id: string;
  ownerId: UserId;
  resource: 'work_orders';
  name: string;
  filters: Record<string, unknown>;
  shared: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SavedViewInput {
  name: string;
  filters: Record<string, unknown>;
  shared?: boolean;
}

/**
 * A person's named filters for a list. Their own, and the ones colleagues have
 * shared. Only the owner changes or deletes one.
 */
export class SavedViewsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async listVisible(resource: 'work_orders', viewer: UserId | string): Promise<SavedView[]> {
    const rows = await this.db
      .selectFrom('saved_views')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('resource', '=', resource)
      .where((eb) => eb.or([eb('owner_id', '=', toUserId(viewer)), eb('shared', '=', true)]))
      .orderBy(sql`owner_id = ${toUserId(viewer)}`, 'desc')
      .orderBy(sql`lower(name)`)
      .execute();
    return rows.map(toView);
  }

  async create(
    resource: 'work_orders',
    input: SavedViewInput,
    owner: UserId | string,
  ): Promise<SavedView> {
    const row = await this.db
      .insertInto('saved_views')
      .values({
        tenant_id: this.tenantId,
        owner_id: toUserId(owner),
        resource,
        name: input.name.trim(),
        filters: input.filters,
        shared: input.shared ?? false,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toView(row);
  }

  async find(viewId: string): Promise<SavedView | undefined> {
    const row = await this.db
      .selectFrom('saved_views')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', viewId)
      .executeTakeFirst();
    return row === undefined ? undefined : toView(row);
  }

  async update(
    viewId: string,
    owner: UserId | string,
    input: Partial<SavedViewInput>,
  ): Promise<SavedView | undefined> {
    const row = await this.db
      .updateTable('saved_views')
      .set({
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.filters === undefined ? {} : { filters: input.filters }),
        ...(input.shared === undefined ? {} : { shared: input.shared }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', viewId)
      .where('owner_id', '=', toUserId(owner))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toView(row);
  }

  async delete(viewId: string, owner: UserId | string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('saved_views')
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', viewId)
      .where('owner_id', '=', toUserId(owner))
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}

function toView(row: Selectable<SavedViewsTable>): SavedView {
  return {
    id: row.id,
    ownerId: toUserId(row.owner_id),
    resource: row.resource,
    name: row.name,
    filters: row.filters,
    shared: row.shared,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
