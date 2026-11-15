-- Tenants, platform staff, settings, feature flags, plans and the job queue.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'integr8_app')
     or not exists (select 1 from pg_roles where rolname = 'integr8_auth')
     or not exists (select 1 from pg_roles where rolname = 'integr8_platform') then
    raise exception
      'Roles integr8_app, integr8_auth and integr8_platform must exist. Run: pnpm --filter @integr8/db db bootstrap (see docs/database/README.md)'
      using errcode = 'undefined_object';
  end if;
end;
$$;

grant usage on schema public to integr8_app, integr8_auth, integr8_platform;

-- The migrator creates schema_migrations; the readiness check reads it.
grant select on schema_migrations to integr8_platform;

CREATE SCHEMA extensions;

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.app_current_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE FUNCTION public.erp_credit_note_total(p_tenant uuid, p_credit_note uuid) RETURNS numeric
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select coalesce(sum(erp_line_total(l.quantity, l.unit_price, l.discount_bp, l.tax_rate_bp, l.money_scale)), 0)
    from erp_credit_note_lines l
   where l.tenant_id = p_tenant and l.credit_note_id = p_credit_note;
$$;

CREATE FUNCTION public.erp_invoice_total(p_tenant uuid, p_invoice uuid) RETURNS numeric
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select coalesce(sum(erp_line_total(l.quantity, l.unit_price, l.discount_bp, l.tax_rate_bp, l.money_scale)), 0)
    from erp_invoice_lines l
   where l.tenant_id = p_tenant and l.invoice_id = p_invoice;
$$;

