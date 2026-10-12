-- Seventh round (ADR-0010): Egyptian payroll.
--
-- Rule sets carry the year's tax bands, social insurance rates and limits and
-- the Martyrs' Fund rate, dated from the month they apply. Integr8 seeds the
-- 2026 figures; the owner confirms a set (saying who checked it) before any
-- run uses it, and a confirmed set never changes: new figures are a new set
-- from a later month.
--
-- Pay terms are dated per employee: basic, allowances, insurance, standard
-- hours and the overtime rate. A pay run is one month's; its lines copy the
-- terms in force, the clocked hours and the expense claims waiting for
-- payroll, and hold what the calculation (in the API, @integr8/core's
-- calculatePay) made of them, so a run reads the same however terms change
-- later. A draft is recalculated and edited; somebody other than the last
-- person to prepare it approves it, and an approved run never changes.
--
-- Approving a run pays the claims in it and posts one journal: salaries and
-- employer insurance, and the claims paid back, against insurance, tax and
-- Martyrs' Fund payable and the net salaries owed.

-- ---------------------------------------------------------------------------
-- Rule sets
-- ---------------------------------------------------------------------------

create table hr_payroll_rule_sets (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete restrict,
  name               text        not null,
  -- The first of the month the figures apply from.
  effective_from     date        not null,
  -- PayrollRules in @integr8/core, validated by the API.
  rules              jsonb       not null,
  confirmed_by       uuid,
  confirmed_at       timestamptz,
  -- Who checked the figures, and against what.
  confirmation_note  text,
  created_by         uuid        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            integer     not null default 1,
  constraint hr_payroll_rule_sets_tenant_id_unique unique (tenant_id, id),
  constraint hr_payroll_rule_sets_from_unique unique (tenant_id, effective_from),
  constraint hr_payroll_rule_sets_name_present check (btrim(name) <> '' and char_length(name) <= 200),
  constraint hr_payroll_rule_sets_month_start check (extract(day from effective_from) = 1),
  constraint hr_payroll_rule_sets_rules_shape check (jsonb_typeof(rules) = 'object'),
  constraint hr_payroll_rule_sets_confirmation_pairing check (
    (confirmed_by is null) = (confirmed_at is null)
    and (confirmed_by is null) = (confirmation_note is null)),
  constraint hr_payroll_rule_sets_note_length check (
    confirmation_note is null or (btrim(confirmation_note) <> '' and char_length(confirmation_note) <= 1000)),
  constraint hr_payroll_rule_sets_version_positive check (version > 0)
);
create trigger hr_payroll_rule_sets_set_updated_at
  before update on hr_payroll_rule_sets
  for each row execute function set_updated_at();

-- A confirmed set never changes, is never unconfirmed and never deleted.
create function hr_payroll_rule_sets_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    -- integr8_purging() is null outside a purge.
    if old.confirmed_at is not null and not coalesce(integr8_purging(old.tenant_id), false) then
      raise exception 'A confirmed rule set is never deleted'
        using errcode = 'check_violation', constraint = 'hr_payroll_rule_sets_frozen';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.confirmed_at is not null then
      raise exception 'A rule set is confirmed after it is created'
        using errcode = 'check_violation', constraint = 'hr_payroll_rule_sets_frozen';
    end if;
    return new;
  end if;
  if old.confirmed_at is not null and (
       (new.name, new.effective_from, new.rules, new.confirmed_by, new.confirmed_at, new.confirmation_note)
       is distinct from
       (old.name, old.effective_from, old.rules, old.confirmed_by, old.confirmed_at, old.confirmation_note)) then
    raise exception 'A confirmed rule set does not change; add a new one from a later month'
      using errcode = 'check_violation', constraint = 'hr_payroll_rule_sets_frozen';
  end if;
  return new;
end;
$$;
create trigger hr_payroll_rule_sets_guard
  before insert or update or delete on hr_payroll_rule_sets
  for each row execute function hr_payroll_rule_sets_guard();

-- ---------------------------------------------------------------------------
-- Pay terms
-- ---------------------------------------------------------------------------

