import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Everything one company has, read as that company (P15).
 *
 * Two callers want this and they want the same thing: a customer asking for
 * their data, and the deletion flow, which refuses to schedule a purge without
 * a finished export. One code path for both means the export that justifies a
 * deletion is the same one the customer would have been handed.
 *
 * It lives here rather than in the API because reading arbitrary tables needs
 * the query builder, and the query builder is deliberately not reachable from
 * outside this package. The alternative was exposing `tx.raw`, which would have
 * made "use a repository" advice rather than the only option.
 *
 * Read through the tenant connection, so RLS applies: an export cannot contain
 * a row the company itself could not have read. That is slower than reading as
 * the schema owner, and it is the whole guarantee.
 */

/**
 * The tables an export holds, in dependency order.
 *
 * Listed explicitly rather than discovered from the schema: a new table should
 * have to be considered — is this the customer's data, or ours? — rather than
 * appear in every customer's export the moment somebody adds it.
 *
 * Absent on purpose: `sessions`, `refresh_tokens`, `offline_grants` and
 * `invitations`, which are credentials rather than data; `jobs`,
 * `idempotency_keys`, `sync_touches` and `rate_limit_buckets`, which are this
 * system's working state and mean nothing outside it.
 */
export const EXPORTED_TABLES = [
  'tenant_users',
  'customers',
  'customer_contacts',
  'sites',
  'job_types',
  'job_type_forms',
  'work_orders',
  'work_order_forms',
  'work_order_checklist_items',
  'work_order_assignments',
  'work_order_comments',
  'work_order_events',
  'forms',
  'form_versions',
  'submissions',
  'submission_events',
  'submission_values',
  'files',
  'attachments',
  'shifts',
  'saved_views',
  'imports',
  'audit_log',
] as const;

export interface TenantDataExport {
  tables: Record<string, unknown[]>;
  /** How many rows of each kind, so somebody can sanity-check the archive. */
  counts: Record<string, number>;
}

export class TenantDataExportRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async readAll(): Promise<TenantDataExport> {
    const tables: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};

    for (const table of EXPORTED_TABLES) {
      const rows = await this.db
        .selectFrom(table)
        .selectAll()
        .where(`${table}.tenant_id`, '=', this.tenantId)
        .execute();

      tables[table] = rows;
      counts[table] = rows.length;
    }

    return { tables, counts };
  }
}
