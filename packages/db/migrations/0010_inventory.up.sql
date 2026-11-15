-- Items, locations, stock movements, counts, lots and materials used on jobs.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.erp_ledger_auto_on(s public.erp_ledger_settings, p_kind text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case
    when p_kind in ('stock', 'assembly') then s.auto_post_stock
    when p_kind in ('expense_claim', 'expense_payment') then s.auto_post_expenses
    when p_kind = 'payroll_run' then s.auto_post_payroll
    else s.auto_post_sales
  end;
$$;

CREATE FUNCTION public.erp_ledger_capture(p_tenant uuid, p_kind text, p_source uuid, p_date date, p_currency text, p_actor uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  start   date;
  posting uuid;
begin
  select s.start_date into start from erp_ledger_settings s where s.tenant_id = p_tenant;
  if start is null or p_date < start then
    return;
  end if;
  insert into erp_ledger_postings (tenant_id, source_kind, source_id, document_date, currency, reason)
  values (p_tenant, p_kind, p_source, p_date, p_currency, 'queued')
  on conflict (tenant_id, source_kind, source_id) do nothing
  returning id into posting;
  if posting is not null then
    perform erp_ledger_try_post(posting, p_actor, false);
  end if;
end;
$$;

CREATE FUNCTION public.erp_ledger_parent_invoice(p_tenant uuid, p_kind text, p_source uuid) RETURNS uuid
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case p_kind
    when 'invoice_void' then p_source
    when 'credit_note' then (select c.invoice_id from erp_credit_notes c
                              where c.tenant_id = p_tenant and c.id = p_source)
  end;
$$;

CREATE FUNCTION public.erp_ledger_proposal(p_tenant uuid, p_kind text, p_source uuid) RETURNS TABLE(account_id uuid, debit numeric, credit numeric, customer_id uuid)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.erp_ledger_source_label(p_tenant uuid, p_kind text, p_source uuid) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case p_kind
    when 'invoice' then (select 'INV-' || lpad(i.reference::text, 6, '0') from erp_invoices i
                          where i.tenant_id = p_tenant and i.id = p_source)
    when 'invoice_void' then (select 'INV-' || lpad(i.reference::text, 6, '0') || ' void' from erp_invoices i
                               where i.tenant_id = p_tenant and i.id = p_source)
    when 'credit_note' then (select 'CN-' || lpad(c.reference::text, 6, '0') from erp_credit_notes c
                              where c.tenant_id = p_tenant and c.id = p_source)
    when 'payment' then (select 'RC-' || lpad(r.reference::text, 6, '0') from erp_payment_receipts r
                          where r.tenant_id = p_tenant and r.id = p_source)
    else erp_ledger_source_label_more(p_tenant, p_kind, p_source)
  end;
$$;

CREATE FUNCTION public.erp_ledger_try_post(p_posting uuid, p_actor uuid, p_force boolean DEFAULT false) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
    when not p_force and not erp_ledger_auto_on(s, p.source_kind) then 'auto_off'
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
    insert into erp_journal_lines (tenant_id, journal_id, entry_date, line_no, account_id, debit, credit, customer_id)
    select p.tenant_id, journal, p.document_date, x.n, x.account_id, x.debit, x.credit, x.customer_id
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

CREATE FUNCTION public.erp_stock_apply_lot_movement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  held numeric;
begin
  if new.lot_id is null then
    return new;
  end if;
  loop
    update erp_stock_lot_balances
       set on_hand = on_hand + new.quantity, updated_at = now()
     where tenant_id = new.tenant_id and lot_id = new.lot_id and location_id = new.location_id;
    exit when found;
    begin
      insert into erp_stock_lot_balances (tenant_id, lot_id, location_id, item_id, on_hand)
      values (new.tenant_id, new.lot_id, new.location_id, new.item_id, new.quantity);
      exit;
    exception when unique_violation then
      null;
    end;
  end loop;
  if exists (select 1 from erp_stock_lots l where l.tenant_id = new.tenant_id and l.id = new.lot_id and l.kind = 'serial') then
    select coalesce(sum(on_hand), 0) into held
      from erp_stock_lot_balances where tenant_id = new.tenant_id and lot_id = new.lot_id;
    if held > 1 then
      raise exception 'This serial number is already in stock'
        using errcode = 'check_violation', constraint = 'erp_stock_serial_once';
    end if;
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.erp_stock_apply_movement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  item_kind text;
begin
  select kind into item_kind from erp_items where tenant_id = new.tenant_id and id = new.item_id;
  if item_kind is distinct from 'stock_item' then
    raise exception 'Only stock items have stock'
      using errcode = 'check_violation', constraint = 'erp_stock_movements_stock_items_only';
  end if;
  loop
    update erp_stock_balances
       set on_hand = on_hand + new.quantity, updated_at = now()
     where tenant_id = new.tenant_id and item_id = new.item_id and location_id = new.location_id;
    if found then
      return new;
    end if;
    -- The first movement of this item here. Another transaction may be making
    -- the same first row; if it wins, go round and update that one instead.
    begin
      insert into erp_stock_balances (tenant_id, item_id, location_id, on_hand)
      values (new.tenant_id, new.item_id, new.location_id, new.quantity);
      return new;
    exception when unique_violation then
      null;
    end;
  end loop;
end;
$$;

CREATE FUNCTION public.erp_stock_lock_balance(p_tenant uuid, p_item uuid, p_location uuid) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  scoped uuid := app_current_tenant_id();
  held   numeric;
begin
  if scoped is null then
    if session_user = 'integr8_app' then
      raise exception 'No company is set for this transaction'
        using errcode = 'insufficient_privilege';
    end if;
  elsif scoped <> p_tenant then
    raise exception 'This balance belongs to another company'
      using errcode = 'insufficient_privilege';
  end if;
  select on_hand into held
    from erp_stock_balances
   where tenant_id = p_tenant and item_id = p_item and location_id = p_location
     for update;
  return coalesce(held, 0);
end;
$$;

CREATE FUNCTION public.erp_stock_lock_lot_balance(p_tenant uuid, p_lot uuid, p_location uuid) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  scoped uuid := app_current_tenant_id();
  held   numeric;
begin
  if scoped is null then
    if session_user = 'integr8_app' then
      raise exception 'No company is set for this transaction'
        using errcode = 'insufficient_privilege';
    end if;
  elsif scoped <> p_tenant then
    raise exception 'This balance belongs to another company'
      using errcode = 'insufficient_privilege';
  end if;
  select on_hand into held
    from erp_stock_lot_balances
   where tenant_id = p_tenant and lot_id = p_lot and location_id = p_location
     for update;
  return coalesce(held, 0);
end;
$$;

CREATE FUNCTION public.erp_stock_movements_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  raise exception 'The stock ledger is append-only: post a correcting movement instead'
    using errcode = 'check_violation', constraint = 'erp_stock_movements_append_only';
end;
$$;

CREATE FUNCTION public.erp_stock_movements_ledger_capture() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  -- Stock held as the customer's never reaches the ledger (ADR-0012).
  if exists (select 1 from erp_stock_locations l
              where l.tenant_id = new.tenant_id and l.id = new.location_id and l.ownership = 'customer') then
    return null;
  end if;
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

CREATE FUNCTION public.erp_stock_movements_lot_check() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  item_tracking text;
  lot_item uuid;
  lot_kind text;
begin
  select tracking into item_tracking from erp_items where tenant_id = new.tenant_id and id = new.item_id;
  -- An item this company cannot see is the foreign key's to refuse.
  if item_tracking is null then
    return new;
  end if;
  if new.lot_id is null then
    if item_tracking <> 'none' then
      raise exception 'A tracked item''s movement names its serial or batch'
        using errcode = 'check_violation', constraint = 'erp_stock_movements_lot_required';
    end if;
    return new;
  end if;
  select item_id, kind into lot_item, lot_kind
    from erp_stock_lots where tenant_id = new.tenant_id and id = new.lot_id;
  if lot_item is distinct from new.item_id or lot_kind is distinct from item_tracking then
    raise exception 'The serial or batch is not one of this item''s'
      using errcode = 'check_violation', constraint = 'erp_stock_movements_lot_matches';
  end if;
  if lot_kind = 'serial' and abs(new.quantity) <> 1 then
    raise exception 'A serial number moves one unit at a time'
      using errcode = 'check_violation', constraint = 'erp_stock_movements_serial_one';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.guard_work_order_material_job() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  job_state text;
begin
  if tg_op = 'INSERT' then
    select w.state into job_state
      from work_orders w
     where w.tenant_id = new.tenant_id and w.id = new.work_order_id;
    if job_state = 'cancelled' then
      raise exception 'work order % is cancelled; no parts can be recorded on it', new.work_order_id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    return new;
  end if;
  if new.recorded_after_close is distinct from old.recorded_after_close then
    raise exception 'part % keeps whether it was recorded after its job closed', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE erp_item_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT erp_item_categories_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 100)))
);

