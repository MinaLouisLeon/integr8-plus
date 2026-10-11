import {
  type LeadSource,
  type LeadStatus,
  type TenantId,
  type UserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { CrmLeadsTable } from '../schema.js';
import { prefixQuery } from './customers.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Prospects that are not customers yet (CRM/ERP plan, phase C1).
 *
 * A lead is edited with optimistic concurrency: every edit names the version
 * it read, and an edit against a newer version changes nothing and says so.
 * Two dispatchers qualifying the same lead from two screens is ordinary, and
 * the second one should see the first one's change, not silently undo it.
 */

export interface Lead {
  id: string;
  tenantId: TenantId;
  displayName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  source: LeadSource;
  status: LeadStatus;
  assignedTo: UserId | null;
  /** A decimal string, exactly as stored (`numeric(20,4)`); never a JavaScript number. */
  estimatedValue: string | null;
  currencyCode: string | null;
  notes: string | null;
  unqualifiedReason: string | null;
  convertedCustomerId: string | null;
  convertedContactId: string | null;
  convertedAt: Date | null;
  convertedBy: UserId | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/** What can be set by creating or editing a lead. Conversion has its own path. */
export interface LeadInput {
  displayName: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: LeadSource;
  status?: Exclude<LeadStatus, 'converted'>;
  assignedTo?: UserId | string | null;
  estimatedValue?: string | null;
  currencyCode?: string | null;
  notes?: string | null;
  unqualifiedReason?: string | null;
}

export interface LeadQuery {
  /** Words from the name, company, email or phone. Prefixes match. */
  text?: string;
  statuses?: readonly LeadStatus[];
  sources?: readonly LeadSource[];
  /** One member's leads; `null` for the unassigned ones. */
  assignedTo?: UserId | string | null;
  /** Archived leads are left out unless asked for. */
  includeArchived?: boolean;
  /** The last row of the previous page. */
  after?: { createdAt: Date; id: string };
  limit?: number;
}

export interface LeadPage {
  items: Lead[];
  next: { createdAt: Date; id: string } | undefined;
}

/** Why an edit changed nothing. */
export type LeadUpdateRefusal = 'not_found' | 'version_conflict';

export class CrmLeadsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #leads() {
    return this.db.selectFrom('crm_leads').where('crm_leads.tenant_id', '=', this.tenantId);
  }

  async create(input: LeadInput, createdBy: UserId | string): Promise<Lead> {
    const row = await this.db
      .insertInto('crm_leads')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        ...leadColumns(input),
        display_name: input.displayName.trim(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toLead(row);
  }

  async find(leadId: string): Promise<Lead | undefined> {
    const row = await this.#leads().selectAll().where('id', '=', leadId).executeTakeFirst();
    return row === undefined ? undefined : toLead(row);
  }

  /**
   * Changes a lead, provided nobody has changed it since `expectedVersion`.
   *
   * The version check and the write are one statement, so two edits racing for
   * the same version cannot both win.
   */
  async update(
    leadId: string,
    expectedVersion: number,
    input: Partial<LeadInput> & { archived?: boolean },
  ): Promise<Lead | LeadUpdateRefusal> {
    const columns = {
      ...leadColumns(input),
      ...(input.archived === undefined
        ? {}
        : { archived_at: input.archived ? sql<Date>`coalesce(archived_at, now())` : null }),
    };
    const row = await this.db
      .updateTable('crm_leads')
      .set({ ...columns, version: sql<number>`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', leadId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row !== undefined) {
      return toLead(row);
    }
    return (await this.find(leadId)) === undefined ? 'not_found' : 'version_conflict';
  }

  /** Newest first, a page at a time. */
  async list(query: LeadQuery = {}): Promise<LeadPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let select = this.#leads().selectAll();

    const words = query.text === undefined ? undefined : prefixQuery(query.text);
    if (words !== undefined) {
      select = select.where(sql<boolean>`search @@ to_tsquery('simple', ${words})`);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.sources !== undefined && query.sources.length > 0) {
      select = select.where('source', 'in', [...query.sources]);
    }
    if (query.assignedTo === null) {
      select = select.where('assigned_to', 'is', null);
    } else if (query.assignedTo !== undefined) {
      select = select.where('assigned_to', '=', toUserId(query.assignedTo));
    }
    if (query.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    // Ordered at millisecond precision: Postgres keeps microseconds and a
    // JavaScript Date does not, so a cursor built from the last row's time
    // would otherwise skip rows created within the same millisecond.
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(date_trunc('milliseconds', created_at), id) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }

    const rows = await select
      .orderBy(sql`date_trunc('milliseconds', created_at)`, 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toLead);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    };
  }
}

function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function leadColumns(input: Partial<LeadInput>) {
  return {
    ...(input.displayName === undefined ? {} : { display_name: input.displayName.trim() }),
    ...(input.companyName === undefined ? {} : { company_name: blankToNull(input.companyName) }),
    ...(input.email === undefined ? {} : { email: blankToNull(input.email) }),
    ...(input.phone === undefined ? {} : { phone: blankToNull(input.phone) }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.assignedTo === undefined
      ? {}
      : { assigned_to: input.assignedTo === null ? null : toUserId(input.assignedTo) }),
    ...(input.estimatedValue === undefined
      ? {}
      : { estimated_value: blankToNull(input.estimatedValue) }),
    ...(input.currencyCode === undefined
      ? {}
      : { currency_code: blankToNull(input.currencyCode)?.toUpperCase() ?? null }),
    ...(input.notes === undefined ? {} : { notes: blankToNull(input.notes) }),
    ...(input.unqualifiedReason === undefined
      ? {}
      : { unqualified_reason: blankToNull(input.unqualifiedReason) }),
  };
}

/**
 * The amount as Postgres wrote it, minus trailing zeros: `1250.5000` reads as
 * `1250.5`. String work only, so nothing passes through a float.
 */
export function trimDecimal(value: string): string {
  if (!value.includes('.')) {
    return value;
  }
  const trimmed = value.replace(/0+$/u, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

function toLead(row: Selectable<CrmLeadsTable>): Lead {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    displayName: row.display_name,
    companyName: row.company_name,
    email: row.email,
    phone: row.phone,
    source: row.source,
    status: row.status,
    assignedTo: row.assigned_to === null ? null : toUserId(row.assigned_to),
    estimatedValue: row.estimated_value === null ? null : trimDecimal(row.estimated_value),
    currencyCode: row.currency_code,
    notes: row.notes,
    unqualifiedReason: row.unqualified_reason,
    convertedCustomerId: row.converted_customer_id,
    convertedContactId: row.converted_contact_id,
    convertedAt: row.converted_at,
    convertedBy: row.converted_by === null ? null : toUserId(row.converted_by),
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}
