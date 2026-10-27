import {
  findTransition,
  ETA_ATTEMPT_KINDS,
  ETA_ATTEMPT_OUTCOMES,
  ETA_DOCUMENT_KINDS,
  ETA_DOCUMENT_STATES,
  ETA_ENVIRONMENTS,
  ETA_ITEM_TYPES,
  ETA_MAPPABLE_UNITS,
  ETA_RECEIVER_TYPES,
  ETA_SIGNING_STATUSES,
  ACTIVITY_KINDS,
  ACTIVITY_STATUSES,
  ITEM_KINDS,
  LOCATION_KINDS,
  MATERIAL_STATUSES,
  MOVEMENT_KINDS,
  PURCHASE_ORDER_STATUSES,
  QUOTE_STATUSES,
  INVOICE_STORED_STATUSES,
  CREDIT_NOTE_STATUSES,
  PAYMENT_METHODS,
  ASSET_STATUSES,
  ASSET_CONDITIONS,
  ASSET_EVENT_KINDS,
  ACCOUNT_TYPES,
  JOURNAL_STATUSES,
  JOURNAL_KINDS,
  JOURNAL_SOURCE_KINDS,
  PERIOD_EVENT_KINDS,
  SALES_ORDER_STATUSES,
  STOCK_COUNT_STATUSES,
  SUPPLIER_STATUSES,
  UNITS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  OPPORTUNITY_EVENT_KINDS,
  OPPORTUNITY_STATUSES,
  STAGE_OUTCOMES,
  ROLES,
  GRANTS,
  EXPENSE_CLAIM_STATUSES,
  EXPENSE_SETTLEMENTS,
  EXPENSE_PAID_VIA,
  PAY_RUN_STATUSES,
  PAY_METHODS,
  ASSEMBLY_ORDER_STATUSES,
  ASSEMBLY_DIRECTIONS,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATES,
  VISIT_STATUSES,
  QUALIFICATION_KINDS,
  INTERVAL_UNITS,
  PLAN_COUNTINGS,
  PLAN_STATUSES,
  OCCURRENCE_STATUSES,
  OCCURRENCE_SKIP_REASONS,
  COVERAGE_STATUSES,
  COVERAGE_REASONS,
  DEADLINE_CLOCKS,
} from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEDGER_POSTING_REASONS,
  LEDGER_POSTING_STATUSES,
  PLATFORM_TABLES,
  SECURITY_DEFINER_FUNCTIONS,
  SECURITY_DEFINER_VIEWS,
  TENANT_SCOPED_TABLES,
} from '../schema.js';
import { connectAsOwner, createTenant } from './harness.js';

/**
 * Rules about the schema as a whole, checked against the live catalogue.
 *
 * These are the tests that keep working after P02 is finished. Every phase from
 * here to P35 adds tables, and each one is an opportunity to add a table with
 * no `tenant_id`, or with one that is nullable, or with RLS left off. Reviewing
 * for that by eye works until the afternoon it does not.
 *
 * A new table is therefore tenant-scoped by default as far as this suite is
 * concerned, and opting out means adding its name to `PLATFORM_TABLES` — one
 * line, in a file about tenancy, that a reviewer will read.
 */

let owner: pg.Client;

beforeAll(async () => {
  owner = await connectAsOwner();
});

afterAll(async () => {
  await owner.end();
});

async function publicTables(): Promise<string[]> {
  const result = await owner.query<{ table_name: string }>(`
    select c.relname::text as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  `);
  return result.rows.map((row) => row.table_name);
}