CREATE TABLE erp_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    sku text NOT NULL,
    name text NOT NULL,
    description text,
    kind text DEFAULT 'stock_item'::text NOT NULL,
    category_id uuid,
    unit text DEFAULT 'each'::text NOT NULL,
    barcode text,
    default_unit_cost numeric(20,4),
    sale_price numeric(20,4),
    average_unit_cost numeric(20,4) DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((((((COALESCE(sku, ''::text) || ' '::text) || COALESCE(name, ''::text)) || ' '::text) || COALESCE(barcode, ''::text)) || ' '::text) || COALESCE(description, ''::text)))) STORED,
    preferred_supplier_id uuid,
    supplier_part_number text,
    lead_time_days integer,
    tracking text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT erp_items_barcode_shape CHECK (((barcode IS NULL) OR ((btrim(barcode) <> ''::text) AND (char_length(barcode) <= 64)))),
    CONSTRAINT erp_items_costs_not_negative CHECK ((((default_unit_cost IS NULL) OR (default_unit_cost >= (0)::numeric)) AND ((sale_price IS NULL) OR (sale_price >= (0)::numeric)) AND (average_unit_cost >= (0)::numeric))),
    CONSTRAINT erp_items_description_length CHECK (((description IS NULL) OR (char_length(description) <= 10000))),
    CONSTRAINT erp_items_kind_known CHECK ((kind = ANY (ARRAY['stock_item'::text, 'non_stock_item'::text, 'service'::text]))),
    CONSTRAINT erp_items_lead_time_sane CHECK (((lead_time_days IS NULL) OR ((lead_time_days >= 0) AND (lead_time_days <= 3650)))),
    CONSTRAINT erp_items_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 200))),
    CONSTRAINT erp_items_sku_shape CHECK (((btrim(sku) <> ''::text) AND (char_length(sku) <= 64))),
    CONSTRAINT erp_items_supplier_part_number_length CHECK (((supplier_part_number IS NULL) OR (char_length(supplier_part_number) <= 100))),
    CONSTRAINT erp_items_tracking_known CHECK ((tracking = ANY (ARRAY['none'::text, 'serial'::text, 'batch'::text]))),
    CONSTRAINT erp_items_tracking_stock_only CHECK (((tracking = 'none'::text) OR (kind = 'stock_item'::text))),
    CONSTRAINT erp_items_unit_known CHECK ((unit = ANY (ARRAY['each'::text, 'pair'::text, 'set'::text, 'box'::text, 'pack'::text, 'roll'::text, 'm'::text, 'm2'::text, 'm3'::text, 'l'::text, 'kg'::text, 'g'::text, 'hour'::text]))),
    CONSTRAINT erp_items_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_reorder_levels (
    tenant_id uuid NOT NULL,
    item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    minimum numeric(20,4) NOT NULL,
    CONSTRAINT erp_reorder_levels_minimum_not_negative CHECK ((minimum >= (0)::numeric))
);