CREATE FUNCTION public.erp_ledger_backfill_more(p_tenant uuid, p_start date, p_tz text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  added integer;
begin
  with found as (
    select 'expense_claim' as kind, x.id, (x.decided_at at time zone p_tz)::date as day, x.currency
      from hr_expense_claims x
     where x.tenant_id = p_tenant and x.status in ('approved', 'paid')
       and (x.decided_at at time zone p_tz)::date >= p_start
    union all
    select 'expense_payment', x.id, (x.paid_at at time zone p_tz)::date, x.currency
      from hr_expense_claims x
     where x.tenant_id = p_tenant and x.status = 'paid' and x.paid_via in ('cash', 'bank_transfer')
       and (x.paid_at at time zone p_tz)::date >= p_start
    union all
    select 'payroll_run', r.id, r.period_end, r.currency
      from hr_payroll_runs r
     where r.tenant_id = p_tenant and r.status = 'approved' and r.period_end >= p_start
    union all
    select 'assembly', o.id, (o.completed_at at time zone p_tz)::date, erp_ledger_currency(p_tenant)
      from erp_assembly_orders o
     where o.tenant_id = p_tenant and o.status = 'completed'
       and (o.completed_at at time zone p_tz)::date >= p_start
    union all
    select 'payment_reversal', v.receipt_id, v.reversed_on, r.currency_code
      from erp_payment_reversals v
      join erp_payment_receipts r on r.tenant_id = v.tenant_id and r.id = v.receipt_id
     where v.tenant_id = p_tenant and v.reversed_on >= p_start
  ), inserted as (
    insert into erp_ledger_postings (tenant_id, source_kind, source_id, document_date, currency, reason)
    select p_tenant, f.kind, f.id, f.day, f.currency, 'before_set_up' from found f
    on conflict (tenant_id, source_kind, source_id) do nothing
    returning 1
  )
  select count(*) into added from inserted;
  return added;
end;
$$;

CREATE FUNCTION public.erp_ledger_currency(p_tenant uuid) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select coalesce((select s.currency from tenant_settings s where s.tenant_id = p_tenant), 'EGP');
$$;

CREATE FUNCTION public.erp_ledger_proposal_more(p_tenant uuid, p_kind text, p_source uuid) RETURNS TABLE(account_id uuid, debit numeric, credit numeric, customer_id uuid)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  s erp_ledger_settings%rowtype;
begin
  select * into s from erp_ledger_settings where tenant_id = p_tenant;
  if not found then
    return;
  end if;

  if p_kind = 'expense_claim' then
    return query
    select coalesce(c.account_id, s.staff_expenses_account_id), coalesce(x.approved_amount, x.amount),
           0::numeric, null::uuid
      from hr_expense_claims x
      join hr_expense_categories c on c.tenant_id = x.tenant_id and c.id = x.category_id
     where x.tenant_id = p_tenant and x.id = p_source
    union all
    select s.staff_claims_payable_account_id, 0::numeric, coalesce(x.approved_amount, x.amount), null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source;
    return;
  end if;

  if p_kind = 'expense_payment' then
    return query
    select s.staff_claims_payable_account_id, coalesce(x.approved_amount, x.amount), 0::numeric, null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source
    union all
    select case x.paid_via when 'cash' then s.cash_account_id else s.bank_account_id end,
           0::numeric, coalesce(x.approved_amount, x.amount), null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source;
    return;
  end if;

  -- Salaries and employer insurance, and the claims paid back, against what
  -- is now owed to the authorities and to the staff.
  if p_kind = 'payroll_run' then
    return query
    with t as (
      select coalesce(sum(l.gross), 0) as gross, coalesce(sum(l.si_employer), 0) as employer,
             coalesce(sum(l.si_employee), 0) as employee, coalesce(sum(l.income_tax), 0) as tax,
             coalesce(sum(l.martyrs_fund), 0) as fund, coalesce(sum(l.reimbursements), 0) as claims,
             coalesce(sum(l.net), 0) as net
        from hr_payroll_lines l where l.tenant_id = p_tenant and l.run_id = p_source
    ), signed as (
      select 1 as ord, s.salaries_expense_account_id as account, t.gross as amount from t
      union all select 2, s.employer_insurance_expense_account_id, t.employer from t
      union all select 3, s.staff_claims_payable_account_id, t.claims from t
      union all select 4, s.social_insurance_payable_account_id, -(t.employee + t.employer) from t
      union all select 5, s.payroll_tax_payable_account_id, -t.tax from t
      union all select 6, s.martyrs_fund_payable_account_id, -t.fund from t
      union all select 7, s.salaries_payable_account_id, -t.net from t
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), null::uuid
      from signed x where x.amount <> 0
     order by x.ord;
    return;
  end if;

  -- An assembly's parts leave stock at their cost and the item comes in at
  -- that cost plus labour and overhead: inventory rises by those, absorbed.
  -- A disassembly moves value within inventory; any rounding is absorbed too.
  if p_kind = 'assembly' then
    return query
    with t as (
      select coalesce(sum(round(m.quantity * m.unit_cost, 4)), 0) as added
        from erp_stock_movements m
       where m.tenant_id = p_tenant and m.posting_id = p_source
         and m.kind in ('assembly_consumption', 'assembly_output')
    ), signed as (
      select 1 as ord, s.inventory_account_id as account, t.added as amount from t
      union all select 2, s.assembly_absorbed_account_id, -t.added from t
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), null::uuid
      from signed x where x.amount <> 0
     order by x.amount < 0, x.ord;
    return;
  end if;
end;
$$;

CREATE FUNCTION public.erp_ledger_source_label_more(p_tenant uuid, p_kind text, p_source uuid) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case p_kind
    when 'expense_claim' then (select 'EX-' || lpad(x.reference::text, 6, '0') from hr_expense_claims x
                                where x.tenant_id = p_tenant and x.id = p_source)
    when 'expense_payment' then (select 'EX-' || lpad(x.reference::text, 6, '0') || ' paid' from hr_expense_claims x
                                  where x.tenant_id = p_tenant and x.id = p_source)
    when 'payroll_run' then (select 'PR-' || to_char(r.period_start, 'YYYY-MM') from hr_payroll_runs r
                              where r.tenant_id = p_tenant and r.id = p_source)
    when 'assembly' then (select 'AO-' || lpad(o.reference::text, 6, '0') from erp_assembly_orders o
                           where o.tenant_id = p_tenant and o.id = p_source)
    when 'payment_reversal' then (select 'RC-' || lpad(r.reference::text, 6, '0') || ' reversed'
                                   from erp_payment_receipts r
                                  where r.tenant_id = p_tenant and r.id = p_source)
    else null
  end;
$$;

CREATE FUNCTION public.erp_ledger_timezone(p_tenant uuid) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select coalesce((select s.timezone from tenant_settings s where s.tenant_id = p_tenant), 'Africa/Cairo');
$$;

CREATE FUNCTION public.erp_line_total(quantity numeric, unit_price numeric, discount_bp integer, tax_rate_bp integer) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select net + round(net * tax_rate_bp / 10000, 4)
    from (select round(gross - round(gross * discount_bp / 10000, 4), 4) as net
            from (select round(quantity * unit_price, 4) as gross) g) n;
$$;

CREATE FUNCTION public.erp_line_total(quantity numeric, unit_price numeric, discount_bp integer, tax_rate_bp integer, scale integer) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select net + round(net * tax_rate_bp / 10000, scale)
    from (select round(gross - round(gross * discount_bp / 10000, scale), scale) as net
            from (select round(quantity * unit_price, scale) as gross) g) n;
$$;

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;

CREATE FUNCTION public.tenants_is_test_fixed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.is_test is distinct from old.is_test then
    raise exception 'A company''s test mark is set when it is created and cannot change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Year partitions (P41)
--
-- Tables that grow forever and that no other table points at are split by
-- range on their date, one partition per UTC calendar year, named
-- `<table>_y<year>`, plus `<table>_default` for anything outside the years
-- made. The years are for speed and for retiring old data, not accounting, so
-- they follow UTC rather than any company's timezone.
--
-- Partitions carry no grants: every role reaches the rows through the parent,
-- whose grants and row-level security policy apply. Nobody can therefore read
-- around a policy or write past a parent's append-only trigger by naming a
-- partition. The migration owner creates them, through these functions, which
-- run as that owner so that the worker's platform role may call
-- `ensure_year_partitions` without owning anything.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.create_year_partition(p_parent regclass, p_year integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  parent_name text;
  key_column  text;
  key_type    regtype;
  part_name   text;
  default_name text;
  lower_bound text;
  upper_bound text;
  waiting     bigint;
begin
  select c.relname, a.attname, a.atttypid::regtype
    into parent_name, key_column, key_type
    from pg_partitioned_table p
    join pg_class c on c.oid = p.partrelid
    join pg_attribute a on a.attrelid = p.partrelid and a.attnum = p.partattrs[0]
   where p.partrelid = p_parent and p.partstrat = 'r' and p.partnatts = 1;
  if parent_name is null then
    raise exception '% is not partitioned by range on one column', p_parent;
  end if;

  part_name := format('%s_y%s', parent_name, p_year);
  if to_regclass(format('public.%I', part_name)) is not null then
    return false;
  end if;

  if key_type = 'date'::regtype then
    lower_bound := make_date(p_year, 1, 1)::text;
    upper_bound := make_date(p_year + 1, 1, 1)::text;
  elsif key_type = 'timestamp with time zone'::regtype then
    lower_bound := make_timestamptz(p_year, 1, 1, 0, 0, 0, 'UTC')::text;
    upper_bound := make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'UTC')::text;
  else
    raise exception '% is partitioned on %, which is neither a date nor a timestamptz', p_parent, key_type;
  end if;

  -- A year cannot be made while the default partition holds rows of it, so
  -- those rows step out and back in. Triggers stay quiet for the move: an
  -- append-only or posted-line guard would otherwise refuse it, and nothing
  -- about the rows changes.
  default_name := parent_name || '_default';
  execute format('select count(*) from public.%I where %I >= %L and %I < %L',
                 default_name, key_column, lower_bound, key_column, upper_bound)
     into waiting;
  if waiting > 0 then
    set local session_replication_role = replica;
    execute format('create temporary table year_partition_move on commit drop as '
                   'with moved as (delete from public.%I where %I >= %L and %I < %L returning *) '
                   'select * from moved',
                   default_name, key_column, lower_bound, key_column, upper_bound);
  end if;

  execute format('create table public.%I partition of public.%I for values from (%L) to (%L)',
                 part_name, parent_name, lower_bound, upper_bound);
  execute format('revoke all on public.%I from public, integr8_app, integr8_auth, integr8_platform', part_name);
  execute format('comment on table public.%I is %L', part_name,
                 format('Year %s of %s (P41). Reached through %s only.', p_year, parent_name, parent_name));

  if waiting > 0 then
    -- The rows keep every value they had, an identity column's included.
    execute format('insert into public.%I overriding system value select * from year_partition_move',
                   parent_name);
    drop table year_partition_move;
    set local session_replication_role = origin;
  end if;
  return true;
end;
$$;

CREATE FUNCTION public.ensure_year_partitions(p_years_ahead integer DEFAULT 1) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  t          record;
  y          integer;
  this_year  integer := extract(year from now() at time zone 'UTC')::integer;
  made       integer := 0;
  key_column text;
  key_type   regtype;
begin
  for t in
    select p.partrelid::regclass as parent, c.relname
      from pg_partitioned_table p
      join pg_class c on c.oid = p.partrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and p.partstrat = 'r'
     order by c.relname
  loop
    if to_regclass(format('public.%I', t.relname || '_default')) is null then
      execute format('create table public.%I partition of public.%I default', t.relname || '_default', t.relname);
      execute format('revoke all on public.%I from public, integr8_app, integr8_auth, integr8_platform',
                     t.relname || '_default');
      execute format('comment on table public.%I is %L', t.relname || '_default',
                     format('Rows of %s outside every year partition made so far (P41). Emptied as their years are made.', t.relname));
    end if;

    -- This year and the ones ahead, so inserts never wait on a new year.
    for y in this_year .. this_year + greatest(p_years_ahead, 0) loop
      if create_year_partition(t.parent, y) then
        made := made + 1;
      end if;
    end loop;

    -- Any year the default partition holds (older imported data, a date typed
    -- years ahead) gets its own partition too.
    select a.attname, a.atttypid::regtype into key_column, key_type
      from pg_partitioned_table p
      join pg_attribute a on a.attrelid = p.partrelid and a.attnum = p.partattrs[0]
     where p.partrelid = t.parent;
    for y in execute format(
      case when key_type = 'date'::regtype
           then 'select distinct extract(year from %I)::integer from public.%I'
           else 'select distinct extract(year from %I at time zone ''UTC'')::integer from public.%I' end,
      key_column, t.relname || '_default')
    loop
      if create_year_partition(t.parent, y) then
        made := made + 1;
      end if;
    end loop;
  end loop;
  return made;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    plan text DEFAULT 'trial'::text NOT NULL,
    seats integer,
    suspended_at timestamp with time zone,
    suspended_reason text,
    onboarded_by uuid,
    read_only_since timestamp with time zone,
    read_only_reason text,
    billing_mode text DEFAULT 'self_serve'::text NOT NULL,
    is_test boolean DEFAULT false NOT NULL,
    CONSTRAINT tenants_billing_mode_known CHECK ((billing_mode = ANY (ARRAY['self_serve'::text, 'invoiced'::text]))),
    CONSTRAINT tenants_name_not_blank CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT tenants_plan_known CHECK ((plan = ANY (ARRAY['trial'::text, 'starter'::text, 'standard'::text, 'enterprise'::text]))),
    CONSTRAINT tenants_read_only_pair CHECK (((read_only_since IS NULL) = (read_only_reason IS NULL))),
    CONSTRAINT tenants_seats_positive CHECK (((seats IS NULL) OR (seats > 0))),
    CONSTRAINT tenants_slug_format CHECK ((slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text)),
    CONSTRAINT tenants_status_known CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'cancelled'::text]))),
    CONSTRAINT tenants_suspension_matches_status CHECK (((status <> 'suspended'::text) OR (suspended_at IS NOT NULL))),
    CONSTRAINT tenants_suspension_pair CHECK (((suspended_at IS NULL) = (suspended_reason IS NULL)))
);

