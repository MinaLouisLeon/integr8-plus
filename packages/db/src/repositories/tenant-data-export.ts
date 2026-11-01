import { sql } from 'kysely';
import type { PlatformTable, TenantScopedTable } from '../schema.js';
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
 * appear in every customer's export the moment somebody adds it. Every table
 * that is left out is named in {@link NOT_EXPORTED_TABLES} with the reason, and
 * the export suite fails on a company table that is in neither list: this list
 * once went eight migrations without anybody adding documents, e-invoices,
 * visits or the company's own settings to it.
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
  // Token counters are the company's own (0046; ADR-0002). Members' shares and
  // spend are not exported: those rows carry the platform's dollar cap and
  // the provider's cost, which the company is never shown (ADR-0002 D7).
  'ai_token_periods',
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
  // Visits (0051): the days a job was scheduled on, and who was sent each day.
  'work_order_visits',
  'work_order_visit_assignees',
  // Skills and certificates (0052): what people hold and what jobs need.
  'qualification_types',
  'member_qualifications',
  'job_type_qualifications',
  'work_order_qualifications',
  'work_order_qualification_overrides',
  'forms',
  'form_versions',
  'submissions',
  'submission_events',
  'submission_values',
  'files',
  'attachments',
  // How the company works: timezone, currency, working hours, branding (0018).
  'tenant_settings',
  // PDF documents made from submissions (0048): the layouts, each document and
  // the fields it was made with. The PDF itself is in `files`.
  'document_templates',
  'documents',
  'document_field_values',
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
  'erp_payment_reversals',
  // E-invoicing (0049): what the company sent the Tax Authority, every call
  // about it and the answers. The submission history is a tax record, so it
  // goes wherever the invoices go. The sealed login and the signing nonces are
  // withheld below.
  'eta_settings',
  'eta_receivers',
  'eta_item_codes',
  'eta_unit_types',
  'eta_tax_mappings',
  'eta_documents',
  'eta_attempts',
  'eta_signing_requests',
  'erp_asset_settings',
  'erp_assets',
  'erp_asset_events',
  'erp_work_order_assets',
  // Contracts, maintenance plans and deadlines (0053). The contract counter is
  // working state and is left out.
  'service_contracts',
  'service_contract_sites',
  'service_contract_assets',
  'service_contract_job_types',
  'maintenance_plans',
  'maintenance_occurrences',
  'work_order_coverage',
  'deadline_rules',
  'work_order_deadlines',
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
] as const satisfies readonly TenantScopedTable[];

export type ExportedTable = (typeof EXPORTED_TABLES)[number];

/**
 * Columns left out of a table that is otherwise exported.
 *
 * Sealed values are ciphertext under a key only the API holds: in an archive
 * that leaves our hands they are of no use to the company and one more copy of
 * something that should exist in one place. The readable part stays (the last
 * four characters, the credentials hint). A hash or nonce that proves a link or
 * a signature is a credential, not a record.
 *
 * The columns are left out of the query itself, so a withheld value never
 * leaves the database on the export's account; the suite checks every name
 * here is still a real column, so renaming one cannot quietly export it.
 */
export const WITHHELD_COLUMNS: Readonly<Partial<Record<ExportedTable, readonly string[]>>> = {
  // The company's own login to the Tax Authority, which it holds itself.
  eta_settings: ['client_id_sealed', 'client_secret_sealed'],
  // Single-use proof that a signature answers this request.
  eta_signing_requests: ['nonce'],
  // National id, insurance and bank account numbers; their last four stay.
  hr_employees: ['national_id_sealed', 'insurance_number_sealed', 'bank_account_sealed'],
  // Verifies the link a customer opens a quote with.
  crm_quotes: ['access_token_hash'],
};

/**
 * Platform tables that carry a company's id, and so are a company's rows as
 * far as the catalogue is concerned, though the company never reads them.
 */
type PlatformTableWithCompany = Extract<
  PlatformTable,
  'announcements' | 'billing_events' | 'signup_events' | 'signup_requests' | 'website_keys'
>;

/**
 * Every company table that is not in {@link EXPORTED_TABLES}, and why.
 *
 * A record rather than a list so that a table missing from both is a compile
 * error naming it, as well as a failure in the export suite, which compares
 * both lists with every table whose `tenant_id` references `tenants`.
 */
export const NOT_EXPORTED_TABLES: Readonly<
  Record<Exclude<TenantScopedTable, ExportedTable> | PlatformTableWithCompany, string>