CREATE TABLE erp_stock_balances (
    tenant_id uuid NOT NULL,
    item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    on_hand numeric(20,4) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_stock_balances_not_negative CHECK ((on_hand >= (0)::numeric))
);

CREATE TABLE erp_stock_count_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    count_id uuid NOT NULL,
    item_id uuid NOT NULL,
    counted_quantity numeric(20,4) NOT NULL,
    expected_quantity numeric(20,4),
    lot_id uuid,
    lot_code text,
    lot_expires_on date,
    CONSTRAINT erp_stock_count_lines_counted_not_negative CHECK ((counted_quantity >= (0)::numeric)),
    CONSTRAINT erp_stock_count_lines_lot_code_length CHECK (((lot_code IS NULL) OR ((btrim(lot_code) <> ''::text) AND (char_length(lot_code) <= 100))))
);

CREATE TABLE erp_stock_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    location_id uuid NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    posted_by uuid,
    posted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_stock_counts_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 2000))),
    CONSTRAINT erp_stock_counts_posted_pairing CHECK (((status = 'posted'::text) = ((posted_at IS NOT NULL) AND (posted_by IS NOT NULL)))),
    CONSTRAINT erp_stock_counts_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text, 'cancelled'::text]))),
    CONSTRAINT erp_stock_counts_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_stock_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    assigned_to uuid,
    site_id uuid,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    ownership text DEFAULT 'ours'::text NOT NULL,
    CONSTRAINT erp_stock_locations_assignee_is_van CHECK (((assigned_to IS NULL) OR (kind = 'van'::text))),
    CONSTRAINT erp_stock_locations_customer_is_site CHECK (((ownership = 'ours'::text) OR (kind = 'site'::text))),
    CONSTRAINT erp_stock_locations_kind_known CHECK ((kind = ANY (ARRAY['warehouse'::text, 'van'::text, 'site'::text]))),
    CONSTRAINT erp_stock_locations_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 100))),
    CONSTRAINT erp_stock_locations_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 2000))),
    CONSTRAINT erp_stock_locations_ownership_known CHECK ((ownership = ANY (ARRAY['ours'::text, 'customer'::text]))),
    CONSTRAINT erp_stock_locations_site_is_site CHECK (((site_id IS NOT NULL) = (kind = 'site'::text))),
    CONSTRAINT erp_stock_locations_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_stock_lot_balances (
    tenant_id uuid NOT NULL,
    lot_id uuid NOT NULL,
    location_id uuid NOT NULL,
    item_id uuid NOT NULL,
    on_hand numeric(20,4) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_stock_lot_balances_not_negative CHECK ((on_hand >= (0)::numeric))
);

