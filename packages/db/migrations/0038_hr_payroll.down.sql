-- Reverses 0038. Pay runs, their lines, pay terms and rule sets are dropped,
-- and the ledger's functions go back to 0037's. Claims paid through a run
-- stay paid, without saying which run. Fine on a test database; on a live
-- one, export first.

drop trigger hr_payroll_runs_ledger_capture on hr_payroll_runs;
drop function hr_payroll_runs_ledger_capture();

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
    else null
  end;
$$;

-- What was recorded on or after the start, of kinds added after 0034.
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

drop index hr_expense_claims_payroll_run;
alter table hr_expense_claims
  drop constraint hr_expense_claims_payroll_pairing,
  drop constraint hr_expense_claims_payroll_run_fk,
  drop column payroll_run_id;

drop table hr_payroll_lines;
drop function hr_payroll_lines_guard();
drop table hr_payroll_runs;
drop function hr_payroll_runs_guard();
drop table hr_pay_terms;
drop table hr_payroll_rule_sets;
drop function hr_payroll_rule_sets_guard();
