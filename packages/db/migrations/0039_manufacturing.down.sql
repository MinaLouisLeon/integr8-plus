-- Reverses 0039. Bills of materials, assembly orders and plans are dropped,
-- with the stock movements assembly orders wrote and what they posted (the
-- guards stand aside for it), and the ledger's functions go back to 0038's.
-- Fine on a test database; on a live one, export first.

create or replace function erp_stock_movements_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if new.kind not in ('transfer_out', 'transfer_in') then
    perform erp_ledger_capture(
      new.tenant_id, 'stock', new.posting_id,
      (new.occurred_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      erp_ledger_currency(new.tenant_id), new.actor_id);
  end if;
  return null;
end;
$$;
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

create or replace function erp_ledger_backfill(p_tenant uuid) returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  start  date;
  tz     text;
  added  integer;
begin
  select s.start_date into start from erp_ledger_settings s where s.tenant_id = p_tenant;
  if start is null then
    return 0;
  end if;
  tz := erp_ledger_timezone(p_tenant);
  delete from erp_ledger_postings
   where tenant_id = p_tenant and status = 'pending' and document_date < start;

  with found as (
    select 'invoice' as kind, i.id, i.issue_date as day, i.currency_code as currency
      from erp_invoices i
     where i.tenant_id = p_tenant and i.status <> 'draft' and i.issue_date >= start
    union all
    select 'invoice_void', i.id, (i.voided_at at time zone tz)::date, i.currency_code
      from erp_invoices i
     where i.tenant_id = p_tenant and i.status = 'void' and (i.voided_at at time zone tz)::date >= start
    union all
    select 'credit_note', c.id, c.issue_date, i.currency_code
      from erp_credit_notes c
      join erp_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
     where c.tenant_id = p_tenant and c.status = 'issued' and c.issue_date >= start
    union all
    select 'payment', r.id, r.received_on, r.currency_code
      from erp_payment_receipts r
     where r.tenant_id = p_tenant and r.received_on >= start
    union all
    select distinct on (m.posting_id) 'stock', m.posting_id, (m.occurred_at at time zone tz)::date,
           erp_ledger_currency(p_tenant)
      from erp_stock_movements m
     where m.tenant_id = p_tenant and m.kind not in ('transfer_out', 'transfer_in')
       and (m.occurred_at at time zone tz)::date >= start
  ), inserted as (
    insert into erp_ledger_postings (tenant_id, source_kind, source_id, document_date, currency, reason)
    select p_tenant, f.kind, f.id, f.day, f.currency, 'before_set_up' from found f
    on conflict (tenant_id, source_kind, source_id) do nothing
    returning 1
  )
  select count(*) into added from inserted;
  return added + erp_ledger_backfill_more(p_tenant, start, tz);
end;
$$;


alter table erp_ledger_postings disable trigger erp_ledger_postings_guard;
alter table erp_journals disable trigger erp_journals_guard;
alter table erp_journal_lines disable trigger erp_journal_lines_guard;
alter table erp_stock_movements disable trigger erp_stock_movements_no_delete;
create temporary table gone_journals on commit drop as
  select tenant_id, id from erp_journals where source_kind = 'assembly';
delete from erp_ledger_postings where source_kind = 'assembly';
delete from erp_journal_lines l using gone_journals g
 where l.tenant_id = g.tenant_id and l.journal_id = g.id;
delete from erp_journals j using gone_journals g
 where j.tenant_id = g.tenant_id and j.id = g.id;
-- Their stock goes back as if they never happened.
update erp_stock_balances b set on_hand = b.on_hand - m.total
  from (select tenant_id, item_id, location_id, sum(quantity) as total
          from erp_stock_movements where kind in ('assembly_consumption', 'assembly_output')
         group by tenant_id, item_id, location_id) m
 where b.tenant_id = m.tenant_id and b.item_id = m.item_id and b.location_id = m.location_id;
delete from erp_stock_movements where kind in ('assembly_consumption', 'assembly_output');
alter table erp_stock_movements enable trigger erp_stock_movements_no_delete;
alter table erp_journal_lines enable trigger erp_journal_lines_guard;
alter table erp_journals enable trigger erp_journals_guard;
alter table erp_ledger_postings enable trigger erp_ledger_postings_guard;

drop table erp_mrp_suggestions;
drop function erp_mrp_suggestions_guard();
drop table erp_assembly_orders;
drop function erp_assembly_orders_guard();
drop table erp_mrp_plans;
drop function assign_assembly_reference();
drop table assembly_reference_counters;
drop table erp_bom_components;
drop function erp_bom_components_guard();
drop table erp_boms;
drop function erp_boms_guard();

alter table erp_stock_movements drop constraint erp_stock_movements_quantity_signed;
alter table erp_stock_movements add constraint erp_stock_movements_quantity_signed check (
  quantity <> 0 and case
    when kind in ('receipt', 'transfer_in', 'consumption_return') then quantity > 0
    when kind in ('issue', 'transfer_out', 'consumption', 'return_to_supplier') then quantity < 0
    else true
  end);
alter table erp_stock_movements drop constraint erp_stock_movements_kind_known;
alter table erp_stock_movements add constraint erp_stock_movements_kind_known check (kind in (
  'receipt', 'issue', 'transfer_out', 'transfer_in', 'adjustment', 'count_adjustment',
  'consumption', 'consumption_return', 'return_to_supplier'));

alter table erp_items
  drop constraint erp_items_lead_time_sane,
  drop column lead_time_days;
