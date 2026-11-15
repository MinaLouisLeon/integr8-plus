import pg from 'pg';

/**
 * Fills a disposable database with companies the size real ones grow to (P41).
 *
 * Query plans depend on how many rows there are, and a development database
 * has none, so a slow query only shows itself in production. This writes years
 * of made-up work straight from SQL, a few million rows in minutes, so the plan
 * suite (`plans.ts`) and a person running EXPLAIN see what a busy server sees.
 *
 * It is not the demo seeder. That one goes through the API and makes data the
 * screens can show; this one makes volume, with triggers switched off for the
 * session (`session_replication_role = replica`), so numbering, history and
 * stock balances are not kept. Every row still satisfies its table's checks,
 * and every key points at a row that exists, with deterministic ids
 * (`md5(company, kind, n)`) standing in for the joins.
 *
 * Companies are made as test companies (`is_test`), so billing, totals and real
 * mail leave them alone, and their slugs start with `volume-`.
 */

export interface VolumeOptions {
  /** How many companies. The first is the largest; the rest shrink like real customers do. */
  companies: number;
  /** How many years of history each company has, ending now. */
  years: number;
  /** Multiplies every count. 1 is a large company (about 20,000 jobs a year). */
  scale: number;
  /** Called after each company, for progress. */
  onCompany?: (report: CompanyReport) => void;
}

export interface CompanyReport {
  index: number;
  slug: string;
  workOrders: number;
  milliseconds: number;
}

/** Counts for a company of factor 1; per year where the name says so. */
const BASE = {
  users: 60,
  customers: 3_000,
  sitesPerCustomer: 1.5,
  jobTypes: 12,
  forms: 15,
  items: 2_000,
  ledgerAccounts: 40,
  assets: 3_000,
  employees: 60,
  workOrdersPerYear: 20_000,
  leadsPerYear: 1_000,
  activitiesPerYear: 4_000,
} as const;

/** How much smaller each following company is: 1, 1/2, 1/3 … never below 5%. */
function factor(index: number, scale: number): number {
  return Math.max(0.05, 1 / (index + 1)) * scale;
}

function count(base: number, f: number): number {
  return Math.max(1, Math.round(base * f));
}

