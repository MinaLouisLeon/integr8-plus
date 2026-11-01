-- What the reversals posted goes with them: their journals are history the
-- guards keep, so the guards stand aside while they are removed (as in 0037).
alter table erp_ledger_postings disable trigger erp_ledger_postings_guard;
alter table erp_journals disable trigger erp_journals_guard;
alter table erp_journal_lines disable trigger erp_journal_lines_guard;
create temporary table gone_journals on commit drop as
  select tenant_id, id from erp_journals where source_kind = 'payment_reversal';
delete from erp_ledger_postings where source_kind = 'payment_reversal';
delete from erp_journal_lines l using gone_journals g
 where l.tenant_id = g.tenant_id and l.journal_id = g.id;
delete from erp_journals j using gone_journals g
 where j.tenant_id = g.tenant_id and j.id = g.id;
alter table erp_journal_lines enable trigger erp_journal_lines_guard;
alter table erp_journals enable trigger erp_journals_guard;
alter table erp_ledger_postings enable trigger erp_ledger_postings_guard;

create or replace function erp_ledger_proposal(p_tenant uuid, p_kind text, p_source uuid)
  returns table (account_id uuid, debit numeric, credit numeric, customer_id uuid)
  language plpgsql
  stable
  set search_path = pg_catalog, public
as $$
declare
  s          erp_ledger_settings%rowtype;
  invoice_id uuid;
  customer   uuid;
  total      numeric;
  sign       integer;
begin
  select * into s from erp_ledger_settings where tenant_id = p_tenant;
  if not found then
    return;
  end if;

  if p_kind in ('invoice', 'invoice_void') then
    select i.customer_id, erp_invoice_total(i.tenant_id, i.id) into customer, total
      from erp_invoices i where i.tenant_id = p_tenant and i.id = p_source;
    sign := case when p_kind = 'invoice' then 1 else -1 end;
    return query
    with nets as (
      select case when it.kind in ('stock_item', 'non_stock_item')
                  then s.revenue_goods_account_id else s.revenue_services_account_id end as account,
             round(g.gross - round(g.gross * l.discount_bp / 10000, 4), 4) as net
        from erp_invoice_lines l
        cross join lateral (select round(l.quantity * l.unit_price, 4) as gross) g
        left join erp_items it on it.tenant_id = l.tenant_id and it.id = l.item_id
       where l.tenant_id = p_tenant and l.invoice_id = p_source
    ), signed as (
      select 1 as ord, s.receivables_account_id as account, total * sign as amount, customer as customer
      union all
      select 2, n.account, -sum(n.net) * sign, null::uuid from nets n group by n.account
      union all
      select 3, s.vat_output_account_id, -(total - coalesce((select sum(n.net) from nets n), 0)) * sign, null::uuid
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), x.customer
      from signed x
      join erp_ledger_accounts a on a.tenant_id = p_tenant and a.id = x.account
     where x.amount <> 0
     order by x.ord, a.code;
    return;
  end if;

  if p_kind = 'credit_note' then
    select c.invoice_id, i.customer_id, erp_credit_note_total(c.tenant_id, c.id)
      into invoice_id, customer, total
      from erp_credit_notes c
      join erp_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
     where c.tenant_id = p_tenant and c.id = p_source;
    return query
    with nets as (
      select case when it.kind in ('stock_item', 'non_stock_item')
                  then s.revenue_goods_account_id else s.revenue_services_account_id end as account,
             round(g.gross - round(g.gross * l.discount_bp / 10000, 4), 4) as net
        from erp_credit_note_lines l
        cross join lateral (select round(l.quantity * l.unit_price, 4) as gross) g
        left join erp_items it on it.tenant_id = l.tenant_id and it.id = l.item_id
       where l.tenant_id = p_tenant and l.credit_note_id = p_source
    ), signed as (
      select 3 as ord, s.receivables_account_id as account, -total as amount, customer as customer
      union all
      select 1, n.account, sum(n.net), null::uuid from nets n group by n.account
      union all
      select 2, s.vat_output_account_id, total - coalesce((select sum(n.net) from nets n), 0), null::uuid
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), x.customer
      from signed x
      join erp_ledger_accounts a on a.tenant_id = p_tenant and a.id = x.account
     where x.amount <> 0
     order by x.ord, a.code;
    return;
  end if;

  if p_kind = 'payment' then
    return query
    with signed as (
      select 1 as ord,
             case r.method when 'cash' then s.cash_account_id
                           when 'bank_transfer' then s.bank_account_id
                           else s.other_receipts_account_id end as account,
             r.amount as amount, null::uuid as customer
        from erp_payment_receipts r where r.tenant_id = p_tenant and r.id = p_source
      union all
      select 2, s.receivables_account_id, -r.amount, r.customer_id
        from erp_payment_receipts r where r.tenant_id = p_tenant and r.id = p_source
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), x.customer
      from signed x
      join erp_ledger_accounts a on a.tenant_id = p_tenant and a.id = x.account
     where x.amount <> 0
     order by x.ord, a.code;
    return;
  end if;

  if p_kind = 'stock' then
    return query
    with valued as (
      select m.kind, m.source_key, round(m.quantity * m.unit_cost, 4) as value
        from erp_stock_movements m
       where m.tenant_id = p_tenant and m.posting_id = p_source
         and m.kind not in ('transfer_out', 'transfer_in')
         -- Stock held as the customer's is a record, never valued (0040).
         and not exists (select 1 from erp_stock_locations l
                          where l.tenant_id = m.tenant_id and l.id = m.location_id
                            and l.ownership = 'customer')
    ), signed as (
      select s.inventory_account_id as account, v.value as amount from valued v
      union all
      select case
               when v.kind = 'receipt' and v.source_key like 'receipt-line:%' then s.goods_received_account_id
               -- Handed to the customer: delivered on a sales order, or left
               -- at their site as theirs (0040).
               when v.kind = 'issue' and (v.source_key like 'delivery-line:%'
                                          or v.source_key like 'customer-site:%') then s.parts_cost_account_id
               when v.kind = 'return_to_supplier' then s.goods_received_account_id
               when v.kind in ('consumption', 'consumption_return') then s.parts_cost_account_id
               else s.stock_adjustments_account_id
             end,
             -v.value
        from valued v
    ), grouped as (
      select g.account, sum(g.amount) as amount from signed g group by g.account
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), null::uuid
      from grouped x
      join erp_ledger_accounts a on a.tenant_id = p_tenant and a.id = x.account
     where x.amount <> 0
     order by x.amount < 0, a.code;
    return;
  end if;

  -- Documents added after 0034 (expense claims, pay runs, assemblies).
  return query select * from erp_ledger_proposal_more(p_tenant, p_kind, p_source);
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
    when 'assembly' then (select 'AO-' || lpad(o.reference::text, 6, '0') from erp_assembly_orders o
                           where o.tenant_id = p_tenant and o.id = p_source)
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
    union all
    select 'assembly', o.id, (o.completed_at at time zone p_tz)::date, erp_ledger_currency(p_tenant)
      from erp_assembly_orders o
     where o.tenant_id = p_tenant and o.status = 'completed'
       and (o.completed_at at time zone p_tz)::date >= p_start
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

