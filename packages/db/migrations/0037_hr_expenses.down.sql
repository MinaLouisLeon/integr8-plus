-- Reverses 0037. The ledger's functions go back to 0034's; expense claims,
-- their categories and the receipts attached to them are dropped, and the
-- new posting accounts are forgotten by the settings (the accounts stay in
-- the chart). Fine on a test database; on a live one, export first.

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
    ), signed as (
      select s.inventory_account_id as account, v.value as amount from valued v
      union all
      select case
               when v.kind = 'receipt' and v.source_key like 'receipt-line:%' then s.goods_received_account_id
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
end;
$$;

create or replace function erp_ledger_source_label(p_tenant uuid, p_kind text, p_source uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'invoice' then (select 'INV-' || lpad(i.reference::text, 6, '0') from erp_invoices i
                          where i.tenant_id = p_tenant and i.id = p_source)
    when 'invoice_void' then (select 'INV-' || lpad(i.reference::text, 6, '0') || ' void' from erp_invoices i
                               where i.tenant_id = p_tenant and i.id = p_source)
    when 'credit_note' then (select 'CN-' || lpad(c.reference::text, 6, '0') from erp_credit_notes c
                              where c.tenant_id = p_tenant and c.id = p_source)
    when 'payment' then (select 'RC-' || lpad(r.reference::text, 6, '0') from erp_payment_receipts r
                          where r.tenant_id = p_tenant and r.id = p_source)
    else null
  end;
$$;

create or replace function erp_ledger_try_post(p_posting uuid, p_actor uuid, p_force boolean default false)
  returns text
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  p          erp_ledger_postings%rowtype;
  s          erp_ledger_settings%rowtype;
  parent     uuid;
  parent_row erp_ledger_postings%rowtype;
  journal    uuid;
  debits     numeric;
  lines      integer;
  outcome    text;
begin
  select * into p from erp_ledger_postings where id = p_posting for update;
  if not found or p.status <> 'pending' then
    return coalesce(p.status, 'missing');
  end if;
  select * into s from erp_ledger_settings where tenant_id = p.tenant_id;
  if not found then
    return 'not_set_up';
  end if;

  -- A credit note or a void follows its invoice: it is set aside with it, and
  -- waits while it waits.
  parent := erp_ledger_parent_invoice(p.tenant_id, p.source_kind, p.source_id);
  if parent is not null then
    select * into parent_row from erp_ledger_postings
     where tenant_id = p.tenant_id and source_kind = 'invoice' and source_id = parent;
    if parent_row.status = 'skipped' then
      update erp_ledger_postings
         set status = 'skipped', reason = null, detail = null, resolved_at = now(),
             resolved_by = p_actor, skip_reason = 'Its invoice was set aside'
       where id = p.id;
      return 'skipped';
    end if;
  end if;

  outcome := case
    when not p_force and p.source_kind = 'stock' and not s.auto_post_stock then 'auto_off'
    when not p_force and p.source_kind <> 'stock' and not s.auto_post_sales then 'auto_off'
    when p.currency <> erp_ledger_currency(p.tenant_id) then 'foreign_currency'
    when p.source_kind = 'stock' and exists (
      select 1 from erp_stock_movements m
       where m.tenant_id = p.tenant_id and m.posting_id = p.source_id
         and m.kind not in ('transfer_out', 'transfer_in') and m.unit_cost is null) then 'cost_unknown'
    when erp_ledger_period_locked(p.tenant_id, p.document_date) then 'period_locked'
    else null
  end;

  if outcome is null and parent_row.status = 'pending' then
    outcome := 'waits_for_invoice';
  end if;

  if outcome is not null then
    update erp_ledger_postings set reason = outcome, detail = null where id = p.id;
    return outcome;
  end if;

  select coalesce(sum(x.debit), 0), count(*) into debits, lines
    from erp_ledger_proposal(p.tenant_id, p.source_kind, p.source_id) x;
  if lines = 0 or debits = 0 then
    update erp_ledger_postings
       set status = 'skipped', reason = null, detail = null, resolved_at = now(),
           resolved_by = null, skip_reason = 'Nothing to post'
     where id = p.id;
    return 'skipped';
  end if;

  begin
    insert into erp_journals (tenant_id, kind, entry_date, memo, source_kind, source_id, drafted_by)
    values (p.tenant_id, 'automatic', p.document_date,
            erp_ledger_source_label(p.tenant_id, p.source_kind, p.source_id),
            p.source_kind, p.source_id, p_actor)
    returning id into journal;
    insert into erp_journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, customer_id)
    select p.tenant_id, journal, x.n, x.account_id, x.debit, x.credit, x.customer_id
      from erp_ledger_proposal(p.tenant_id, p.source_kind, p.source_id)
           with ordinality as x(account_id, debit, credit, customer_id, n);
    update erp_journals set status = 'posted', posted_by = p_actor, posted_at = now()
     where tenant_id = p.tenant_id and id = journal;
    update erp_ledger_postings
       set status = 'posted', journal_id = journal, reason = null, detail = null,
           resolved_by = p_actor, resolved_at = now()
     where id = p.id;
  exception when others then
    update erp_ledger_postings set reason = 'failed', detail = left(sqlerrm, 1000) where id = p.id;
    return 'failed';
  end;

  -- An invoice posted: what was waiting for it may go now.
  if p.source_kind = 'invoice' then
    perform erp_ledger_try_post(w.id, p_actor, p_force)
       from erp_ledger_postings w
      where w.tenant_id = p.tenant_id and w.status = 'pending' and w.reason = 'waits_for_invoice'
        and erp_ledger_parent_invoice(w.tenant_id, w.source_kind, w.source_id) = p.source_id;
  end if;
  return 'posted';
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
  return added;
end;
$$;

drop trigger hr_expense_claims_ledger_capture on hr_expense_claims;
drop function hr_expense_claims_ledger_capture();
drop function erp_ledger_backfill_more(uuid, date, text);
drop function erp_ledger_source_label_more(uuid, text, uuid);
drop function erp_ledger_proposal_more(uuid, text, uuid);
drop function erp_ledger_auto_on(erp_ledger_settings, text);

delete from attachments where expense_claim_id is not null;
alter table attachments
  drop constraint attachments_one_owner,
  drop constraint attachments_expense_claim_fk,
  drop column expense_claim_id,
  add constraint attachments_one_owner
    check (num_nonnulls(customer_id, site_id, work_order_id, asset_id) = 1);

drop table hr_expense_claims;
drop function hr_expense_claims_guard();
drop function assign_expense_reference();
drop table expense_reference_counters;
drop table hr_expense_categories;

-- What those documents posted goes with them: their journals are history the
-- guards keep, so the guards stand aside while they are removed.
alter table erp_ledger_postings disable trigger erp_ledger_postings_guard;
alter table erp_journals disable trigger erp_journals_guard;
alter table erp_journal_lines disable trigger erp_journal_lines_guard;
create temporary table gone_journals on commit drop as
  select tenant_id, id from erp_journals
   where source_kind in ('expense_claim', 'expense_payment', 'payroll_run', 'assembly');
delete from erp_ledger_postings
 where source_kind in ('expense_claim', 'expense_payment', 'payroll_run', 'assembly');
delete from erp_journal_lines l using gone_journals g
 where l.tenant_id = g.tenant_id and l.journal_id = g.id;
delete from erp_journals j using gone_journals g
 where j.tenant_id = g.tenant_id and j.id = g.id;
alter table erp_journal_lines enable trigger erp_journal_lines_guard;
alter table erp_journals enable trigger erp_journals_guard;
alter table erp_ledger_postings enable trigger erp_ledger_postings_guard;
alter table erp_ledger_postings drop constraint erp_ledger_postings_source_kind_known;
alter table erp_ledger_postings add constraint erp_ledger_postings_source_kind_known check (
  source_kind in ('invoice', 'credit_note', 'invoice_void', 'payment', 'stock'));
alter table erp_journals drop constraint erp_journals_source_kind_known;
alter table erp_journals add constraint erp_journals_source_kind_known check (
  source_kind is null or source_kind in ('invoice', 'credit_note', 'invoice_void', 'payment', 'stock'));

alter table erp_ledger_settings
  drop column auto_post_expenses,
  drop column auto_post_payroll,
  drop column staff_claims_payable_account_id,
  drop column staff_expenses_account_id,
  drop column salaries_expense_account_id,
  drop column employer_insurance_expense_account_id,
  drop column salaries_payable_account_id,
  drop column payroll_tax_payable_account_id,
  drop column social_insurance_payable_account_id,
  drop column martyrs_fund_payable_account_id,
  drop column assembly_absorbed_account_id;