CREATE TABLE erp_stock_lots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    item_id uuid NOT NULL,
    kind text NOT NULL,
    code text NOT NULL,
    expires_on date,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_stock_lots_code_present CHECK (((btrim(code) <> ''::text) AND (char_length(code) <= 100))),
    CONSTRAINT erp_stock_lots_expiry_batch_only CHECK (((kind = 'batch'::text) OR (expires_on IS NULL))),
    CONSTRAINT erp_stock_lots_kind_known CHECK ((kind = ANY (ARRAY['serial'::text, 'batch'::text])))
);

CREATE TABLE erp_stock_movements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    posting_id uuid NOT NULL,
    item_id uuid NOT NULL,
    location_id uuid NOT NULL,
    kind text NOT NULL,
    quantity numeric(20,4) NOT NULL,
    unit_cost numeric(20,4),
    source_key text NOT NULL,
    reason text,
    stock_count_id uuid,
    reversal_of uuid,
    actor_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    lot_id uuid,
    CONSTRAINT erp_stock_movements_cost_not_negative CHECK (((unit_cost IS NULL) OR (unit_cost >= (0)::numeric))),
    CONSTRAINT erp_stock_movements_count_kind CHECK (((stock_count_id IS NOT NULL) = (kind = 'count_adjustment'::text))),
    CONSTRAINT erp_stock_movements_kind_known CHECK ((kind = ANY (ARRAY['receipt'::text, 'issue'::text, 'transfer_out'::text, 'transfer_in'::text, 'adjustment'::text, 'count_adjustment'::text, 'consumption'::text, 'consumption_return'::text, 'return_to_supplier'::text, 'assembly_consumption'::text, 'assembly_output'::text]))),
    CONSTRAINT erp_stock_movements_quantity_signed CHECK (((quantity <> (0)::numeric) AND
CASE
    WHEN (kind = ANY (ARRAY['receipt'::text, 'transfer_in'::text, 'consumption_return'::text, 'assembly_output'::text])) THEN (quantity > (0)::numeric)
    WHEN (kind = ANY (ARRAY['issue'::text, 'transfer_out'::text, 'consumption'::text, 'return_to_supplier'::text, 'assembly_consumption'::text])) THEN (quantity < (0)::numeric)
    ELSE true
END)),
    CONSTRAINT erp_stock_movements_reason_length CHECK (((reason IS NULL) OR (char_length(reason) <= 1000))),
    CONSTRAINT erp_stock_movements_source_shape CHECK (((char_length(source_key) >= 1) AND (char_length(source_key) <= 200)))
);

