-- Reverses 0040.

create or replace function erp_stock_movements_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  -- An assembly order's movements post as the order (ADR-0011).
  if new.kind in ('assembly_consumption', 'assembly_output') then
    perform erp_ledger_capture(
      new.tenant_id, 'assembly', new.posting_id,
      (new.occurred_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      erp_ledger_currency(new.tenant_id), new.actor_id);
  elsif new.kind not in ('transfer_out', 'transfer_in') then
    perform erp_ledger_capture(
      new.tenant_id, 'stock', new.posting_id,
      (new.occurred_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      erp_ledger_currency(new.tenant_id), new.actor_id);
  end if;
  return null;
end;
$$;

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

  -- Documents added after 0034 (expense claims, pay runs, assemblies).
  return query select * from erp_ledger_proposal_more(p_tenant, p_kind, p_source);
end;
$$;


delete from attachments where item_id is not null or work_order_purchase_id is not null;
drop index attachments_item_main_unique;
drop index attachments_work_order_purchase_idx;
drop index attachments_item_idx;
alter table attachments
  drop constraint attachments_main_is_item,
  drop constraint attachments_one_owner,
  add constraint attachments_one_owner
    check (num_nonnulls(customer_id, site_id, work_order_id, asset_id, expense_claim_id) = 1),
  drop constraint attachments_work_order_purchase_fk,
  drop constraint attachments_item_fk,
  drop column is_main,
  drop column work_order_purchase_id,
  drop column item_id;

drop trigger erp_work_order_purchases_guard on erp_work_order_purchases;
drop function erp_work_order_purchases_guard();
drop table erp_work_order_purchases;
drop table erp_van_request_lines;
drop table erp_van_requests;
drop table erp_sales_delivery_lines;
drop table erp_sales_deliveries;
delete from sales_document_counters where kind = 'delivery';
alter table sales_document_counters drop constraint sales_document_counters_kind_known;
alter table sales_document_counters add constraint sales_document_counters_kind_known
  check (kind in ('quote', 'sales_order'));
drop table erp_supplier_prices;

alter table erp_stock_locations
  drop constraint erp_stock_locations_customer_is_site,
  drop constraint erp_stock_locations_ownership_known,
  drop column ownership;