export async function generateVolume(
  connectionString: string,
  options: VolumeOptions,
): Promise<CompanyReport[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const reports: CompanyReport[] = [];
  try {
    await client.query(`set session_replication_role = replica`);
    await client.query(`set statement_timeout = 0`);
    await client.query(`
      create or replace function pg_temp.vid(tenant uuid, kind text, n bigint) returns uuid
        language sql immutable as $$ select md5(tenant::text || ':' || kind || ':' || n)::uuid $$`);
    // A day within the company's history, spread evenly: n of total.
    await client.query(`
      create or replace function pg_temp.vday(n bigint, total bigint, years integer) returns timestamptz
        language sql immutable as
        $$ select now() - make_interval(secs => (years * 365.0 * 86400) * (1 - n::numeric / greatest(total, 1))) $$`);

    for (let index = 0; index < options.companies; index += 1) {
      const started = Date.now();
      const f = factor(index, options.scale);
      const slug = `volume-${String(index + 1).padStart(3, '0')}-${Date.now().toString(36)}`;
      const workOrders = count(BASE.workOrdersPerYear * options.years, f);
      await client.query('begin');
      try {
        await generateCompany(client, { slug, f, years: options.years, workOrders });
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      const report = { index, slug, workOrders, milliseconds: Date.now() - started };
      reports.push(report);
      options.onCompany?.(report);
    }

    // The planner needs statistics for what was just written.
    await client.query('set session_replication_role = origin');
    await client.query('analyze');
  } finally {
    await client.end();
  }
  return reports;
}

interface CompanyPlan {
  slug: string;
  f: number;
  years: number;
  workOrders: number;
}

async function generateCompany(client: pg.Client, plan: CompanyPlan): Promise<void> {
  const { f, years } = plan;
  const tenant = (
    await client.query<{ id: string }>(
      `insert into tenants (slug, name, plan, is_test) values ($1, $2, 'standard', true) returning id`,
      [plan.slug, `Volume company ${plan.slug}`],
    )
  ).rows[0]?.id;
  if (tenant === undefined) {
    throw new Error('the company was not created');
  }

  const n = {
    // At least the eight office roles and a couple of engineers.
    users: Math.max(10, count(BASE.users, f)),
    customers: count(BASE.customers, f),
    sites: count(BASE.customers * BASE.sitesPerCustomer, f),
    jobTypes: Math.min(BASE.jobTypes, count(BASE.jobTypes, f)),
    forms: Math.min(BASE.forms, count(BASE.forms, f)),
    items: count(BASE.items, f),
    accounts: BASE.ledgerAccounts,
    assets: count(BASE.assets, f),
    employees: count(BASE.employees, f),
    workOrders: plan.workOrders,
    leads: count(BASE.leadsPerYear * years, f),
    activities: count(BASE.activitiesPerYear * years, f),
  };
  const p = [tenant, years] as const;
  // Every statement gets the company ($1) and the years ($2); the unused CTE
  // gives $2 a type in the statements that do not otherwise mention it.
  const run = (text: string, extra: readonly unknown[] = []): Promise<pg.QueryResult> =>
    client.query(`with volume_years as (select $2::int as years) ${text}`, [...p, ...extra]);

  // People. The first is the owner; engineers make up most of the rest.
  await run(
    `insert into tenant_users (id, tenant_id, user_id, email, display_name, role, status)
     select pg_temp.vid($1, 'member', g), $1, pg_temp.vid($1, 'user', g),
            'person' || g || '@' || replace($1::text, '-', '') || '.volume.test', 'Person ' || g,
            case when g = 1 then 'owner' when g <= 3 then 'admin' when g <= 6 then 'dispatcher'
                 when g = 7 then 'accountant' when g = 8 then 'inventory_manager' else 'engineer' end,
            'active'
       from generate_series(1, $3::int) g`,
    [n.users],
  );
  const owner = `pg_temp.vid($1, 'user', 1)`;
  // People 9 and up are engineers.
  const engineer = (expr: string): string =>
    `pg_temp.vid($1, 'user', 9 + (${expr}) % ${String(n.users - 8)})`;

  await run(
    `insert into customers (id, tenant_id, name, account_number, email, phone, city, status, created_by, created_at)
     select pg_temp.vid($1, 'customer', g), $1, 'Customer ' || g || ' ' || substr(md5(g::text), 1, 6),
            'C' || lpad(g::text, 6, '0'), 'customer' || g || '@example.test', '+20 10 ' || lpad(g::text, 8, '0'),
            (array['Cairo', 'Giza', 'Alexandria', 'Mansoura', 'Tanta'])[1 + g % 5],
            case when g % 50 = 0 then 'closed' else 'active' end, ${owner},
            pg_temp.vday(g, $3::int, $2::int)
       from generate_series(1, $3::int) g`,
    [n.customers],
  );
  await run(
    `insert into sites (id, tenant_id, customer_id, name, address_line1, city, created_by, created_at)
     select pg_temp.vid($1, 'site', g), $1, pg_temp.vid($1, 'customer', 1 + g % $4::int),
            'Site ' || g, g || ' Nile Street', (array['Cairo', 'Giza', 'Alexandria'])[1 + g % 3], ${owner},
            pg_temp.vday(g, $3::int, $2::int)
       from generate_series(1, $3::int) g`,
    [n.sites, n.customers],
  );
  await run(
    `insert into job_types (id, tenant_id, name, code, created_by)
     select pg_temp.vid($1, 'job_type', g), $1, 'Job type ' || g, 'JT' || g, ${owner}
       from generate_series(1, $3::int) g`,
    [n.jobTypes],
  );

  // Forms, each with one published version of eight reportable fields.
  await run(
    `insert into forms (id, tenant_id, title, created_by)
     select pg_temp.vid($1, 'form', g), $1, 'Inspection form ' || g, ${owner}
       from generate_series(1, $3::int) g`,
    [n.forms],
  );
  await run(
    `insert into form_versions (id, tenant_id, form_id, status, version_number, definition, definition_schema_version,
                                reportable_fields, published_at, published_by, created_by)
     select pg_temp.vid($1, 'form_version', g), $1, pg_temp.vid($1, 'form', g), 'published', 1,
            jsonb_build_object('schemaVersion', 1, 'pages', '[]'::jsonb), 1,
            (select jsonb_agg(jsonb_build_object('field', 'f' || k, 'type', case when k <= 4 then 'number' else 'text' end))
               from generate_series(1, 8) k),
            now() - make_interval(years => $2::int), ${owner}, ${owner}
       from generate_series(1, $3::int) g`,
    [n.forms],
  );

  // Work orders over the years: most done, the latest still open.
  await run(
    `insert into work_orders (id, tenant_id, reference, customer_id, site_id, job_type_id, title, description, state,
                              priority, due_by, completed_at, reviewed_at, cancelled_at, state_changed_at,
                              last_actor, created_by, created_at, updated_at)
     select pg_temp.vid($1, 'work_order', g), $1, g,
            pg_temp.vid($1, 'customer', 1 + (1 + g % $5::int) % $4::int), pg_temp.vid($1, 'site', 1 + g % $5::int),
            pg_temp.vid($1, 'job_type', 1 + g % $6::int),
            'Service visit ' || g, 'Routine maintenance of unit ' || g,
            s.state, (array['low', 'normal', 'normal', 'high', 'urgent'])[1 + g % 5],
            d.at + interval '3 days',
            case when s.state in ('complete', 'reviewed') then d.at + interval '1 day' end,
            case when s.state = 'reviewed' then d.at + interval '2 days' end,
            case when s.state = 'cancelled' then d.at + interval '1 hour' end,
            d.at, ${owner}, ${owner}, d.at, d.at
       from generate_series(1, $3::int) g
       cross join lateral (select pg_temp.vday(g, $3::int, $2::int) as at) d
       cross join lateral (select case
            when g > $3::int * 0.98 then (array['scheduled', 'dispatched', 'in_progress', 'awaiting_parts'])[1 + g % 4]
            when g % 40 = 0 then 'cancelled'
            when g % 3 = 0 then 'complete'
            else 'reviewed' end as state) s`,
    [n.workOrders, n.customers, n.sites, n.jobTypes],
  );
  await run(
    `insert into work_order_assignments (tenant_id, work_order_id, user_id, is_lead, assigned_by, assigned_at)
     select $1, pg_temp.vid($1, 'work_order', g), ${engineer('g')}, true, ${owner}, pg_temp.vday(g, $3::int, $2::int)
       from generate_series(1, $3::int) g`,
    [n.workOrders],
  );
  await run(
    `insert into work_order_visits (id, tenant_id, work_order_id, starts_at, ends_at, status, completed_at, completed_by,
                                    last_actor, created_by, created_at)
     select pg_temp.vid($1, 'visit', g), $1, pg_temp.vid($1, 'work_order', g), d.at + interval '1 day',
            d.at + interval '1 day 2 hours', case when g > $3::int * 0.98 then 'planned' else 'done' end,
            case when g > $3::int * 0.98 then null else d.at + interval '1 day 2 hours' end,
            case when g > $3::int * 0.98 then null else ${engineer('g')} end,
            ${owner}, ${owner}, d.at
       from generate_series(1, $3::int) g
       cross join lateral (select pg_temp.vday(g, $3::int, $2::int) as at) d`,
    [n.workOrders],
  );
  await run(
    `insert into work_order_events (tenant_id, work_order_id, kind, from_state, to_state, actor_id, occurred_at)
     select $1, pg_temp.vid($1, 'work_order', g),
            case when k = 1 then 'created' else 'transitioned' end,
            case when k = 1 then null else (array['scheduled', 'dispatched', 'in_progress'])[k - 1] end,
            case when k = 1 then null else (array['dispatched', 'in_progress', 'complete'])[k - 1] end,
            ${owner}, pg_temp.vday(g, $3::int, $2::int) + make_interval(hours => k)
       from generate_series(1, $3::int) g, generate_series(1, 4) k`,
    [n.workOrders],
  );

  // A submitted form on every job, and its reportable values.
  await run(
    `insert into submissions (id, tenant_id, form_id, form_version_id, work_order_id, status, answers, submitted_by,
                              submitted_at, last_actor, created_at, updated_at)
     select pg_temp.vid($1, 'submission', g), $1, pg_temp.vid($1, 'form', 1 + g % $4::int),
            pg_temp.vid($1, 'form_version', 1 + g % $4::int), pg_temp.vid($1, 'work_order', g), 'submitted',
            jsonb_build_object('f1', g % 100, 'f2', g % 7, 'f5', 'Reading ' || g, 'f6', 'OK'),
            ${engineer('g')}, d.at + interval '1 day', ${engineer('g')}, d.at, d.at + interval '1 day'
       from generate_series(1, $3::int) g
       cross join lateral (select pg_temp.vday(g, $3::int, $2::int) as at) d`,
    [n.workOrders, n.forms],
  );
  await run(
    `insert into submission_values (tenant_id, submission_id, form_id, form_version_id, field_id, ordinal, value_type,
                                    value_text, value_number, submitted_at)
     select $1, pg_temp.vid($1, 'submission', g), pg_temp.vid($1, 'form', 1 + g % $4::int),
            pg_temp.vid($1, 'form_version', 1 + g % $4::int), 'f' || k, 0,
            case when k <= 4 then 'number' else 'text' end,
            case when k > 4 then 'Value ' || (g * k) % 997 end,
            case when k <= 4 then (g * k) % 1000 end,
            pg_temp.vday(g, $3::int, $2::int) + interval '1 day'
       from generate_series(1, $3::int) g, generate_series(1, 8) k`,
    [n.workOrders, n.forms],
  );

  // The audit log: six lines a job.
  await run(
    `insert into audit_log (tenant_id, occurred_at, actor_kind, actor_id, actor_label, action, resource_type, resource_id)
     select $1, pg_temp.vday(g, $3::int, $2::int) + make_interval(mins => k), 'tenant_user', ${owner}, 'Person 1',
            (array['work_order.created', 'work_order.updated', 'work_order.transitioned', 'submission.submitted',
                   'visit.done', 'work_order.reviewed'])[k],
            case when k = 4 then 'submission' else 'work_order' end, pg_temp.vid($1, 'work_order', g)::text
       from generate_series(1, $3::int) g, generate_series(1, 6) k`,
    [n.workOrders],
  );
  await run(
    `insert into sync_touches (tenant_id, entity_kind, entity_id, created_at)
     select $1, 'work_order', pg_temp.vid($1, 'work_order', g), pg_temp.vday(g, $3::int, $2::int) + make_interval(mins => k)
       from generate_series(1, $3::int) g, generate_series(1, 3) k`,
    [n.workOrders],
  );

  // Stock: items, a warehouse and vans, and the material each job used.
  await run(
    `insert into erp_items (id, tenant_id, sku, name, kind, unit, created_by)
     select pg_temp.vid($1, 'item', g), $1, 'SKU-' || lpad(g::text, 6, '0'), 'Part ' || g || ' ' || substr(md5(g::text), 1, 5),
            'stock_item', 'each', ${owner}
       from generate_series(1, $3::int) g`,
    [n.items],
  );
  await run(
    `insert into erp_stock_locations (id, tenant_id, name, kind)
     select pg_temp.vid($1, 'location', g), $1, case when g = 1 then 'Main warehouse' else 'Van ' || g end,
            case when g = 1 then 'warehouse' else 'van' end
       from generate_series(1, 8) g`,
  );
  await run(
    `insert into erp_stock_movements (tenant_id, posting_id, item_id, location_id, kind, quantity, unit_cost, source_key,
                                      actor_id, occurred_at)
     select $1, pg_temp.vid($1, 'posting', g * 2 + k), pg_temp.vid($1, 'item', 1 + (g * k) % $4::int),
            pg_temp.vid($1, 'location', 1 + k), case when k = 0 then 'receipt' else 'consumption' end,
            case when k = 0 then 5 else -1 end, 12.5, 'volume:' || g || ':' || k, ${owner},
            pg_temp.vday(g, $3::int, $2::int)
       from generate_series(1, $3::int) g, generate_series(0, 1) k`,
    [n.workOrders, n.items],
  );

  // Finance and the ledger: an invoice for most jobs, a payment for half, a
  // posted journal of two lines for each invoice.
  await run(
    `insert into erp_ledger_accounts (id, tenant_id, code, name, type, created_by)
     select pg_temp.vid($1, 'account', g), $1, (1000 + g * 10)::text, 'Account ' || g,
            (array['asset', 'liability', 'equity', 'income', 'expense'])[1 + g % 5], ${owner}
       from generate_series(1, $3::int) g`,
    [n.accounts],
  );
  const invoices = Math.round(n.workOrders * 0.6);
  await run(
    `insert into erp_invoices (id, tenant_id, customer_id, work_order_id, currency_code, status, reference, issue_date,
                               due_date, issued_at, issued_by, customer_name, issuer, created_by, created_at)
     select pg_temp.vid($1, 'invoice', g), $1, pg_temp.vid($1, 'customer', 1 + g % $4::int),
            pg_temp.vid($1, 'work_order', g), 'EGP', 'issued', g, d.at::date, d.at::date + 30, d.at, ${owner},
            'Customer ' || (1 + g % $4::int), '{}'::jsonb, ${owner}, d.at
       from generate_series(1, $3::int) g
       cross join lateral (select pg_temp.vday(g, $3::int, $2::int) as at) d`,
    [invoices, n.customers],
  );
  await run(
    `insert into erp_invoice_lines (tenant_id, invoice_id, position, description, quantity, unit_price, unit)
     select $1, pg_temp.vid($1, 'invoice', g), k, 'Labour and parts ' || k, 1 + k, 150 * k, 'each'
       from generate_series(1, $3::int) g, generate_series(1, 3) k`,
    [invoices],
  );
  await run(
    `insert into erp_payment_receipts (tenant_id, reference, customer_id, received_on, amount, currency_code, method, payment_reference,
                                       recorded_by)
     select $1, g, pg_temp.vid($1, 'customer', 1 + g % $4::int), pg_temp.vday(g, $3::int, $2::int)::date + 10, 900,
            'EGP', 'bank_transfer', 'TRX-' || lpad(g::text, 8, '0'), ${owner}
       from generate_series(1, $3::int) g`,
    [Math.round(invoices / 2), n.customers],
  );
  await run(
    `insert into erp_journals (id, tenant_id, kind, status, reference, entry_date, memo, source_kind, source_id,
                               drafted_by, posted_by, posted_at)
     select pg_temp.vid($1, 'journal', g), $1, 'automatic', 'posted', g, d.at::date, 'Invoice ' || g, 'invoice',
            pg_temp.vid($1, 'invoice', g), ${owner}, ${owner}, d.at
       from generate_series(1, $3::int) g
       cross join lateral (select pg_temp.vday(g, $3::int, $2::int) as at) d`,
    [invoices],
  );
  await run(
    `insert into erp_journal_lines (tenant_id, journal_id, entry_date, line_no, account_id, debit, credit, customer_id)
     select $1, pg_temp.vid($1, 'journal', g), pg_temp.vday(g, $3::int, $2::int)::date, k,
            pg_temp.vid($1, 'account', case when k = 1 then 1 else 4 end),
            case when k = 1 then 900 else 0 end, case when k = 2 then 900 else 0 end,
            case when k = 1 then pg_temp.vid($1, 'customer', 1 + g % $4::int) end
       from generate_series(1, $3::int) g, generate_series(1, 2) k`,
    [invoices, n.customers],
  );

  // CRM, assets and people.
  await run(
    `insert into crm_leads (id, tenant_id, display_name, company_name, email, status, source, created_by, created_at)
     select pg_temp.vid($1, 'lead', g), $1, 'Lead ' || g, 'Prospect ' || g, 'lead' || g || '@example.test',
            (array['new', 'contacted', 'qualified', 'unqualified'])[1 + g % 4], 'web', ${owner},
            pg_temp.vday(g, $3::int, $2::int)
       from generate_series(1, $3::int) g`,
    [n.leads],
  );
  await run(
    `insert into crm_activities (tenant_id, kind, subject, status, due_at, created_by, created_at)
     select $1, (array['call', 'email', 'meeting', 'note', 'follow_up', 'task'])[1 + g % 6], 'Follow up ' || g, 'open',
            pg_temp.vday(g, $3::int, $2::int) + interval '2 days', ${owner}, pg_temp.vday(g, $3::int, $2::int)
       from generate_series(1, $3::int) g`,
    [n.activities],
  );
  await run(
    `insert into erp_assets (tenant_id, reference, customer_id, site_id, name, make, model, serial_number, tag_code, created_by)
     select $1, g, pg_temp.vid($1, 'customer', 1 + (1 + g % $5::int) % $4::int), pg_temp.vid($1, 'site', 1 + g % $5::int),
            'Chiller ' || g, 'Carrier', 'Model ' || (g % 30), 'SN' || lpad(g::text, 9, '0'),
            translate(upper(substr(md5($1::text || g), 1, 12)), 'ILOU', '0123'), ${owner}
       from generate_series(1, $3::int) g`,
    [n.assets, n.customers, n.sites],
  );
  await run(
    `insert into hr_employees (tenant_id, full_name, employee_number, job_title, department, hire_date, created_by)
     select $1, 'Employee ' || g, 'E' || lpad(g::text, 5, '0'), 'Technician', 'Field', (now() - interval '3 years')::date,
            ${owner}
       from generate_series(1, $3::int) g`,
    [n.employees],
  );

  // Rows an earlier year left in the default partition get their own year.
  await client.query(`select ensure_year_partitions()`);
}