CREATE TABLE erp_work_order_materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    item_id uuid NOT NULL,
    location_id uuid,
    quantity numeric(20,4) NOT NULL,
    returned_quantity numeric(20,4) DEFAULT 0 NOT NULL,
    unit_cost numeric(20,4),
    status text DEFAULT 'posted'::text NOT NULL,
    available_quantity numeric(20,4),
    client_action_id text,
    note text,
    recorded_by uuid NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    asset_id uuid,
    lots jsonb,
    recorded_after_close boolean DEFAULT false NOT NULL,
    CONSTRAINT erp_work_order_materials_cancelled_pairing CHECK ((((status = 'cancelled'::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)))),
    CONSTRAINT erp_work_order_materials_client_action_length CHECK (((client_action_id IS NULL) OR ((char_length(client_action_id) >= 1) AND (char_length(client_action_id) <= 100)))),
    CONSTRAINT erp_work_order_materials_conflict_shape CHECK (((status <> 'conflict'::text) OR (available_quantity IS NOT NULL))),
    CONSTRAINT erp_work_order_materials_lots_shape CHECK (((lots IS NULL) OR (jsonb_typeof(lots) = 'array'::text))),
    CONSTRAINT erp_work_order_materials_note_length CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT erp_work_order_materials_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT erp_work_order_materials_returned_range CHECK (((returned_quantity >= (0)::numeric) AND (returned_quantity <= quantity))),
    CONSTRAINT erp_work_order_materials_status_known CHECK ((status = ANY (ARRAY['posted'::text, 'conflict'::text, 'cancelled'::text]))),
    CONSTRAINT erp_work_order_materials_version_positive CHECK ((version > 0))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY erp_item_categories
    ADD CONSTRAINT erp_item_categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_item_categories
    ADD CONSTRAINT erp_item_categories_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_items
    ADD CONSTRAINT erp_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_items
    ADD CONSTRAINT erp_items_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_reorder_levels
    ADD CONSTRAINT erp_reorder_levels_pkey PRIMARY KEY (tenant_id, item_id, location_id);

ALTER TABLE ONLY erp_stock_balances
    ADD CONSTRAINT erp_stock_balances_pkey PRIMARY KEY (tenant_id, item_id, location_id);

-- Every company table has a primary key (P41): exports page by it.
ALTER TABLE ONLY erp_stock_count_lines
    ADD CONSTRAINT erp_stock_count_lines_pkey PRIMARY KEY (tenant_id, id);

ALTER TABLE ONLY erp_stock_count_lines
    ADD CONSTRAINT erp_stock_count_lines_unique UNIQUE NULLS NOT DISTINCT (tenant_id, count_id, item_id, lot_id, lot_code);

ALTER TABLE ONLY erp_stock_counts
    ADD CONSTRAINT erp_stock_counts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_stock_counts
    ADD CONSTRAINT erp_stock_counts_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_stock_locations
    ADD CONSTRAINT erp_stock_locations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_stock_locations
    ADD CONSTRAINT erp_stock_locations_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_stock_lot_balances
    ADD CONSTRAINT erp_stock_lot_balances_pkey PRIMARY KEY (tenant_id, lot_id, location_id);

