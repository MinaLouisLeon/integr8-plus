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
  'tenant_roles',
  // The assistant (0044; ADR-0001): a member's chats, the actions prepared for
  // them and the record of what was charged are the company's own.
  'ai_conversations',
  'ai_messages',
  'ai_action_proposals',
  'ai_action_events',
  'ai_usage_periods',
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
  // The CRM (CRM/ERP plan, 0024–0025): the company's prospects, deals and
  // follow-ups are its own data.
  'crm_leads',
  'crm_pipelines',
  'crm_pipeline_stages',
  'crm_opportunities',
  'crm_opportunity_events',
  'crm_opportunity_amounts',
  'crm_activities',
  'crm_activity_leads',
  'crm_activity_customers',
  'crm_activity_opportunities',
  // Inventory (0026): the catalogue, locations, the stock ledger and counts.
  // Balances are left out: they are derived from the ledger, which is exported.
  'erp_item_categories',
  'erp_items',
  'erp_stock_locations',
  'erp_stock_counts',
  'erp_stock_count_lines',
  'erp_stock_lots',
  'erp_stock_movements',
  'erp_reorder_levels',
  // Purchasing (0027). The reference counter is working state and is left out.
  'erp_suppliers',
  'erp_purchase_orders',
  'erp_purchase_order_lines',
  'erp_goods_receipts',
  'erp_goods_receipt_lines',
  'erp_work_order_materials',
  'crm_quotes',
  'crm_quote_lines',
  'erp_sales_orders',
  'erp_sales_order_lines',
  'erp_sales_order_work_orders',
  'erp_finance_settings',
  'erp_invoices',
  'erp_invoice_lines',
  'erp_credit_notes',
  'erp_credit_note_lines',
  'erp_payment_receipts',
  'erp_payment_allocations',
  'erp_asset_settings',
  'erp_assets',
  'erp_asset_events',
  'erp_work_order_assets',
  'erp_ledger_accounts',
  'erp_ledger_settings',
  'erp_ledger_periods',
  'erp_ledger_period_events',
  'erp_journals',
  'erp_journal_lines',
  'erp_ledger_year_closes',
  'erp_ledger_postings',
  'member_grants',
  'hr_employees',
  'hr_expense_categories',
  'hr_expense_claims',
  'hr_payroll_rule_sets',
  'hr_pay_terms',
  'hr_payroll_runs',
  'hr_payroll_lines',
  'erp_boms',
  'erp_bom_components',
  'erp_assembly_orders',
  'erp_mrp_plans',
  'erp_mrp_suggestions',
  'erp_supplier_prices',
  'erp_sales_deliveries',
  'erp_sales_delivery_lines',
  'erp_van_requests',
  'erp_van_request_lines',
  'erp_work_order_purchases',
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
