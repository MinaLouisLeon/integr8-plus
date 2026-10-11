-- Reverses 0030. Drops every company invoice, credit note and payment
-- receipt; nothing else refers to them. Fine on a fresh or test database; on
-- a live one, take a backup or a company export first. Puts back the purge
-- and the 0029 line guards as they were.

drop table erp_payment_allocations;
drop function erp_payment_allocations_guard();
drop table erp_payment_receipts;
drop table erp_credit_note_lines;
drop function erp_credit_note_lines_guard();
drop table erp_credit_notes;
drop function erp_credit_notes_guard();
drop function erp_invoice_balance(uuid, uuid);
drop function erp_credit_note_total(uuid, uuid);
drop table erp_invoice_lines;
drop function erp_invoice_lines_guard();
drop table erp_invoices;
drop function erp_invoices_guard();
drop function erp_invoice_total(uuid, uuid);
drop function erp_line_total(numeric, numeric, integer, integer);
drop function assign_finance_reference();
drop table finance_document_counters;
drop table erp_finance_settings;

create or replace function crm_quote_lines_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  quote_status text;
begin
  select status into quote_status
    from crm_quotes
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.quote_id, old.quote_id);
  if quote_status = 'draft' then
    return coalesce(new, old);
  end if;
  raise exception 'An issued quote''s lines do not change'
    using errcode = 'check_violation', constraint = 'crm_quote_lines_frozen';
end;
$$;

create or replace function erp_sales_order_lines_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  order_status text;
begin
  select status into order_status
    from erp_sales_orders
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.order_id, old.order_id);
  if order_status = 'draft' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and new.order_id = old.order_id and new.position = old.position
     and new.item_id is not distinct from old.item_id
     and new.description = old.description and new.quantity = old.quantity and new.unit = old.unit
     and new.unit_price = old.unit_price and new.discount_bp = old.discount_bp
     and new.tax_rate_bp = old.tax_rate_bp then
    return new;
  end if;
  raise exception 'A confirmed sales order''s lines do not change'
    using errcode = 'check_violation', constraint = 'erp_sales_order_lines_frozen';
end;
$$;

create or replace function purge_tenant(p_tenant uuid) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  scheduled  uuid;
  remaining  text[];
  attempt    text[];
  progressed boolean;
  candidate  text;
  guard      text;
begin
  select d.id into scheduled
    from public.tenant_deletions d
   where d.tenant_id = p_tenant
     and d.cancelled_at is null
     and d.completed_at is null
     and d.purge_after <= now();

  if scheduled is null then
    raise exception 'tenant % is not scheduled for deletion, or its cooling-off has not passed', p_tenant
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Every table with a tenant_id foreign key to tenants, in `public` only.
  -- The schema predicates matter: the delete below names `public.%I`, so a
  -- table of the same name in another schema would either raise undefined_table
  -- and stop every purge for ever, or — worse — name a real public table that
  -- was never meant to be in the list.
  select array_agg(distinct child.relname::text)
    into remaining
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_attribute att on att.attrelid = child.oid and att.attnum = any (con.conkey)
   where con.contype = 'f'
     and parent.relname = 'tenants'
     and parent.relnamespace = 'public'::regnamespace
     and child.relnamespace = 'public'::regnamespace
     and att.attname = 'tenant_id';

  -- The append-only guards refuse delete for every role, the schema owner
  -- included. That is the point of them, and it makes this function the one
  -- place allowed to lift them: it has already checked that a deletion is
  -- scheduled and due, so a company's history goes only when the company does.
  -- `platform_audit_log` is deliberately not on this list — it has no tenant_id
  -- foreign key and outlives the company it describes.
  foreach guard in array array['audit_log', 'submission_events', 'work_order_events', 'erp_stock_movements'] loop
    execute format('alter table public.%I disable trigger %I', guard, guard || '_no_delete');
  end loop;

  while coalesce(array_length(remaining, 1), 0) > 0 loop
    progressed := false;
    attempt := remaining;
    foreach candidate in array attempt loop
      begin
        execute format('delete from public.%I where tenant_id = $1', candidate) using p_tenant;
        remaining := array_remove(remaining, candidate);
        progressed := true;
      exception
        when foreign_key_violation then
          -- A child of this table still holds rows. Another pass will reach it.
          null;
      end;
    end loop;

    if not progressed then
      raise exception 'could not purge tenant %: % still holds rows', p_tenant, remaining
        using errcode = 'foreign_key_violation';
    end if;
  end loop;

  delete from public.tenants where id = p_tenant;

  update public.tenant_deletions set completed_at = now() where id = scheduled;

  foreach guard in array array['audit_log', 'submission_events', 'work_order_events', 'erp_stock_movements'] loop
    execute format('alter table public.%I enable trigger %I', guard, guard || '_no_delete');
  end loop;
end;
$$;

drop function integr8_purging(uuid);

delete from feature_flags where key = 'finance';