CREATE TABLE feature_flags (
    key text NOT NULL,
    description text NOT NULL,
    default_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feature_flags_description_not_blank CHECK ((btrim(description) <> ''::text)),
    CONSTRAINT feature_flags_key_format CHECK ((key ~ '^[a-z][a-z0-9_]{0,63}$'::text))
);

CREATE TABLE idempotency_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    user_id uuid NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    request_fingerprint text NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    response_status integer,
    response_body jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT idempotency_keys_completion_pair CHECK (((status = 'completed'::text) = ((completed_at IS NOT NULL) AND (response_status IS NOT NULL)))),
    CONSTRAINT idempotency_keys_expires_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT idempotency_keys_fingerprint_is_sha256 CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT idempotency_keys_status_known CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text])))
);

CREATE TABLE jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    queue text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_by text,
    locked_until timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    dead_lettered_at timestamp with time zone,
    CONSTRAINT jobs_attempts_sane CHECK (((attempts >= 0) AND (attempts <= (max_attempts + 1)))),
    CONSTRAINT jobs_dead_has_status CHECK (((dead_lettered_at IS NULL) = (status <> 'dead'::text))),
    CONSTRAINT jobs_lock_pair CHECK (((locked_by IS NULL) = (locked_until IS NULL))),
    CONSTRAINT jobs_max_attempts_positive CHECK ((max_attempts >= 1)),
    CONSTRAINT jobs_queue_not_blank CHECK ((btrim(queue) <> ''::text)),
    CONSTRAINT jobs_status_known CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'dead'::text])))
);