describe('the shape of every table', () => {
  it('has row-level security enabled on every table in public, with no exceptions', async () => {
    const result = await owner.query<{ table_name: string }>(`
      select c.relname::text as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
      order by c.relname
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([]);
  });

  it('gives every tenant-scoped table a non-null tenant_id', async () => {
    const tables = (await publicTables()).filter(
      (table) => !(PLATFORM_TABLES as readonly string[]).includes(table),
    );

    for (const table of tables) {
      const result = await owner.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = $1 and column_name = 'tenant_id'`,
        [table],
      );

      expect(result.rows[0], `${table} has no tenant_id column`).toBeDefined();
      expect(result.rows[0]?.is_nullable, `${table}.tenant_id is nullable`).toBe('NO');
    }
  });

  it('gives every tenant_id a foreign key to tenants', async () => {
    const tables = (await publicTables()).filter(
      (table) => !(PLATFORM_TABLES as readonly string[]).includes(table),
    );

    for (const table of tables) {
      const result = await owner.query<{ constraint_name: string }>(
        `select con.conname::text as constraint_name
         from pg_constraint con
         join pg_class child on child.oid = con.conrelid
         join pg_class parent on parent.oid = con.confrelid
         join pg_attribute att on att.attrelid = child.oid and att.attnum = any(con.conkey)
         where con.contype = 'f'
           and child.relname = $1
           and parent.relname = 'tenants'
           and att.attname = 'tenant_id'`,
        [table],
      );

      expect(result.rows.length, `${table}.tenant_id has no FK to tenants`).toBeGreaterThan(0);
    }
  });

  it('gives every tenant-scoped table a policy keyed on the tenant context', async () => {
    for (const table of TENANT_SCOPED_TABLES) {
      const result = await owner.query<{ policyname: string; qual: string | null }>(
        `select policyname::text, qual::text from pg_policies
         where schemaname = 'public' and tablename = $1`,
        [table],
      );

      expect(result.rows.length, `${table} has no policy`).toBeGreaterThan(0);
      expect(
        result.rows.some((row) => row.qual?.includes('app_current_tenant_id') === true),
        `${table} has no policy using app_current_tenant_id()`,
      ).toBe(true);
    }
  });

  it('lists exactly the tables the TypeScript schema declares', async () => {
    const expected = [...PLATFORM_TABLES, ...TENANT_SCOPED_TABLES].sort((a, b) =>
      a.localeCompare(b),
    );

    expect(await publicTables()).toEqual(expected);
  });
});