create table hr_pay_terms (
  id               uuid           primary key default gen_random_uuid(),
  tenant_id        uuid           not null references tenants (id) on delete restrict,
  employee_id      uuid           not null,
  effective_from   date           not null,
  basic            numeric(20,4)  not null,
  -- Fixed monthly allowances, together.
  allowances       numeric(20,4)  not null default 0,
  insured          boolean        not null default true,
  -- The wage declared for social insurance; basic and allowances when null.
  insurable_wage   numeric(20,4),
  -- A month's working hours; clocked hours beyond them are overtime.
  standard_hours   numeric(8,2)   not null default 208,
  -- Per hour; null for 135% of the hourly basic.
  overtime_rate    numeric(20,4),
  pay_method       text           not null default 'bank_transfer',
  created_by       uuid           not null,
  created_at       timestamptz    not null default now(),
  updated_at       timestamptz    not null default now(),
  version          integer        not null default 1,
  constraint hr_pay_terms_tenant_id_unique unique (tenant_id, id),
  constraint hr_pay_terms_from_unique unique (tenant_id, employee_id, effective_from),
  constraint hr_pay_terms_employee_fk
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id),
  constraint hr_pay_terms_amounts check (
    basic >= 0 and allowances >= 0
    and (insurable_wage is null or insurable_wage > 0)
    and standard_hours > 0
    and (overtime_rate is null or overtime_rate >= 0)),
  constraint hr_pay_terms_pay_method_known check (pay_method in ('bank_transfer', 'cash')),
  constraint hr_pay_terms_version_positive check (version > 0)
);
create trigger hr_pay_terms_set_updated_at
  before update on hr_pay_terms
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Pay runs
-- ---------------------------------------------------------------------------

create table hr_payroll_runs (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  period_start  date        not null,
  period_end    date        not null,
  rule_set_id   uuid        not null,
  currency      text        not null,
  status        text        not null default 'draft',
  pay_date      date,
  note          text,
  -- The last person to calculate or edit it; somebody else approves it.
  prepared_by   uuid        not null,
  prepared_at   timestamptz not null default now(),
  approved_by   uuid,
  approved_at   timestamptz,
  version       integer     not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint hr_payroll_runs_tenant_id_unique unique (tenant_id, id),
  constraint hr_payroll_runs_period_unique unique (tenant_id, period_start),
  constraint hr_payroll_runs_rule_set_fk
    foreign key (tenant_id, rule_set_id) references hr_payroll_rule_sets (tenant_id, id),
  constraint hr_payroll_runs_month check (
    extract(day from period_start) = 1
    and period_end = (period_start + interval '1 month' - interval '1 day')::date),
  constraint hr_payroll_runs_currency_shape check (currency ~ '^[A-Z]{3}$'),
  constraint hr_payroll_runs_status_known check (status in ('draft', 'approved')),
  constraint hr_payroll_runs_approval_pairing check (
    (status = 'approved') = (approved_by is not null)
    and (approved_by is null) = (approved_at is null)),
  constraint hr_payroll_runs_not_self_approved check (approved_by is null or approved_by <> prepared_by),
  constraint hr_payroll_runs_note_length check (note is null or char_length(note) <= 1000),
  constraint hr_payroll_runs_version_positive check (version > 0)
);
create trigger hr_payroll_runs_set_updated_at
  before update on hr_payroll_runs
  for each row execute function set_updated_at();

-- A run uses a confirmed rule set already in force; it is approved once and
-- then never changes; a draft may be discarded.
create function hr_payroll_runs_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  rule_set hr_payroll_rule_sets%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' and not coalesce(integr8_purging(old.tenant_id), false) then
      raise exception 'An approved pay run is never deleted'
        using errcode = 'check_violation', constraint = 'hr_payroll_runs_frozen';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then
    raise exception 'An approved pay run does not change'
      using errcode = 'check_violation', constraint = 'hr_payroll_runs_frozen';
  end if;
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'A pay run starts as a draft'
      using errcode = 'check_violation', constraint = 'hr_payroll_runs_frozen';
  end if;
  select * into rule_set from hr_payroll_rule_sets
   where tenant_id = new.tenant_id and id = new.rule_set_id;
  if rule_set.confirmed_at is null or rule_set.effective_from > new.period_start then
    raise exception 'A pay run uses a confirmed rule set in force for its month'
      using errcode = 'check_violation', constraint = 'hr_payroll_runs_rule_set_usable';
  end if;
  return new;