CREATE TABLE plan_allowances (
    plan text NOT NULL,
    storage_bytes bigint,
    retention_days integer,
    overage text DEFAULT 'block'::text NOT NULL,
    warn_at_percent smallint DEFAULT 80 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    seats integer,
    submissions_per_month integer,
    price_cents integer,
    currency text,
    provider_price_monthly text,
    provider_price_yearly text,
    CONSTRAINT plan_allowances_currency_pair CHECK (((price_cents IS NULL) = (currency IS NULL))),
    CONSTRAINT plan_allowances_currency_shape CHECK (((currency IS NULL) OR (currency ~ '^[A-Z]{3}$'::text))),
    CONSTRAINT plan_allowances_overage_known CHECK ((overage = ANY (ARRAY['block'::text, 'allow'::text]))),
    CONSTRAINT plan_allowances_plan_known CHECK ((plan = ANY (ARRAY['trial'::text, 'starter'::text, 'standard'::text, 'enterprise'::text]))),
    CONSTRAINT plan_allowances_price_sane CHECK (((price_cents IS NULL) OR (price_cents >= 0))),
    CONSTRAINT plan_allowances_retention_sane CHECK (((retention_days IS NULL) OR ((retention_days >= 1) AND (retention_days <= 36500)))),
    CONSTRAINT plan_allowances_seats_sane CHECK (((seats IS NULL) OR (seats > 0))),
    CONSTRAINT plan_allowances_storage_sane CHECK (((storage_bytes IS NULL) OR (storage_bytes > 0))),
    CONSTRAINT plan_allowances_submissions_sane CHECK (((submissions_per_month IS NULL) OR (submissions_per_month > 0))),
    CONSTRAINT plan_allowances_warn_sane CHECK (((warn_at_percent >= 1) AND (warn_at_percent <= 100)))
);

CREATE TABLE platform_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    password_hash text,
    password_changed_at timestamp with time zone,
    totp_secret text,
    totp_enrolled_at timestamp with time zone,
    last_signed_in_at timestamp with time zone,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    can_manage_staff boolean DEFAULT false NOT NULL,
    added_by_platform_user_id uuid,
    CONSTRAINT platform_users_display_name_not_blank CHECK ((btrim(display_name) <> ''::text)),
    CONSTRAINT platform_users_email_lowercase CHECK ((email = lower(email))),
    CONSTRAINT platform_users_email_shaped CHECK ((email ~~ '%_@_%'::text)),
    CONSTRAINT platform_users_failed_attempts_sane CHECK ((failed_attempts >= 0)),
    CONSTRAINT platform_users_totp_pair CHECK (((totp_secret IS NULL) = (totp_enrolled_at IS NULL)))
);

