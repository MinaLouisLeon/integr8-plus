-- 0064 - money to the currency's minor unit, and reversing a payment (ADR-0007, 2026-10-31).
--
-- Two findings of the pre-production audit about the company's own invoices.
--
-- 1. Rounding. Every line was rounded to four places, so an invoice for
--    7 x 13.33 at 14% VAT came to 106.3730 and could only be marked paid by a
--    payment of exactly that, a sum no bank transfer or cash drawer carries.
--    Each line's figures (gross, discount, net and tax) are now rounded half up
--    to the currency's minor unit: two places for the Egyptian pound, as many
--    as ISO 4217 says for others. A document's total stays the sum of its
--    rounded lines. The scale is kept on each line (`money_scale`), set when
--    the line is written from its document's currency, so documents issued
--    before this migration keep their four places and their totals exactly:
--    nothing issued is ever recomputed. A credit note takes its invoice's
--    scale, so crediting an old invoice in full still matches it to the
--    fourth place. Drafts written from here on take the new scale.
--    An accountant must confirm the rule before production (ADR-0007).
--
-- 2. Reversing a receipt. A payment receipt was insert-only, with no way back
--    from a bounced cheque or a payment recorded against the wrong customer.
--    A reversal is now its own record (`erp_payment_reversals`, one per
--    receipt, with a reason): the receipt stays, its allocations are removed
--    (so the invoices owe again), it cannot be allocated again, and the ledger
--    posts the opposite of the receipt's entry. Both stay in the history.

-- ---------------------------------------------------------------------------
-- The currency's minor unit
-- ---------------------------------------------------------------------------

-- ISO 4217 exponents. Two unless listed; kept in step with `currencyMinorUnits`
-- in @integr8/core.
create function erp_currency_minor_unit(p_currency text) returns integer
  language sql
  immutable
  set search_path = pg_catalog, public
as $$
  select case
    when p_currency in ('BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
                        'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF') then 0
    when p_currency in ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND') then 3
    else 2
  end;
$$;

-- A line's total at a given scale: gross, less discount, plus tax, each rounded once.
create function erp_line_total(
  quantity numeric, unit_price numeric, discount_bp integer, tax_rate_bp integer, scale integer)
  returns numeric
  language sql
  immutable
  set search_path = pg_catalog, public
as $$
  select net + round(net * tax_rate_bp / 10000, scale)
    from (select round(gross - round(gross * discount_bp / 10000, scale), scale) as net
            from (select round(quantity * unit_price, scale) as gross) g) n;
$$;

-- Every line written before this migration keeps four places.
alter table crm_quote_lines add column money_scale smallint not null default 4;
alter table erp_sales_order_lines add column money_scale smallint not null default 4;
alter table erp_invoice_lines add column money_scale smallint not null default 4;
alter table erp_credit_note_lines add column money_scale smallint not null default 4;
alter table crm_quote_lines add constraint crm_quote_lines_money_scale_range check (money_scale between 0 and 4);
alter table erp_sales_order_lines add constraint erp_sales_order_lines_money_scale_range check (money_scale between 0 and 4);
alter table erp_invoice_lines add constraint erp_invoice_lines_money_scale_range check (money_scale between 0 and 4);
alter table erp_credit_note_lines add constraint erp_credit_note_lines_money_scale_range check (money_scale between 0 and 4);