end;
$$;
create trigger hr_payroll_runs_guard
  before insert or update or delete on hr_payroll_runs
  for each row execute function hr_payroll_runs_guard();

create table hr_payroll_lines (
  id                       uuid           primary key default gen_random_uuid(),
  tenant_id                uuid           not null references tenants (id) on delete restrict,
  run_id                   uuid           not null,
  employee_id              uuid           not null,
  -- What went in.
  basic                    numeric(20,4)  not null,
  allowances               numeric(20,4)  not null,
  clocked_hours            numeric(10,2)  not null default 0,
  overtime_hours           numeric(10,2)  not null default 0,
  overtime_rate            numeric(20,4)  not null default 0,
  bonus                    numeric(20,4)  not null default 0,
  deduction                numeric(20,4)  not null default 0,
  unpaid_days              numeric(6,2)   not null default 0,
  reimbursements           numeric(20,4)  not null default 0,
  declared_insurable_wage  numeric(20,4),
  insured                  boolean        not null,
  pay_method               text           not null,
  note                     text,
  -- What came out.
  overtime_pay             numeric(20,4)  not null,
  unpaid_leave             numeric(20,4)  not null,
  gross                    numeric(20,4)  not null,
  insurable_wage           numeric(20,4)  not null,
  si_employee              numeric(20,4)  not null,
  si_employer              numeric(20,4)  not null,
  taxable                  numeric(20,4)  not null,
  income_tax               numeric(20,4)  not null,
  martyrs_fund             numeric(20,4)  not null,
  net                      numeric(20,4)  not null,
  version                  integer        not null default 1,
  updated_at               timestamptz    not null default now(),
  constraint hr_payroll_lines_tenant_id_unique unique (tenant_id, id),
  constraint hr_payroll_lines_employee_unique unique (tenant_id, run_id, employee_id),
  constraint hr_payroll_lines_run_fk
    foreign key (tenant_id, run_id) references hr_payroll_runs (tenant_id, id) on delete cascade,
  constraint hr_payroll_lines_employee_fk
    foreign key (tenant_id, employee_id) references hr_employees (tenant_id, id),
  constraint hr_payroll_lines_inputs check (
    basic >= 0 and allowances >= 0 and clocked_hours >= 0 and overtime_hours >= 0
    and overtime_rate >= 0 and bonus >= 0 and deduction >= 0 and reimbursements >= 0
    and unpaid_days between 0 and 30
    and (declared_insurable_wage is null or declared_insurable_wage > 0)),
  constraint hr_payroll_lines_outputs check (
    overtime_pay >= 0 and unpaid_leave >= 0 and gross >= 0 and insurable_wage >= 0
    and si_employee >= 0 and si_employer >= 0 and taxable >= 0 and income_tax >= 0
    and martyrs_fund >= 0),
  -- Every piastre accounted for: the journal balances line by line.
  constraint hr_payroll_lines_balance check (
    net = gross - si_employee - income_tax - martyrs_fund + reimbursements),
  constraint hr_payroll_lines_pay_method_known check (pay_method in ('bank_transfer', 'cash')),
  constraint hr_payroll_lines_note_length check (note is null or char_length(note) <= 1000),
  constraint hr_payroll_lines_version_positive check (version > 0)
);
create index hr_payroll_lines_employee on hr_payroll_lines (tenant_id, employee_id);
create trigger hr_payroll_lines_set_updated_at
  before update on hr_payroll_lines
  for each row execute function set_updated_at();

-- An approved run's lines never change.
create function hr_payroll_lines_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  run_status text;
begin
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
  select r.status into run_status from hr_payroll_runs r
   where r.tenant_id = coalesce(new.tenant_id, old.tenant_id) and r.id = coalesce(new.run_id, old.run_id);
  -- Gone already: the draft is being discarded.
  if run_status is not null and run_status <> 'draft' then
    raise exception 'An approved pay run does not change'
      using errcode = 'check_violation', constraint = 'hr_payroll_runs_frozen';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger hr_payroll_lines_guard
  before insert or update or delete on hr_payroll_lines
  for each row execute function hr_payroll_lines_guard();