ALTER TABLE ONLY erp_stock_lots
    ADD CONSTRAINT erp_stock_lots_code_unique UNIQUE (tenant_id, item_id, code);

ALTER TABLE ONLY erp_stock_lots
    ADD CONSTRAINT erp_stock_lots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_stock_lots
    ADD CONSTRAINT erp_stock_lots_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_source_unique UNIQUE (tenant_id, source_key);

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_work_order_materials
    ADD CONSTRAINT erp_work_order_materials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_work_order_materials
    ADD CONSTRAINT erp_work_order_materials_tenant_id_unique UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX erp_item_categories_name_unique ON erp_item_categories USING btree (tenant_id, lower(name));

CREATE UNIQUE INDEX erp_items_barcode_unique ON erp_items USING btree (tenant_id, barcode) WHERE (barcode IS NOT NULL);

CREATE INDEX erp_items_name_idx ON erp_items USING btree (tenant_id, lower(name), id);

CREATE INDEX erp_items_search_idx ON erp_items USING gin (search);

CREATE UNIQUE INDEX erp_items_sku_unique ON erp_items USING btree (tenant_id, lower(sku));

CREATE INDEX erp_stock_balances_location_idx ON erp_stock_balances USING btree (tenant_id, location_id);

CREATE INDEX erp_stock_counts_location_idx ON erp_stock_counts USING btree (tenant_id, location_id, created_at DESC);

CREATE UNIQUE INDEX erp_stock_locations_name_unique ON erp_stock_locations USING btree (tenant_id, lower(name));

CREATE UNIQUE INDEX erp_stock_locations_one_van_each ON erp_stock_locations USING btree (tenant_id, assigned_to) WHERE ((assigned_to IS NOT NULL) AND (archived_at IS NULL));

CREATE INDEX erp_stock_lot_balances_item_idx ON erp_stock_lot_balances USING btree (tenant_id, item_id, location_id) WHERE (on_hand > (0)::numeric);

CREATE INDEX erp_stock_lots_code_idx ON erp_stock_lots USING btree (tenant_id, lower(code));

CREATE INDEX erp_stock_movements_item_idx ON erp_stock_movements USING btree (tenant_id, item_id, occurred_at DESC, id);

CREATE INDEX erp_stock_movements_location_idx ON erp_stock_movements USING btree (tenant_id, location_id, occurred_at DESC, id);

CREATE INDEX erp_stock_movements_lot_idx ON erp_stock_movements USING btree (tenant_id, lot_id, occurred_at) WHERE (lot_id IS NOT NULL);

CREATE INDEX erp_stock_movements_posting_idx ON erp_stock_movements USING btree (tenant_id, posting_id);

CREATE INDEX erp_work_order_materials_asset_idx ON erp_work_order_materials USING btree (tenant_id, asset_id) WHERE (asset_id IS NOT NULL);

CREATE INDEX erp_work_order_materials_by_job ON erp_work_order_materials USING btree (tenant_id, work_order_id, recorded_at);

CREATE UNIQUE INDEX erp_work_order_materials_client_action_unique ON erp_work_order_materials USING btree (tenant_id, client_action_id) WHERE (client_action_id IS NOT NULL);

CREATE INDEX erp_work_order_materials_conflicts ON erp_work_order_materials USING btree (tenant_id, recorded_at) WHERE (status = 'conflict'::text);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id);