> = {
  // Credentials rather than data.
  sessions: 'Sign-in sessions: credentials, not records.',
  refresh_tokens: 'Hashes of sign-in tokens: credentials, not records.',
  offline_grants: "Phones' offline sign-in grants: credentials, not records.",
  invitations: 'Pending invitations carry a token hash: credentials, not records.',
  push_devices: "Phones' push notification tokens: credentials, not records.",
  website_keys:
    "Hashes of the company website's lookup keys, issued by Integr8 staff: credentials.",
  // This system's working state, which means nothing outside it.
  jobs: 'Background work queued for the worker.',
  idempotency_keys: 'Stored answers for retried requests.',
  sync_touches: 'Which rows changed since a phone last synced.',
  sync_log_marks: 'How far the sync change log reaches.',
  sync_reports: 'How each phone sync ran: diagnostics, not records.',
  upload_intents: 'Uploads asked for and not yet confirmed; confirmed ones are in files.',
  ai_message_reservations:
    'Whether each assistant request was charged; the answers are in ai_messages.',
  work_order_counters: 'The next work order number.',
  erp_purchase_order_counters: 'The next purchase order number.',
  sales_document_counters: 'The next quote, order and delivery numbers.',
  finance_document_counters: 'The next invoice, credit note and receipt numbers.',
  journal_reference_counters: 'The next journal number.',
  asset_reference_counters: 'The next asset number.',
  assembly_reference_counters: 'The next assembly order number.',
  expense_reference_counters: 'The next expense claim number.',
  service_contract_counters: 'The next contract number.',
  // Derived from rows that are exported.
  erp_stock_balances: 'Derived from erp_stock_movements, which is exported.',
  erp_stock_lot_balances: 'Derived from erp_stock_movements, which is exported.',
  // Integr8's records about the company rather than the company's own.
  tenant_feature_flags: 'Which modules Integr8 switched on: the platform configuration.',
  ai_tenant_policies: "The assistant allowance Integr8 set: the platform's configuration.",
  ai_member_limits: "Members' shares carry the platform's dollar cap (ADR-0002 D7).",
  ai_cost_periods: "The model provider's cost, never shown to the company (ADR-0002 D7).",
  ai_member_cost_periods: "The model provider's cost, never shown to the company (ADR-0002 D7).",
  ai_provider_calls: "The model provider's cost per call, never shown to the company.",
  impersonation_grants:
    'Integr8 staff access grants; each one is recorded in audit_log, which is exported.',
  subscriptions: "The company's plan with Integr8: our billing record.",
  billing_events: "The billing provider's notices to Integr8.",
  tenant_storage: 'Which bucket holds the files: our infrastructure.',
  tenant_storage_usage: 'Storage metering, kept by trigger from files.',
  tenant_storage_samples: 'Daily storage metering for billing.',
  storage_reconciliations: "Comparisons of our ledger with Cloudflare's bill.",
  signup_requests: 'A sign-up before the company existed, with a token hash.',
  signup_events: 'The anonymous sign-up funnel.',
  announcements: 'Banners Integr8 wrote; the runtime role cannot read them.',
  eta_schemas:
    "A cached copy of the Tax Authority's published JSON Schema, fetched again when needed.",
};

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
      const withheld = WITHHELD_COLUMNS[table];
      const rows =
        withheld === undefined
          ? await this.db
              .selectFrom(table)
              .selectAll()
              .where(`${table}.tenant_id`, '=', this.tenantId)
              .execute()
          : await this.db
              .selectFrom(table)
              .select(
                (await this.columnsOf(table))
                  .filter((column) => !withheld.includes(column))
                  .map((column) => this.db.dynamic.ref(column)),
              )
              .where(`${table}.tenant_id`, '=', this.tenantId)
              .execute();

      tables[table] = rows;
      counts[table] = rows.length;
    }

    return { tables, counts };
  }

  /**
   * A table's columns as the catalogue has them now, in table order, so a
   * column added later is exported without anybody remembering to list it.
   */
  private async columnsOf(table: ExportedTable): Promise<string[]> {
    const result = await sql<{ name: string }>`
      select attname::text as name
        from pg_attribute
       where attrelid = ${`public.${table}`}::regclass
         and attnum > 0
         and not attisdropped
       order by attnum`.execute(this.db);
    return result.rows.map((row) => row.name);
  }
}