CREATE TABLE rate_limit_buckets (
    bucket_key text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    request_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rate_limit_buckets_count_sane CHECK ((request_count >= 0)),
    CONSTRAINT rate_limit_buckets_key_not_blank CHECK ((btrim(bucket_key) <> ''::text))
);

CREATE TABLE scheduled_task_runs (
    task text NOT NULL,
    last_run_at timestamp with time zone DEFAULT to_timestamp((0)::double precision) NOT NULL,
    last_finished_at timestamp with time zone,
    claimed_by text,
    last_error text
);

CREATE TABLE tenant_feature_flags (
    tenant_id uuid NOT NULL,
    key text NOT NULL,
    enabled boolean NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);

CREATE TABLE tenant_settings (
    tenant_id uuid NOT NULL,
    logo_media_id uuid,
    brand_colour text,
    timezone text DEFAULT 'Africa/Cairo'::text NOT NULL,
    currency text DEFAULT 'EGP'::text NOT NULL,
    locale text DEFAULT 'en'::text NOT NULL,
    work_day_starts integer DEFAULT 480 NOT NULL,
    work_day_ends integer DEFAULT 1020 NOT NULL,
    working_days integer[] DEFAULT '{7,1,2,3,4}'::integer[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shell_colour text,
    default_theme text DEFAULT 'system'::text NOT NULL,
    website_url text,
    app_icon_media_id uuid,
    apps_enabled boolean DEFAULT false NOT NULL,
    ai_web_enabled boolean DEFAULT false NOT NULL,
    ai_desktop_enabled boolean DEFAULT false NOT NULL,
    ai_mobile_enabled boolean DEFAULT false NOT NULL,
    website_files_enabled boolean DEFAULT false NOT NULL,
    website_jobs_enabled boolean DEFAULT false NOT NULL,
    website_quotes_enabled boolean DEFAULT false NOT NULL,
    website_invoices_enabled boolean DEFAULT false NOT NULL,
    qualification_warning_days integer DEFAULT 30 NOT NULL,
    show_company_name boolean DEFAULT true NOT NULL,
    hidden_nav_sections text[] DEFAULT '{}'::text[] NOT NULL,
    document_link_pattern text,
    CONSTRAINT tenant_settings_colour_shape CHECK (((brand_colour IS NULL) OR (brand_colour ~ '^#[0-9A-Fa-f]{6}$'::text))),
    CONSTRAINT tenant_settings_currency_shape CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT tenant_settings_day_bounds CHECK (((work_day_starts >= 0) AND (work_day_ends <= 1440) AND (work_day_ends > work_day_starts))),
    CONSTRAINT tenant_settings_days_sane CHECK ((working_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7])),
    CONSTRAINT tenant_settings_default_theme_known CHECK ((default_theme = ANY (ARRAY['light'::text, 'dark'::text, 'system'::text]))),
    CONSTRAINT tenant_settings_document_link_pattern_shape CHECK (((document_link_pattern IS NULL) OR ((document_link_pattern ~ '^https://[^\s/?#]+'::text) AND (POSITION(('{code}'::text) IN (document_link_pattern)) > 0) AND (char_length(document_link_pattern) <= 500)))),
    CONSTRAINT tenant_settings_hidden_nav_sections_size CHECK ((cardinality(hidden_nav_sections) <= 200)),
    CONSTRAINT tenant_settings_qualification_warning_days_bounds CHECK (((qualification_warning_days >= 1) AND (qualification_warning_days <= 365))),
    CONSTRAINT tenant_settings_shell_colour_shape CHECK (((shell_colour IS NULL) OR (shell_colour ~ '^#[0-9A-Fa-f]{6}$'::text))),
    CONSTRAINT tenant_settings_website_url_shape CHECK (((website_url IS NULL) OR ((website_url ~ '^https://[^[:space:]]+$'::text) AND (length(website_url) <= 2048))))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (key);

ALTER TABLE ONLY idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY idempotency_keys
    ADD CONSTRAINT idempotency_keys_unique UNIQUE (tenant_id, idempotency_key);

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY plan_allowances
    ADD CONSTRAINT plan_allowances_pkey PRIMARY KEY (plan);

ALTER TABLE ONLY platform_users
    ADD CONSTRAINT platform_users_email_unique UNIQUE (email);

ALTER TABLE ONLY platform_users
    ADD CONSTRAINT platform_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rate_limit_buckets
    ADD CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (bucket_key, window_started_at);

ALTER TABLE ONLY scheduled_task_runs
    ADD CONSTRAINT scheduled_task_runs_pkey PRIMARY KEY (task);

ALTER TABLE ONLY tenant_feature_flags
    ADD CONSTRAINT tenant_feature_flags_pk PRIMARY KEY (tenant_id, key);

ALTER TABLE ONLY tenant_settings
    ADD CONSTRAINT tenant_settings_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_slug_unique UNIQUE (slug);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys USING btree (expires_at);

CREATE INDEX jobs_claimable_idx ON jobs USING btree (available_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));

