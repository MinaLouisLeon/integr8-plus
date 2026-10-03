import type { PlatformUserId } from '@integr8/core';
import type { Kysely, Selectable } from 'kysely';
import type { Database, PlatformAuditLogTable } from '../schema.js';

/**
 * What a super admin did, for ever.
 *
 * Append-only in the database for every role, the schema owner included, so
 * there is no arrangement of application code that can lose an entry. Where an
 * action concerns a company, its own `audit_log` gets an entry too: this table
 * is the platform's record, not the customer's.
 */

export interface PlatformAuditEntry {
  id: string;
  occurredAt: Date;
  platformUserId: PlatformUserId | null;
  actorLabel: string;
  action: string;
  tenantId: string | null;
  tenantSlug: string | null;
  targetKind: string | null;
  targetId: string | null;
  reason: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface AppendPlatformAuditInput {
  platformUserId: PlatformUserId | string | null;
  /** Who it was, in words, kept even if the account is deleted later. */
  actorLabel: string;
  action: string;
  tenantId?: string | null;
  tenantSlug?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface PlatformAuditQuery {
  /** Free text over the action, the company and the person. */
  search?: string;
  action?: string;
  tenantId?: string;
  platformUserId?: PlatformUserId | string;
  from?: Date;
  to?: Date;
  /** Keyset: the last row of the previous page. */
  before?: { occurredAt: Date; id: string };
  limit?: number;
}

export interface PlatformAuditPage {
  entries: PlatformAuditEntry[];
  next: { occurredAt: Date; id: string } | undefined;
}

const MAX_LIMIT = 200;

export class PlatformAuditRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async append(input: AppendPlatformAuditInput): Promise<PlatformAuditEntry> {
    const row = await this.db
      .insertInto('platform_audit_log')
      .values({
        platform_user_id: input.platformUserId ?? null,
        actor_label: input.actorLabel.trim(),
        action: input.action,
        tenant_id: input.tenantId ?? null,
        tenant_slug: input.tenantSlug ?? null,
        target_kind: input.targetKind ?? null,
        target_id: input.targetId ?? null,
        reason: input.reason ?? null,
        request_id: input.requestId ?? null,
        ip_address: input.ipAddress ?? null,
        user_agent: input.userAgent ?? null,
        metadata: JSON.stringify(input.metadata ?? {}) as never,
        ...(input.occurredAt === undefined ? {} : { occurred_at: input.occurredAt }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toEntry(row);
  }

  /** Newest first, by keyset, so paging cannot repeat or skip an entry. */
  async list(query: PlatformAuditQuery = {}): Promise<PlatformAuditPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_LIMIT);
    let select = this.db.selectFrom('platform_audit_log').selectAll();

    if (query.action !== undefined) {
      select = select.where('action', '=', query.action);
    }
    if (query.tenantId !== undefined) {
      select = select.where('tenant_id', '=', query.tenantId);
    }
    if (query.platformUserId !== undefined) {
      select = select.where('platform_user_id', '=', query.platformUserId);
    }
    if (query.from !== undefined) {
      select = select.where('occurred_at', '>=', query.from);
    }
    if (query.to !== undefined) {
      select = select.where('occurred_at', '<', query.to);
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const like = `%${query.search.trim().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      select = select.where((where) =>
        where.or([
          where('action', 'ilike', like),
          where('actor_label', 'ilike', like),
          where('tenant_slug', 'ilike', like),
          where('reason', 'ilike', like),
        ]),
      );
    }
    if (query.before !== undefined) {
      const { occurredAt, id } = query.before;
      select = select.where((where) =>
        where.or([
          where('occurred_at', '<', occurredAt),
          where.and([where('occurred_at', '=', occurredAt), where('id', '<', id)]),
        ]),
      );
    }

    const rows = await select
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();

    const page = rows.slice(0, limit).map(toEntry);
    const last = rows.length > limit ? page[page.length - 1] : undefined;
    return {
      entries: page,
      next: last === undefined ? undefined : { occurredAt: last.occurredAt, id: last.id },
    };
  }
}

function toEntry(row: Selectable<PlatformAuditLogTable>): PlatformAuditEntry {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    platformUserId: row.platform_user_id as PlatformUserId | null,
    actorLabel: row.actor_label,
    action: row.action,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    targetKind: row.target_kind,
    targetId: row.target_id,
    reason: row.reason,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    metadata: row.metadata,
  };
}
