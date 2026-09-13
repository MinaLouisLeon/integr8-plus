import { type TenantId, toTenantId } from '@integr8/core';
import type { Selectable } from 'kysely';
import { type AuditActorKind, auditActorKindSchema, type AuditLogTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface AuditEntry {
  id: string;
  tenantId: TenantId;
  occurredAt: Date;
  actorKind: AuditActorKind;
  actorId: string | null;
  actorLabel: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface AppendAuditEntryInput {
  actorKind: AuditActorKind;
  /** Required unless `actorKind` is `system`; the check constraint enforces the pairing. */
  actorId?: string | null;
  actorLabel: string;
  /** Dotted past-tense event name, e.g. `tenant_user.invited`. */
  action: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListAuditEntriesOptions {
  limit?: number;
  /** Returns entries strictly older than this, for keyset pagination. */
  before?: Date;
  resourceType?: string;
  resourceId?: string;
}

/**
 * The append-only audit trail for one company.
 *
 * There is no `update` or `delete` here, and their absence is not the control:
 * the app role holds no such grant, and a statement-level trigger rejects both
 * for every role including the owner. This class simply has no way to ask.
 */
export class AuditLogRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place an `audit_log` read is scoped. */
  #scoped() {
    return this.db.selectFrom('audit_log').where('audit_log.tenant_id', '=', this.tenantId);
  }

  async append(input: AppendAuditEntryInput): Promise<AuditEntry> {
    const row = await this.db
      .insertInto('audit_log')
      .values({
        tenant_id: this.tenantId,
        actor_kind: auditActorKindSchema.parse(input.actorKind),
        actor_id: input.actorId ?? null,
        actor_label: input.actorLabel,
        action: input.action,
        resource_type: input.resourceType,
        resource_id: input.resourceId ?? null,
        request_id: input.requestId ?? null,
        ip_address: input.ipAddress ?? null,
        user_agent: input.userAgent ?? null,
        metadata: input.metadata ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async list(options: ListAuditEntriesOptions = {}): Promise<AuditEntry[]> {
    let query = this.#scoped().selectAll().orderBy('occurred_at', 'desc').orderBy('id', 'desc');

    if (options.before !== undefined) {
      query = query.where('occurred_at', '<', options.before);
    }
    if (options.resourceType !== undefined) {
      query = query.where('resource_type', '=', options.resourceType);
    }
    if (options.resourceId !== undefined) {
      query = query.where('resource_id', '=', options.resourceId);
    }

    return (await query.limit(options.limit ?? 100).execute()).map(toDomain);
  }

  async count(): Promise<number> {
    const row = await this.#scoped()
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();

    return Number.parseInt(row.count, 10);
  }
}

function toDomain(row: Selectable<AuditLogTable>): AuditEntry {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    occurredAt: row.occurred_at,
    actorKind: auditActorKindSchema.parse(row.actor_kind),
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    metadata: row.metadata,
  };
}