CREATE INDEX jobs_dead_letter_idx ON jobs USING btree (tenant_id, dead_lettered_at DESC) WHERE (status = 'dead'::text);

CREATE INDEX jobs_tenant_status_idx ON jobs USING btree (tenant_id, status, created_at DESC);

CREATE INDEX platform_users_added_by_idx ON platform_users USING btree (added_by_platform_user_id);

CREATE INDEX rate_limit_buckets_window_idx ON rate_limit_buckets USING btree (window_started_at);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY idempotency_keys
    ADD CONSTRAINT idempotency_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY platform_users
    ADD CONSTRAINT platform_users_added_by_platform_user_id_fkey FOREIGN KEY (added_by_platform_user_id) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE ONLY tenant_feature_flags
    ADD CONSTRAINT tenant_feature_flags_key_fkey FOREIGN KEY (key) REFERENCES feature_flags(key) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_feature_flags
    ADD CONSTRAINT tenant_feature_flags_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_feature_flags
    ADD CONSTRAINT tenant_feature_flags_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE ONLY tenant_settings
    ADD CONSTRAINT tenant_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_onboarded_by_fkey FOREIGN KEY (onboarded_by) REFERENCES platform_users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER feature_flags_set_updated_at BEFORE UPDATE ON feature_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER jobs_set_updated_at BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER platform_users_set_updated_at BEFORE UPDATE ON platform_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tenant_feature_flags_set_updated_at BEFORE UPDATE ON tenant_feature_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tenant_settings_set_updated_at BEFORE UPDATE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER tenants_is_test_fixed BEFORE UPDATE OF is_test ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_is_test_fixed();

CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE plan_allowances ENABLE ROW LEVEL SECURITY;

ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;

ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_feature_flags ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY feature_flags_readable ON feature_flags FOR SELECT TO integr8_app USING (true);

CREATE POLICY idempotency_keys_isolation ON idempotency_keys TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY jobs_isolation ON jobs TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY rate_limit_buckets_gateway ON rate_limit_buckets TO integr8_auth USING (true) WITH CHECK (true);