-- A new line takes the scale its document's other lines have, so one document
-- never mixes two; the first line of a document takes its currency's.
create function erp_assign_line_scale() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'crm_quote_lines' then
    new.money_scale := coalesce(
      (select l.money_scale from crm_quote_lines l
        where l.tenant_id = new.tenant_id and l.quote_id = new.quote_id and l.id <> new.id limit 1),
      (select erp_currency_minor_unit(q.currency_code) from crm_quotes q
        where q.tenant_id = new.tenant_id and q.id = new.quote_id),
      2);
  elsif tg_table_name = 'erp_sales_order_lines' then
    new.money_scale := coalesce(
      (select l.money_scale from erp_sales_order_lines l
        where l.tenant_id = new.tenant_id and l.order_id = new.order_id and l.id <> new.id limit 1),
      (select erp_currency_minor_unit(o.currency_code) from erp_sales_orders o
        where o.tenant_id = new.tenant_id and o.id = new.order_id),
      2);
  elsif tg_table_name = 'erp_invoice_lines' then
    new.money_scale := coalesce(
      (select l.money_scale from erp_invoice_lines l
        where l.tenant_id = new.tenant_id and l.invoice_id = new.invoice_id and l.id <> new.id limit 1),
      (select erp_currency_minor_unit(i.currency_code) from erp_invoices i
        where i.tenant_id = new.tenant_id and i.id = new.invoice_id),
      2);
  else
    -- A credit note follows its invoice, so crediting an old one matches it.
    new.money_scale := coalesce(
      (select l.money_scale from erp_credit_note_lines l
        where l.tenant_id = new.tenant_id and l.credit_note_id = new.credit_note_id and l.id <> new.id limit 1),
      (select il.money_scale from erp_credit_notes c
         join erp_invoice_lines il on il.tenant_id = c.tenant_id and il.invoice_id = c.invoice_id
        where c.tenant_id = new.tenant_id and c.id = new.credit_note_id limit 1),
      (select erp_currency_minor_unit(i.currency_code) from erp_credit_notes c
         join erp_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
        where c.tenant_id = new.tenant_id and c.id = new.credit_note_id),
      2);
  end if;
  return new;
end;
$$;
comment on function erp_assign_line_scale() is
  'Sets a new sales or finance line''s money_scale: its document''s other lines'', else its currency''s minor unit (0064).';

create trigger crm_quote_lines_money_scale before insert on crm_quote_lines
  for each row execute function erp_assign_line_scale();
create trigger erp_sales_order_lines_money_scale before insert on erp_sales_order_lines
  for each row execute function erp_assign_line_scale();
create trigger erp_invoice_lines_money_scale before insert on erp_invoice_lines
  for each row execute function erp_assign_line_scale();
create trigger erp_credit_note_lines_money_scale before insert on erp_credit_note_lines
  for each row execute function erp_assign_line_scale();

create or replace function erp_invoice_total(p_tenant uuid, p_invoice uuid) returns numeric
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(sum(erp_line_total(l.quantity, l.unit_price, l.discount_bp, l.tax_rate_bp, l.money_scale)), 0)
    from erp_invoice_lines l
   where l.tenant_id = p_tenant and l.invoice_id = p_invoice;
$$;

create or replace function erp_credit_note_total(p_tenant uuid, p_credit_note uuid) returns numeric
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(sum(erp_line_total(l.quantity, l.unit_price, l.discount_bp, l.tax_rate_bp, l.money_scale)), 0)
    from erp_credit_note_lines l
   where l.tenant_id = p_tenant and l.credit_note_id = p_credit_note;
$$;

-- ---------------------------------------------------------------------------
-- Reversing a payment receipt
-- ---------------------------------------------------------------------------

create table erp_payment_reversals (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  receipt_id   uuid        not null,
  reason       text        not null,
  -- In the company's calendar: the day the ledger posts the reversal.
  reversed_on  date        not null,
  reversed_by  uuid        not null,
  reversed_at  timestamptz not null default now(),
  constraint erp_payment_reversals_tenant_id_unique unique (tenant_id, id),
  -- A receipt is reversed once.
  constraint erp_payment_reversals_receipt_unique unique (tenant_id, receipt_id),
  constraint erp_payment_reversals_receipt_fk
    foreign key (tenant_id, receipt_id) references erp_payment_receipts (tenant_id, id) on delete restrict,
  constraint erp_payment_reversals_reason_length check (char_length(btrim(reason)) between 1 and 2000)
);
comment on table erp_payment_reversals is
  'A payment receipt taken back, with why (0064). The receipt stays; its allocations are removed and the ledger posts the opposite entry. Insert-only.';