-- Claims paid through payroll name the run that paid them.
alter table hr_expense_claims
  add column payroll_run_id uuid,
  add constraint hr_expense_claims_payroll_run_fk
    foreign key (tenant_id, payroll_run_id) references hr_payroll_runs (tenant_id, id),
  add constraint hr_expense_claims_payroll_pairing check (
    coalesce(paid_via = 'payroll', false) = (payroll_run_id is not null));
create index hr_expense_claims_payroll_run on hr_expense_claims (tenant_id, payroll_run_id)
  where payroll_run_id is not null;

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create or replace function erp_ledger_proposal_more(p_tenant uuid, p_kind text, p_source uuid)
  returns table (account_id uuid, debit numeric, credit numeric, customer_id uuid)
  language plpgsql
  stable
  set search_path = pg_catalog, public
as $$
declare
  s erp_ledger_settings%rowtype;
begin
  select * into s from erp_ledger_settings where tenant_id = p_tenant;
  if not found then
    return;
  end if;

  if p_kind = 'expense_claim' then
    return query
    select coalesce(c.account_id, s.staff_expenses_account_id), x.amount, 0::numeric, null::uuid
      from hr_expense_claims x
      join hr_expense_categories c on c.tenant_id = x.tenant_id and c.id = x.category_id
     where x.tenant_id = p_tenant and x.id = p_source
    union all
    select s.staff_claims_payable_account_id, 0::numeric, x.amount, null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source;
    return;
  end if;

  if p_kind = 'expense_payment' then
    return query
    select s.staff_claims_payable_account_id, x.amount, 0::numeric, null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source
    union all
    select case x.paid_via when 'cash' then s.cash_account_id else s.bank_account_id end,
           0::numeric, x.amount, null::uuid
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
end;
$$;

create or replace function erp_ledger_source_label_more(p_tenant uuid, p_kind text, p_source uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'expense_claim' then (select 'EX-' || lpad(x.reference::text, 6, '0') from hr_expense_claims x
                                where x.tenant_id = p_tenant and x.id = p_source)
    when 'expense_payment' then (select 'EX-' || lpad(x.reference::text, 6, '0') || ' paid' from hr_expense_claims x
                                  where x.tenant_id = p_tenant and x.id = p_source)
    when 'payroll_run' then (select 'PR-' || to_char(r.period_start, 'YYYY-MM') from hr_payroll_runs r
                              where r.tenant_id = p_tenant and r.id = p_source)
    else null
  end;
$$;

create or replace function erp_ledger_backfill_more(p_tenant uuid, p_start date, p_tz text) returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
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

-- An approved run posts on the last day of its month.
create function hr_payroll_runs_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if old.status = 'draft' and new.status = 'approved' then
    perform erp_ledger_capture(new.tenant_id, 'payroll_run', new.id, new.period_end, new.currency, new.approved_by);
  end if;
  return null;
end;
$$;
create trigger hr_payroll_runs_ledger_capture
  after update of status on hr_payroll_runs
  for each row execute function hr_payroll_runs_ledger_capture();

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

-- Unconfirmed sets and drafts are deleted; the guards refuse the rest.
grant select, insert, update, delete on hr_payroll_rule_sets to integr8_app;
grant select, insert, update, delete on hr_pay_terms to integr8_app;
grant select, insert, update, delete on hr_payroll_runs to integr8_app;
grant select, insert, update, delete on hr_payroll_lines to integr8_app;

alter table hr_payroll_rule_sets enable row level security;
create policy hr_payroll_rule_sets_isolation on hr_payroll_rule_sets
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table hr_pay_terms enable row level security;
create policy hr_pay_terms_isolation on hr_pay_terms
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table hr_payroll_runs enable row level security;
create policy hr_payroll_runs_isolation on hr_payroll_runs
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table hr_payroll_lines enable row level security;
create policy hr_payroll_lines_isolation on hr_payroll_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