ALTER TABLE ONLY erp_item_categories
    ADD CONSTRAINT erp_item_categories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_items
    ADD CONSTRAINT erp_items_category_fk FOREIGN KEY (tenant_id, category_id) REFERENCES erp_item_categories(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_items
    ADD CONSTRAINT erp_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_reorder_levels
    ADD CONSTRAINT erp_reorder_levels_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_reorder_levels
    ADD CONSTRAINT erp_reorder_levels_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_reorder_levels
    ADD CONSTRAINT erp_reorder_levels_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_balances
    ADD CONSTRAINT erp_stock_balances_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_balances
    ADD CONSTRAINT erp_stock_balances_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_balances
    ADD CONSTRAINT erp_stock_balances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_count_lines
    ADD CONSTRAINT erp_stock_count_lines_count_fk FOREIGN KEY (tenant_id, count_id) REFERENCES erp_stock_counts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY erp_stock_count_lines
    ADD CONSTRAINT erp_stock_count_lines_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_count_lines
    ADD CONSTRAINT erp_stock_count_lines_lot_fk FOREIGN KEY (tenant_id, lot_id) REFERENCES erp_stock_lots(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_count_lines
    ADD CONSTRAINT erp_stock_count_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_counts
    ADD CONSTRAINT erp_stock_counts_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_counts
    ADD CONSTRAINT erp_stock_counts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_locations
    ADD CONSTRAINT erp_stock_locations_assignee_fk FOREIGN KEY (tenant_id, assigned_to) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_locations
    ADD CONSTRAINT erp_stock_locations_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_locations
    ADD CONSTRAINT erp_stock_locations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_lot_balances
    ADD CONSTRAINT erp_stock_lot_balances_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_lot_balances
    ADD CONSTRAINT erp_stock_lot_balances_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_lot_balances
    ADD CONSTRAINT erp_stock_lot_balances_lot_fk FOREIGN KEY (tenant_id, lot_id) REFERENCES erp_stock_lots(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_lot_balances
    ADD CONSTRAINT erp_stock_lot_balances_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_lots
    ADD CONSTRAINT erp_stock_lots_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_lots
    ADD CONSTRAINT erp_stock_lots_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_count_fk FOREIGN KEY (tenant_id, stock_count_id) REFERENCES erp_stock_counts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_lot_fk FOREIGN KEY (tenant_id, lot_id) REFERENCES erp_stock_lots(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_reversal_fk FOREIGN KEY (tenant_id, reversal_of) REFERENCES erp_stock_movements(tenant_id, id);

ALTER TABLE ONLY erp_stock_movements
    ADD CONSTRAINT erp_stock_movements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_materials
    ADD CONSTRAINT erp_work_order_materials_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_materials
    ADD CONSTRAINT erp_work_order_materials_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_materials
    ADD CONSTRAINT erp_work_order_materials_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_materials
    ADD CONSTRAINT erp_work_order_materials_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER erp_item_categories_set_updated_at BEFORE UPDATE ON erp_item_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_items_set_updated_at BEFORE UPDATE ON erp_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_stock_counts_set_updated_at BEFORE UPDATE ON erp_stock_counts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_stock_locations_set_updated_at BEFORE UPDATE ON erp_stock_locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_stock_movements_apply AFTER INSERT ON erp_stock_movements FOR EACH ROW EXECUTE FUNCTION erp_stock_apply_movement();

CREATE TRIGGER erp_stock_movements_apply_lot AFTER INSERT ON erp_stock_movements FOR EACH ROW EXECUTE FUNCTION erp_stock_apply_lot_movement();

CREATE CONSTRAINT TRIGGER erp_stock_movements_ledger_capture AFTER INSERT ON erp_stock_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION erp_stock_movements_ledger_capture();

CREATE TRIGGER erp_stock_movements_lot_check BEFORE INSERT ON erp_stock_movements FOR EACH ROW EXECUTE FUNCTION erp_stock_movements_lot_check();

CREATE TRIGGER erp_stock_movements_no_delete BEFORE DELETE OR UPDATE ON erp_stock_movements FOR EACH ROW EXECUTE FUNCTION erp_stock_movements_immutable();

CREATE TRIGGER erp_work_order_materials_job_guard BEFORE INSERT OR UPDATE ON erp_work_order_materials FOR EACH ROW EXECUTE FUNCTION guard_work_order_material_job();

CREATE TRIGGER erp_work_order_materials_touch_sync AFTER INSERT OR UPDATE ON erp_work_order_materials FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE erp_item_categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_reorder_levels ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_stock_balances ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_stock_count_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_stock_counts ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_stock_locations ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_stock_lot_balances ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_stock_lots ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_stock_movements ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_work_order_materials ENABLE ROW LEVEL SECURITY;

CREATE POLICY erp_item_categories_isolation ON erp_item_categories TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_items_isolation ON erp_items TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_reorder_levels_isolation ON erp_reorder_levels TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_stock_balances_isolation ON erp_stock_balances TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_stock_count_lines_isolation ON erp_stock_count_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_stock_counts_isolation ON erp_stock_counts TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_stock_locations_isolation ON erp_stock_locations TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_stock_lot_balances_isolation ON erp_stock_lot_balances TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_stock_lots_isolation ON erp_stock_lots TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_stock_movements_isolation ON erp_stock_movements TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_work_order_materials_isolation ON erp_work_order_materials TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION erp_ledger_capture(p_tenant uuid, p_kind text, p_source uuid, p_date date, p_currency text, p_actor uuid) IS 'Queues a document for the ledger and posts it when it can. Security definer: the runtime role cannot insert into the queue.';

COMMENT ON FUNCTION erp_ledger_proposal(p_tenant uuid, p_kind text, p_source uuid) IS 'The journal lines a document posts, in its own currency. The one definition the automatic posting, the unposted list and the API share.';

COMMENT ON FUNCTION erp_ledger_try_post(p_posting uuid, p_actor uuid, p_force boolean) IS 'Posts a captured document from its proposal, or records why it waits. Security definer: the runtime role cannot write the queue''s outcome itself.';

COMMENT ON FUNCTION guard_work_order_material_job() IS 'Refuses a part recorded on a cancelled job, and keeps recorded_after_close as written (0062).';

COMMENT ON TABLE erp_items IS 'The catalogue: stock items (counted in the ledger), non-stock items and services. Archived, never deleted.';

COMMENT ON TABLE erp_stock_balances IS 'How much of each item is at each location: the ledger''s projection, written only by its trigger.';

COMMENT ON COLUMN erp_stock_locations.ownership IS 'ours: counted and valued; customer: a record of what the customer holds at their site, never valued (ADR-0012).';

COMMENT ON TABLE erp_stock_lot_balances IS 'How much of each serial or batch is at each location: the ledger''s projection per lot, written only by its trigger.';

COMMENT ON TABLE erp_stock_lots IS 'Serial numbers and batches of tracked items (ADR-0013). Never changed or deleted.';

COMMENT ON TABLE erp_stock_movements IS 'The stock ledger. Append-only; balances are derived from it (erp_stock_balances is its projection).';

COMMENT ON COLUMN erp_work_order_materials.asset_id IS 'The asset the part was fitted to, if any; one of the job''s assets.';

COMMENT ON COLUMN erp_work_order_materials.recorded_after_close IS 'Recorded on a phone before its job closed and synced after (0062). Set when the row is written; never changes.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION erp_stock_lock_balance(p_tenant uuid, p_item uuid, p_location uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION erp_stock_lock_balance(p_tenant uuid, p_item uuid, p_location uuid) TO integr8_app;

REVOKE ALL ON FUNCTION erp_stock_lock_lot_balance(p_tenant uuid, p_lot uuid, p_location uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION erp_stock_lock_lot_balance(p_tenant uuid, p_lot uuid, p_location uuid) TO integr8_app;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_item_categories TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_item_categories TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_items TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_items TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_reorder_levels TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_reorder_levels TO integr8_platform;

GRANT SELECT ON TABLE erp_stock_balances TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_stock_balances TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_stock_count_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_stock_count_lines TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_stock_counts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_stock_counts TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_stock_locations TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_stock_locations TO integr8_platform;

GRANT SELECT ON TABLE erp_stock_lot_balances TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_stock_lot_balances TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_stock_lots TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_stock_lots TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_stock_movements TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_stock_movements TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_work_order_materials TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_work_order_materials TO integr8_platform;