-- Undo what the receipt did: its allocations are removed, so the invoices owe
-- again, and the ledger takes the money back. Security definer: the runtime
-- role may not remove an allocation it did not make through the API, nor
-- queue a ledger posting.
create function erp_payment_reversals_apply() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  currency text;
begin
  update public.erp_payment_allocations
     set removed_at = now(), removed_by = new.reversed_by
   where tenant_id = new.tenant_id and receipt_id = new.receipt_id and removed_at is null;
  select r.currency_code into currency
    from public.erp_payment_receipts r
   where r.tenant_id = new.tenant_id and r.id = new.receipt_id;
  perform public.erp_ledger_capture(
    new.tenant_id, 'payment_reversal', new.receipt_id, new.reversed_on, currency, new.reversed_by);
  return null;
end;
$$;
comment on function erp_payment_reversals_apply() is
  'Removes a reversed receipt''s allocations and queues the opposite ledger entry (0064).';
create trigger erp_payment_reversals_apply
  after insert on erp_payment_reversals
  for each row execute function erp_payment_reversals_apply();

grant select, insert on erp_payment_reversals to integr8_app;
alter table erp_payment_reversals enable row level security;
create policy erp_payment_reversals_isolation on erp_payment_reversals
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- A reversed receipt is not allocated again. Otherwise as in 0030.
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

  if exists (select 1 from public.erp_payment_reversals v
              where v.tenant_id = new.tenant_id and v.receipt_id = new.receipt_id) then
    raise exception 'A reversed payment is not allocated'
      using errcode = 'check_violation', constraint = 'erp_payment_allocations_receipt_reversed';
  end if;
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

-- The ledger: a reversal is a document it posts, from the receipt.
alter table erp_journals drop constraint erp_journals_source_kind_known;
alter table erp_journals add constraint erp_journals_source_kind_known check (
  source_kind is null or source_kind in (
    'invoice', 'credit_note', 'invoice_void', 'payment', 'stock',
    'expense_claim', 'expense_payment', 'payroll_run', 'assembly', 'payment_reversal'));
alter table erp_ledger_postings drop constraint erp_ledger_postings_source_kind_known;
alter table erp_ledger_postings add constraint erp_ledger_postings_source_kind_known check (
  source_kind in (
    'invoice', 'credit_note', 'invoice_void', 'payment', 'stock',
    'expense_claim', 'expense_payment', 'payroll_run', 'assembly', 'payment_reversal'));

-- Lines at their own scale, and a reversed receipt. Otherwise as in 0040.
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
             round(g.gross - round(g.gross * l.discount_bp / 10000, l.money_scale), l.money_scale) as net
        from erp_invoice_lines l
        cross join lateral (select round(l.quantity * l.unit_price, l.money_scale) as gross) g
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
             round(g.gross - round(g.gross * l.discount_bp / 10000, l.money_scale), l.money_scale) as net
        from erp_credit_note_lines l
        cross join lateral (select round(l.quantity * l.unit_price, l.money_scale) as gross) g
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

  -- A reversed receipt (0064) takes back exactly what the receipt posted:
  -- the money leaves the account it came into, and the customer owes again.
  -- Its source is the receipt itself; a receipt is reversed once.
  if p_kind = 'payment_reversal' then
    return query
    with signed as (
      select 1 as ord, s.receivables_account_id as account, r.amount as amount, r.customer_id as customer
        from erp_payment_receipts r where r.tenant_id = p_tenant and r.id = p_source
      union all
      select 2,
             case r.method when 'cash' then s.cash_account_id
                           when 'bank_transfer' then s.bank_account_id
                           else s.other_receipts_account_id end,
             -r.amount, null::uuid
        from erp_payment_receipts r where r.tenant_id = p_tenant and r.id = p_source
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

-- Its label. Otherwise as in 0039.
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
    when 'payment_reversal' then (select 'RC-' || lpad(r.reference::text, 6, '0') || ' reversed'
                                   from erp_payment_receipts r
                                  where r.tenant_id = p_tenant and r.id = p_source)
    else null
  end;
$$;

-- Reversals on or after the ledger's start join the unposted list. Otherwise as in 0039.
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