alter table erp_journals drop constraint erp_journals_source_kind_known;
alter table erp_journals add constraint erp_journals_source_kind_known check (
  source_kind is null or source_kind in (
    'invoice', 'credit_note', 'invoice_void', 'payment', 'stock',
    'expense_claim', 'expense_payment', 'payroll_run', 'assembly'));
alter table erp_ledger_postings drop constraint erp_ledger_postings_source_kind_known;
alter table erp_ledger_postings add constraint erp_ledger_postings_source_kind_known check (
  source_kind in (
    'invoice', 'credit_note', 'invoice_void', 'payment', 'stock',
    'expense_claim', 'expense_payment', 'payroll_run', 'assembly'));

create or replace function erp_payment_allocations_guard() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  receipt record;
  invoice record;
  spent numeric;
begin
  if tg_op = 'UPDATE' then
    if old.removed_at is null and new.removed_at is not null
       and (to_jsonb(new) - array['removed_by', 'removed_at']) = (to_jsonb(old) - array['removed_by', 'removed_at']) then
      return new;
    end if;
    raise exception 'An allocation is removed, never changed'
      using errcode = 'check_violation', constraint = 'erp_payment_allocations_frozen';
  end if;

  select r.customer_id, r.currency_code, r.amount into receipt
    from public.erp_payment_receipts r
   where r.tenant_id = new.tenant_id and r.id = new.receipt_id
   for update;
  select i.customer_id, i.currency_code, i.status into invoice
    from public.erp_invoices i
   where i.tenant_id = new.tenant_id and i.id = new.invoice_id
   for update;

  if invoice.status <> 'issued' then
    raise exception 'Payments are allocated only to issued invoices'
      using errcode = 'check_violation', constraint = 'erp_payment_allocations_invoice_not_open';
  end if;
  if invoice.customer_id <> receipt.customer_id or invoice.currency_code <> receipt.currency_code then
    raise exception 'A payment is allocated only to the same customer''s invoices in its currency'
      using errcode = 'check_violation', constraint = 'erp_payment_allocations_mismatch';
  end if;
  select coalesce(sum(a.amount), 0) into spent
    from public.erp_payment_allocations a
   where a.tenant_id = new.tenant_id and a.receipt_id = new.receipt_id and a.removed_at is null;
  if spent + new.amount > receipt.amount then
    raise exception 'More than the payment has left to allocate'
      using errcode = 'check_violation', constraint = 'erp_payment_allocations_over_receipt';
  end if;
  if new.amount > public.erp_invoice_balance(new.tenant_id, new.invoice_id) then
    raise exception 'More than the invoice still owes'
      using errcode = 'check_violation', constraint = 'erp_payment_allocations_over_invoice';
  end if;
  return new;
end;
$$;

drop table erp_payment_reversals;
drop function erp_payment_reversals_apply();

create or replace function erp_invoice_total(p_tenant uuid, p_invoice uuid) returns numeric
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(sum(erp_line_total(l.quantity, l.unit_price, l.discount_bp, l.tax_rate_bp)), 0)
    from erp_invoice_lines l
   where l.tenant_id = p_tenant and l.invoice_id = p_invoice;
$$;

create or replace function erp_credit_note_total(p_tenant uuid, p_credit_note uuid) returns numeric
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(sum(erp_line_total(l.quantity, l.unit_price, l.discount_bp, l.tax_rate_bp)), 0)
    from erp_credit_note_lines l
   where l.tenant_id = p_tenant and l.credit_note_id = p_credit_note;
$$;

drop trigger crm_quote_lines_money_scale on crm_quote_lines;
drop trigger erp_sales_order_lines_money_scale on erp_sales_order_lines;
drop trigger erp_invoice_lines_money_scale on erp_invoice_lines;
drop trigger erp_credit_note_lines_money_scale on erp_credit_note_lines;
drop function erp_assign_line_scale();
alter table crm_quote_lines drop column money_scale;
alter table erp_sales_order_lines drop column money_scale;
alter table erp_invoice_lines drop column money_scale;
alter table erp_credit_note_lines drop column money_scale;
drop function erp_line_total(numeric, numeric, integer, integer, integer);
drop function erp_currency_minor_unit(text);