CREATE POLICY tenant_feature_flags_isolation ON tenant_feature_flags FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY tenant_settings_isolation ON tenant_settings USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY tenants_own_row ON tenants FOR SELECT TO integr8_app USING ((id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';

COMMENT ON FUNCTION app_current_tenant_id() IS 'The tenant_id of the current transaction, from the app.tenant_id GUC. NULL when unset, which every policy treats as no access.';

COMMENT ON FUNCTION erp_ledger_backfill_more(p_tenant uuid, p_start date, p_tz text) IS 'Queues documents of kinds added after 0034 for review. Security definer: the runtime role cannot write the queue.';

COMMENT ON FUNCTION set_updated_at() IS 'Trigger function: maintains updated_at. Attached to every table with that column.';

COMMENT ON TABLE tenants IS 'One row per customer company. `id` is the tenant_id every other table carries.';

COMMENT ON COLUMN tenants.slug IS 'URL and R2-bucket-safe identifier. Immutable in practice; changing it orphans stored media.';

COMMENT ON COLUMN tenants.deleted_at IS 'Soft delete. Repositories exclude non-null rows; audit_log holds a restricting FK so history survives.';

COMMENT ON COLUMN tenants.plan IS 'What the company pays for. Seats and quotas hang off it; billing itself is P17.';

COMMENT ON COLUMN tenants.suspended_reason IS 'Why the company was stopped, shown to them by every client. Cleared on reactivation.';

COMMENT ON COLUMN tenants.read_only_since IS 'Non-payment or a lapsed trial (0017). Distinct from suspended: a suspended company is refused everything, a read-only one can still sign in, read, export and pay.';

COMMENT ON COLUMN tenants.billing_mode IS 'self_serve: subscribes in the app via the billing provider. invoiced: Integr8 invoices directly; the plan is set from the platform dashboard.';

COMMENT ON COLUMN tenants.is_test IS 'A test company (0077): made by the demo seeder or with the dashboard''s switch; left out of billing and totals, sends no mail or push, and the only kind a limited staff session may reach. Fixed at creation.';

COMMENT ON TABLE feature_flags IS 'The flags that exist and what they are when a company has no opinion. Platform content: read by every company, written by the schema owner.';

COMMENT ON TABLE idempotency_keys IS 'One row per mutating request that carried an Idempotency-Key. Holds the response so a replay returns the original answer.';

COMMENT ON COLUMN idempotency_keys.request_fingerprint IS 'SHA-256 of method, path and body. The same key with a different body is a client bug, and is rejected rather than silently replayed.';

COMMENT ON TABLE jobs IS 'Background work for one company. Enqueued through the tenant connection; claimed by the worker through the owner connection.';

COMMENT ON COLUMN jobs.status IS 'pending -> running -> succeeded, or back to pending on a retriable failure, or dead once attempts are exhausted.';

COMMENT ON COLUMN jobs.locked_until IS 'A lease, not a lock. A worker that dies mid-job leaves the row locked; the lease expiring is what lets another worker pick it up.';

COMMENT ON TABLE plan_allowances IS 'What each plan is allowed, and what happens when a company passes it. One row per plan, edited from the platform dashboard (P16). Plan definitions in full — seats, forms, submissions, modules — are P17; this holds the storage half, which is the half that costs money the moment it is wrong.';

COMMENT ON COLUMN plan_allowances.overage IS 'block refuses new uploads at a hundred percent; allow keeps accepting and records the overage on each daily sample, so P17 can bill for it retrospectively rather than losing the months in between.';

COMMENT ON TABLE platform_users IS 'Super-admin identities. A platform user never holds a tenant_users row; the trigger on tenant_users enforces it.';

COMMENT ON COLUMN platform_users.password_hash IS 'scrypt, as `scrypt$N$r$p$salt$hash`. Null until the account is set up, which no sign-in accepts.';

COMMENT ON COLUMN platform_users.totp_secret IS 'The TOTP secret, encrypted with PLATFORM_SECRET_KEY (AES-256-GCM). Null until enrolled.';

COMMENT ON COLUMN platform_users.locked_until IS 'Set after repeated failures. A locked account is refused even with the right password.';

COMMENT ON COLUMN platform_users.can_manage_staff IS 'True for accounts made by the terminal command (admin-cli create). Only these may add or remove staff.';

COMMENT ON COLUMN platform_users.added_by_platform_user_id IS 'The staff manager who added this account from the dashboard. Null for terminal accounts.';

COMMENT ON TABLE rate_limit_buckets IS 'Fixed-window request counters, keyed by an opaque bucket string. Not tenant-scoped: an unauthenticated request has no tenant.';

COMMENT ON TABLE scheduled_task_runs IS 'When each recurring platform task last ran (P16). There is no cron in this system and no scheduler process; the worker runs housekeeping on a timer, and several workers run at once. A task that must happen once a day rather than once a day per worker claims its turn here, with a conditional update that exactly one of them wins.';

COMMENT ON TABLE tenant_feature_flags IS 'One company''s answer for one flag. Absent means the flag''s default. A company reads its own and changes none.';

COMMENT ON TABLE tenant_settings IS 'How one company works: branding, timezone, currency, locale and working hours (0018). One row per company, created on onboarding so nothing has to cope with its absence.';

COMMENT ON COLUMN tenant_settings.shell_colour IS 'The dashboard shell (sidebar, top bar) colour, #RRGGBB. Null means the product default.';

COMMENT ON COLUMN tenant_settings.default_theme IS 'light | dark | system: the theme every app of this company opens in. People in the company do not choose.';

COMMENT ON COLUMN tenant_settings.website_url IS 'The company''s own website, https only. Shown in its phone app before sign-in.';

COMMENT ON COLUMN tenant_settings.app_icon_media_id IS 'A square image used as the installer and phone app icon. Falls back to Integr8''s when null.';

COMMENT ON COLUMN tenant_settings.apps_enabled IS 'Whether the release pipeline builds desktop installers and phone apps for this company.';

COMMENT ON COLUMN tenant_settings.ai_web_enabled IS 'Whether members see the assistant in the web app (ADR-0001). Narrows the platform grant; never widens it.';

COMMENT ON COLUMN tenant_settings.qualification_warning_days IS 'How many days before a certificate expires its holder and the managers are warned (0052).';

COMMENT ON COLUMN tenant_settings.show_company_name IS 'Whether the apps print the company name beside its logo; ignored without a logo (0075).';

COMMENT ON COLUMN tenant_settings.hidden_nav_sections IS 'Navigation keys of the tabs Integr8 staff switched off for this company (0075).';

COMMENT ON COLUMN tenant_settings.document_link_pattern IS 'https address with {code} on the company website that document links open; null for Integr8''s /d/ page (0075).';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO integr8_app;
GRANT USAGE ON SCHEMA public TO integr8_auth;
GRANT USAGE ON SCHEMA public TO integr8_platform;

GRANT SELECT ON TABLE tenants TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenants TO integr8_platform;

GRANT SELECT ON TABLE feature_flags TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE feature_flags TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE idempotency_keys TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE idempotency_keys TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE jobs TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE jobs TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE plan_allowances TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE platform_users TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE rate_limit_buckets TO integr8_auth;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE rate_limit_buckets TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE scheduled_task_runs TO integr8_platform;

GRANT SELECT ON TABLE tenant_feature_flags TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_feature_flags TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE tenant_settings TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_settings TO integr8_platform;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO integr8_platform;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO integr8_platform;

--
--

-- Only the worker (as the platform role) and migrations make year partitions.
REVOKE ALL ON FUNCTION create_year_partition(p_parent regclass, p_year integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ensure_year_partitions(p_years_ahead integer) FROM PUBLIC;
GRANT ALL ON FUNCTION ensure_year_partitions(p_years_ahead integer) TO integr8_platform;

-- ---------------------------------------------------------------------------
-- Rows every database starts with
-- ---------------------------------------------------------------------------

INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('crm', 'CRM: leads, opportunities, activities and the pipeline. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.582333+00', '2026-11-14 21:36:23.582333+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('inventory', 'Inventory: catalogue, stock locations and vans, the stock ledger, parts used on jobs. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.635331+00', '2026-11-14 21:36:23.635331+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('purchasing', 'Purchasing: suppliers, purchase orders with approval, goods receipts. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.635331+00', '2026-11-14 21:36:23.635331+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('sales', 'Sales: quotes with customer acceptance, sales orders with stock reservations, linked to jobs. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.702538+00', '2026-11-14 21:36:23.702538+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('finance', 'Finance: the company''s own invoices, credit notes, payment receipts and job costs. Not Integr8''s billing. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.733718+00', '2026-11-14 21:36:23.733718+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('assets', 'Assets: the register of machines a company services, their QR tags and their service history. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.779855+00', '2026-11-14 21:36:23.779855+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('ledger', 'Ledger: the company''s general ledger — chart of accounts, journals, periods and reports. A management ledger, not statutory accounts. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.805818+00', '2026-11-14 21:36:23.805818+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('hr', 'HR: employee profiles and staff expense claims. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.845849+00', '2026-11-14 21:36:23.845849+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('payroll', 'Payroll: Egyptian pay runs from rule sets the company confirms, payslips and reports. Needs HR. No legal review by Integr8. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.845849+00', '2026-11-14 21:36:23.845849+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('manufacturing', 'Manufacturing: bills of materials, assembly and disassembly, and material planning. Needs inventory. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:23.845849+00', '2026-11-14 21:36:23.845849+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('documents', 'Documents: PDF templates Integr8 designs for a company''s forms, the PDFs its people make from submissions, their QR links and the website lookup. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:24.021101+00', '2026-11-14 21:36:24.021101+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('e_invoicing', 'E-invoicing: sending the company''s issued invoices to the Egyptian Tax Authority, signed on the company''s own computer. Needs finance. Off until Integr8 switches it on for a company.', false, '2026-11-14 21:36:24.036464+00', '2026-11-14 21:36:24.036464+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('website_files', 'Company website: find a document by its reference (and customer), and open its PDF. Only documents the company has made shareable. Off until Integr8 switches it on; the company must switch it on too.', false, '2026-11-14 21:36:24.064207+00', '2026-11-14 21:36:24.193905+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('website_jobs', 'Company website: one job''s status by its id. Off until Integr8 switches it on; the company must switch it on too.', false, '2026-11-14 21:36:24.064207+00', '2026-11-14 21:36:24.193905+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('website_quotes', 'Company website: one issued quote by its id. Off until Integr8 switches it on; the company must switch it on too.', false, '2026-11-14 21:36:24.064207+00', '2026-11-14 21:36:24.193905+00');
INSERT INTO feature_flags (key, description, default_enabled, created_at, updated_at) VALUES ('website_invoices', 'Company website: one issued invoice by its id. Off until Integr8 switches it on; the company must switch it on too.', false, '2026-11-14 21:36:24.064207+00', '2026-11-14 21:36:24.193905+00');
INSERT INTO plan_allowances (plan, storage_bytes, retention_days, overage, warn_at_percent, updated_at, updated_by, seats, submissions_per_month, price_cents, currency, provider_price_monthly, provider_price_yearly) VALUES ('enterprise', NULL, NULL, 'allow', 80, '2026-11-14 21:36:23.517485+00', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO plan_allowances (plan, storage_bytes, retention_days, overage, warn_at_percent, updated_at, updated_by, seats, submissions_per_month, price_cents, currency, provider_price_monthly, provider_price_yearly) VALUES ('trial', 5368709120, NULL, 'block', 80, '2026-11-14 21:36:23.517485+00', NULL, 3, 100, NULL, NULL, NULL, NULL);
INSERT INTO plan_allowances (plan, storage_bytes, retention_days, overage, warn_at_percent, updated_at, updated_by, seats, submissions_per_month, price_cents, currency, provider_price_monthly, provider_price_yearly) VALUES ('starter', 107374182400, NULL, 'block', 80, '2026-11-14 21:36:23.517485+00', NULL, 10, 2000, NULL, NULL, NULL, NULL);
INSERT INTO plan_allowances (plan, storage_bytes, retention_days, overage, warn_at_percent, updated_at, updated_by, seats, submissions_per_month, price_cents, currency, provider_price_monthly, provider_price_yearly) VALUES ('standard', 536870912000, NULL, 'allow', 80, '2026-11-14 21:36:23.517485+00', NULL, 50, 20000, NULL, NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('storage.reconcile', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('storage.sample', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('storage.retention', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('billing.dunning', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('signup.expire', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('ai.retention', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('maintenance.plans', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('deadlines.alerts', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('qualifications.expiry', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('maintenance.retries', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('housekeeping.tables', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
INSERT INTO scheduled_task_runs (task, last_run_at, last_finished_at, claimed_by, last_error) VALUES ('partitions.ensure', '1970-01-01 00:00:00+00', NULL, NULL, NULL);