describe('views, the easiest way to lose isolation', () => {
  /**
   * A view created without `security_invoker` runs with its owner's privileges,
   * so it reads past every RLS policy on the tables underneath it. That is
   * occasionally exactly what is wanted — `auth_memberships` exists because
   * sign-in has to see across companies — and it is otherwise a cross-tenant
   * read added by accident, in a diff that looks like a convenience.
   *
   * So views are allow-listed, and an unlisted one fails the build.
   */
  it('has no view in public that is not declared in SECURITY_DEFINER_VIEWS', async () => {
    const result = await owner.query<{ view_name: string }>(`
      select c.relname::text as view_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
      order by c.relname
    `);

    expect(result.rows.map((row) => row.view_name)).toEqual(
      [...SECURITY_DEFINER_VIEWS].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('exposes only identity, company, role and status through auth_memberships', async () => {
    const result = await owner.query<{ column_name: string }>(
      `select column_name::text as column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'auth_memberships'
       order by column_name`,
    );

    // Adding a column here — an email address, say — would widen the one
    // deliberate cross-tenant read in the schema.
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'role',
      'status',
      'tenant_id',
      'user_id',
    ]);
  });
});

describe('functions that run as their owner', () => {
  /**
   * The same hazard as a security-definer view, in a different shape: the
   * function reads with the owner's privileges whatever role called it. They
   * are allow-listed for the same reason.
   */
  it('has no security-definer function in public that is not declared', async () => {
    const result = await owner.query<{ name: string }>(`
      select p.proname::text as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
      order by p.proname
    `);

    expect(result.rows.map((row) => row.name)).toEqual(
      [...SECURITY_DEFINER_FUNCTIONS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

  it('pins search_path on every one of them', async () => {
    // A security-definer function resolving names through the caller's path
    // can be handed a lookalike table in a schema the caller controls.
    const result = await owner.query<{ name: string; config: string[] | null }>(`
      select p.proname::text as name, p.proconfig as config
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
    `);

    for (const row of result.rows) {
      expect(
        (row.config ?? []).some((setting) => setting.startsWith('search_path=')),
        `${row.name} has no pinned search_path`,
      ).toBe(true);
    }
  });
});

describe('the pre-authentication role', () => {
  async function authPrivileges(): Promise<{ table: string; privilege: string }[]> {
    const result = await owner.query<{ table_name: string; privilege_type: string }>(
      `select table_name::text as table_name, privilege_type::text as privilege_type
       from information_schema.role_table_grants
       where grantee = 'integr8_auth' and table_schema = 'public'
       order by table_name, privilege_type`,
    );
    return result.rows.map((row) => ({ table: row.table_name, privilege: row.privilege_type }));
  }

  it('reaches exactly six objects and no more', async () => {
    const reachable = [...new Set((await authPrivileges()).map((entry) => entry.table))].sort(
      (a, b) => a.localeCompare(b),
    );

    // Every name here is a deliberate exception to tenant scoping, so the list
    // is asserted exactly rather than loosely. Adding one is a line a reviewer
    // sees, in a test about the thing being widened.
    expect(reachable).toEqual([
      'account_locks',
      'auth_memberships',
      'identities',
      'identity_magic_links',
      'login_attempts',
      'rate_limit_buckets',
    ]);
  });

  it('cannot delete an identity, only its spent links', async () => {
    const privileges = await authPrivileges();
    const on = (table: string) =>
      privileges.filter((entry) => entry.table === table).map((entry) => entry.privilege);

    expect(on('identities')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(on('identity_magic_links')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('holds no privilege on any tenant-scoped table', async () => {
    const scoped = (await authPrivileges()).filter((entry) =>
      (TENANT_SCOPED_TABLES as readonly string[]).includes(entry.table),
    );

    expect(scoped).toEqual([]);
  });

  it('can read memberships but not write them', async () => {
    const onView = (await authPrivileges())
      .filter((entry) => entry.table === 'auth_memberships')
      .map((entry) => entry.privilege);

    expect(onView).toEqual(['SELECT']);
  });

  it('cannot delete a login attempt, so the record of an attack survives it', async () => {
    const onAttempts = (await authPrivileges())
      .filter((entry) => entry.table === 'login_attempts')
      .map((entry) => entry.privilege);

    expect(onAttempts).toEqual(['INSERT', 'SELECT']);
  });

  it('is neither a superuser nor a BYPASSRLS role nor an owner', async () => {
    const role = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'integr8_auth'`,
    );

    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);

    const owned = await owner.query(
      `select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and pg_get_userbyid(c.relowner) = 'integr8_auth'`,
    );

    expect(owned.rowCount).toBe(0);
  });
});

describe('tenant-scoped foreign keys carry the tenant', () => {
  /**
   * `references sessions (id)` alone would let a refresh token in one company
   * name a session in another: both are valid uuids and nothing would object.
   * Every foreign key between two tenant-scoped tables therefore includes
   * `tenant_id`, which turns that from a leak RLS has to catch on the way out
   * into a foreign-key violation on the way in.
   */
  it('includes tenant_id in every foreign key between two tenant-scoped tables', async () => {
    const result = await owner.query<{
      constraint_name: string;
      child: string;
      parent: string;
      columns: string[];
    }>(
      `select
         con.conname::text                                as constraint_name,
         child.relname::text                              as child,
         parent.relname::text                             as parent,
         array_agg(att.attname::text order by att.attnum) as columns
       from pg_constraint con
       join pg_class child  on child.oid  = con.conrelid
       join pg_class parent on parent.oid = con.confrelid
       join pg_attribute att on att.attrelid = child.oid and att.attnum = any(con.conkey)
       where con.contype = 'f'
         and child.relname  = any($1::text[])
         and parent.relname = any($1::text[])
       group by 1, 2, 3`,
      [[...TENANT_SCOPED_TABLES]],
    );

    const missing = result.rows.filter((row) => !row.columns.includes('tenant_id'));

    expect(missing.map((row) => `${row.constraint_name} (${row.child} -> ${row.parent})`)).toEqual(
      [],
    );
    // And there is at least one such key, so the check is not vacuous.
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe('what the runtime role may do', () => {
  async function privileges(table: string): Promise<string[]> {
    const result = await owner.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
       where grantee = 'integr8_app' and table_schema = 'public' and table_name = $1
       order by privilege_type`,
      [table],
    );
    return result.rows.map((row) => row.privilege_type);
  }

  it('has no privilege whatsoever on platform_users', async () => {
    expect(await privileges('platform_users')).toEqual([]);
  });

  it('has no privilege on the migration history', async () => {
    expect(await privileges('schema_migrations')).toEqual([]);
  });

  it('cannot reach the pre-authentication tables or the cross-tenant view', async () => {
    expect(await privileges('login_attempts')).toEqual([]);
    expect(await privileges('account_locks')).toEqual([]);
    expect(await privileges('auth_memberships')).toEqual([]);
    expect(await privileges('rate_limit_buckets')).toEqual([]);
  });

  it('cannot delete a session, an invitation or an impersonation grant', async () => {
    // Revocation sets a timestamp and a reason. "Revoked at 14:02 for
    // refresh_token_reuse" is what an incident needs, and a deleted row cannot
    // say it.
    for (const table of [
      'sessions',
      'refresh_tokens',
      'offline_grants',
      'invitations',
      'impersonation_grants',
      'idempotency_keys',
      'jobs',
    ]) {
      expect(await privileges(table), table).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    }
  });

  it('may delete only rate-limit counters, and only through the gateway role', async () => {
    // The single exception to append-or-revoke in this schema. A spent counter
    // has no evidentiary value; a login attempt does, which is why that one is
    // insert-only.
    const onBuckets = (
      await owner.query<{ privilege_type: string }>(
        `select privilege_type::text as privilege_type
       from information_schema.role_table_grants
       where grantee = 'integr8_auth' and table_name = 'rate_limit_buckets'
       order by privilege_type`,
      )
    ).rows.map((row) => row.privilege_type);

    expect(onBuckets).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('may only read tenants', async () => {
    expect(await privileges('tenants')).toEqual(['SELECT']);
  });

  it('may read and append audit_log, and nothing else', async () => {
    expect(await privileges('audit_log')).toEqual(['INSERT', 'SELECT']);
  });

  it('may only read the global template library, which belongs to no company', async () => {
    expect(await privileges('form_templates')).toEqual(['SELECT']);
  });

  it('is neither a superuser nor a BYPASSRLS role nor an owner', async () => {
    const role = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'integr8_app'`,
    );

    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);

    const owned = await owner.query(
      `select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and pg_get_userbyid(c.relowner) = 'integr8_app'`,
    );

    expect(owned.rowCount).toBe(0);
  });
});

describe('vocabularies shared with the application', () => {
  it('accepts exactly the roles @integr8/core defines', async () => {
    const result = await owner.query<{ definition: string }>(
      `select pg_get_constraintdef(oid)::text as definition
       from pg_constraint where conname = 'tenant_users_role_known'`,
    );

    const definition = result.rows[0]?.definition ?? '';
    for (const role of ROLES) {
      expect(definition, `the database rejects the role "${role}"`).toContain(`'${role}'`);
    }

    // And nothing beyond them: one quoted literal per known role.
    expect((definition.match(/'[a-z_]+'/gu) ?? []).length).toBe(ROLES.length);
  });

  it('lets a form be filled by exactly the roles @integr8/core defines', async () => {
    const result = await owner.query<{ definition: string }>(
      `select pg_get_constraintdef(oid)::text as definition
       from pg_constraint where conname = 'forms_fill_roles_known'`,
    );

    const definition = result.rows[0]?.definition ?? '';
    for (const role of ROLES) {
      expect(definition, `a form cannot be filled by "${role}"`).toContain(`'${role}'`);
    }
    expect((definition.match(/'[a-z_]+'/gu) ?? []).length).toBe(ROLES.length);
  });

  it('moves a work order along exactly the transitions @integr8/core defines', async () => {
    // Every ordered pair of states, asked of the database's own table. A
    // transition the UI offers and the server refuses — or the reverse — fails here.
    const disagreements: string[] = [];
    for (const from of WORK_ORDER_STATES) {
      for (const to of WORK_ORDER_STATES) {
        const result = await owner.query<{ allowed: boolean }>(
          'select work_order_transition_allowed($1, $2) as allowed',
          [from, to],
        );
        const inDatabase = result.rows[0]?.allowed === true;
        const inCore = findTransition(from, to) !== undefined;
        if (inDatabase !== inCore) {
          disagreements.push(
            `${from} → ${to}: database ${String(inDatabase)}, core ${String(inCore)}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('knows exactly the work order states and priorities @integr8/core defines', async () => {
    for (const [constraint, vocabulary] of [
      ['work_orders_state_known', WORK_ORDER_STATES],
      ['work_order_visits_status_known', VISIT_STATUSES],
      ['qualification_types_kind_known', QUALIFICATION_KINDS],
      ['work_orders_priority_known', WORK_ORDER_PRIORITIES],
      ['job_types_priority_known', WORK_ORDER_PRIORITIES],
      // CRM (0024): the lead vocabulary the screens offer is the one the
      // database accepts.
      ['crm_leads_status_known', LEAD_STATUSES],
      ['crm_leads_source_known', LEAD_SOURCES],
      // CRM (0025): opportunities, stages, their history and activities.
      ['crm_opportunities_status_known', OPPORTUNITY_STATUSES],
      ['crm_pipeline_stages_outcome_known', STAGE_OUTCOMES],
      ['crm_opportunity_events_kind_known', OPPORTUNITY_EVENT_KINDS],
      ['crm_activities_kind_known', ACTIVITY_KINDS],
      ['crm_activities_status_known', ACTIVITY_STATUSES],
      // Inventory (0026).
      ['erp_items_kind_known', ITEM_KINDS],
      ['erp_items_unit_known', UNITS],
      ['erp_stock_locations_kind_known', LOCATION_KINDS],
      ['erp_stock_movements_kind_known', MOVEMENT_KINDS],
      ['erp_stock_counts_status_known', STOCK_COUNT_STATUSES],
      // Purchasing (0027).
      ['erp_suppliers_status_known', SUPPLIER_STATUSES],
      ['erp_purchase_orders_status_known', PURCHASE_ORDER_STATUSES],
      ['erp_work_order_materials_status_known', MATERIAL_STATUSES],
      // Sales (0029).
      ['crm_quotes_status_known', QUOTE_STATUSES],
      ['erp_sales_orders_status_known', SALES_ORDER_STATUSES],
      // Finance (0030).
      ['erp_invoices_status_known', INVOICE_STORED_STATUSES],
      ['erp_credit_notes_status_known', CREDIT_NOTE_STATUSES],
      ['erp_payment_receipts_method_known', PAYMENT_METHODS],
      // Assets (0031).
      ['erp_assets_status_known', ASSET_STATUSES],
      ['erp_assets_condition_known', ASSET_CONDITIONS],
      ['erp_asset_events_kind_known', ASSET_EVENT_KINDS],
      // Ledger (0033).
      ['erp_ledger_accounts_type_known', ACCOUNT_TYPES],
      ['erp_journals_status_known', JOURNAL_STATUSES],
      ['erp_journals_kind_known', JOURNAL_KINDS],
      ['erp_journals_source_kind_known', JOURNAL_SOURCE_KINDS],
      ['erp_ledger_period_events_kind_known', PERIOD_EVENT_KINDS],
      // Automatic postings (0034).
      ['erp_ledger_postings_source_kind_known', JOURNAL_SOURCE_KINDS],
      ['erp_ledger_postings_status_known', LEDGER_POSTING_STATUSES],
      ['erp_ledger_postings_reason_known', LEDGER_POSTING_REASONS],
      // Roles and grants (0036).
      ['invitations_role_known', ROLES],
      ['member_grants_capability_known', GRANTS],
      // Expense claims (0037).
      ['hr_expense_claims_status_known', EXPENSE_CLAIM_STATUSES],
      ['hr_expense_claims_settle_via_known', EXPENSE_SETTLEMENTS],
      ['hr_expense_claims_paid_via_known', EXPENSE_PAID_VIA],
      // Payroll (0038).
      ['hr_payroll_runs_status_known', PAY_RUN_STATUSES],
      ['hr_pay_terms_pay_method_known', PAY_METHODS],
      ['hr_payroll_lines_pay_method_known', PAY_METHODS],
      // Manufacturing (0039).
      ['erp_assembly_orders_status_known', ASSEMBLY_ORDER_STATUSES],
      ['erp_assembly_orders_direction_known', ASSEMBLY_DIRECTIONS],
      // E-invoicing (0049).
      ['eta_settings_environment_known', ETA_ENVIRONMENTS],
      ['eta_documents_environment_known', ETA_ENVIRONMENTS],
      ['eta_documents_state_known', ETA_DOCUMENT_STATES],
      ['eta_documents_kind_known', ETA_DOCUMENT_KINDS],
      ['eta_receivers_type_known', ETA_RECEIVER_TYPES],
      ['eta_item_codes_type_known', ETA_ITEM_TYPES],
      ['eta_unit_types_unit_known', ETA_MAPPABLE_UNITS],
      ['eta_attempts_kind_known', ETA_ATTEMPT_KINDS],
      ['eta_attempts_outcome_known', ETA_ATTEMPT_OUTCOMES],
      ['eta_signing_requests_status_known', ETA_SIGNING_STATUSES],
      ['eta_schemas_environment_known', ETA_ENVIRONMENTS],
      // Maintenance plans, contracts and deadlines (0053).
      ['maintenance_plans_interval_unit_known', INTERVAL_UNITS],
      ['maintenance_plans_counting_known', PLAN_COUNTINGS],
      ['maintenance_plans_status_known', PLAN_STATUSES],
      ['maintenance_occurrences_status_known', OCCURRENCE_STATUSES],
      ['maintenance_occurrences_skip_reason_known', OCCURRENCE_SKIP_REASONS],
      ['work_order_coverage_status_known', COVERAGE_STATUSES],
      ['work_order_coverage_reason_known', COVERAGE_REASONS],
      ['deadline_rules_priority_known', WORK_ORDER_PRIORITIES],
      ['deadline_rules_clock_known', DEADLINE_CLOCKS],
      ['work_order_deadlines_priority_known', WORK_ORDER_PRIORITIES],
      ['work_order_deadlines_clock_known', DEADLINE_CLOCKS],
    ] as const) {
      const result = await owner.query<{ definition: string }>(
        `select pg_get_constraintdef(oid)::text as definition from pg_constraint where conname = $1`,
        [constraint],
      );
      const definition = result.rows[0]?.definition ?? '';
      for (const value of vocabulary) {
        expect(definition, `${constraint} rejects "${value}"`).toContain(`'${value}'`);
      }
      expect((definition.match(/'[A-Za-z0-9_]+'/gu) ?? []).length, constraint).toBe(
        vocabulary.length,
      );
    }
  });

  it('refuses a role the application does not define', async () => {
    // The company is created here rather than borrowed with `from tenants
    // limit 1`. When the table happened to be empty that insert wrote zero
    // rows, succeeded, and failed the test for a reason unrelated to roles —
    // and had it been written as `.resolves`, it would have passed forever.
    const tenant = await createTenant('role-vocabulary');

    await expect(
      owner.query(
        `insert into tenant_users (tenant_id, user_id, email, display_name, role)
         values ($1, gen_random_uuid(), 'x@y.example', 'X', 'superadmin')`,
        [tenant.id],
      ),
    ).rejects.toThrow(/tenant_users_role_known/u);
  });
});

describe('the two identity spaces', () => {
  it('refuses to give a platform user a company membership', async () => {
    const platform = await owner.query<{ id: string }>(
      `insert into platform_users (email, display_name)
       values ('invariant.check@integr8.example', 'Invariant Check')
       on conflict (email) do update set display_name = excluded.display_name
       returning id`,
    );
    const platformUserId = platform.rows[0]?.id;
    expect(platformUserId).toBeDefined();

    const tenant = await owner.query<{ id: string }>(
      `insert into tenants (slug, name) values ('invariant-check', 'Invariant Check Ltd')
       on conflict (slug) do update set name = excluded.name
       returning id`,
    );

    await expect(
      owner.query(
        `insert into tenant_users (tenant_id, user_id, email, display_name, role)
         values ($1, $2, 'invariant.check@integr8.example', 'Invariant Check', 'owner')`,
        [tenant.rows[0]?.id, platformUserId],
      ),
    ).rejects.toThrow(/cannot hold a tenant membership/u);
  });
});
