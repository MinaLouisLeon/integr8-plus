-- Invoices, credit notes, payments and their allocations.
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

CREATE FUNCTION public.assign_finance_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'UPDATE' and old.reference is not null then
    if new.reference is distinct from old.reference then
      raise exception 'A finance document keeps its number'
        using errcode = 'check_violation', constraint = 'finance_reference_fixed';
    end if;
    return new;
  end if;
  if tg_argv[0] <> 'payment' then
    if new.status = 'draft' then
      new.reference := null;
      return new;
    end if;
  end if;
  insert into public.finance_document_counters as counter (tenant_id, kind, last_reference)
  values (new.tenant_id, tg_argv[0], 1)
  on conflict (tenant_id, kind) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;

CREATE FUNCTION public.erp_credit_note_lines_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  note_status text;
begin
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
  select status into note_status
    from erp_credit_notes
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.credit_note_id, old.credit_note_id);
  if note_status is null or note_status = 'draft' then
    return coalesce(new, old);
  end if;
  raise exception 'An issued credit note''s lines do not change'
    using errcode = 'check_violation', constraint = 'erp_credit_note_lines_frozen';
end;
$$;

CREATE FUNCTION public.erp_credit_notes_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  invoice_status text;
  owed numeric;
  credit numeric;
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or integr8_purging(old.tenant_id) then
      return old;
    end if;
    raise exception 'An issued credit note is never deleted'
      using errcode = 'check_violation', constraint = 'erp_credit_notes_frozen';
  end if;
  if tg_op = 'UPDATE' and old.status = 'issued' then
    if (to_jsonb(new) - array['version', 'updated_at']) <> (to_jsonb(old) - array['version', 'updated_at']) then
      raise exception 'An issued credit note does not change'
        using errcode = 'check_violation', constraint = 'erp_credit_notes_frozen';
    end if;
    return new;
  end if;
  -- Locks the invoice: payments allocated to it wait, so the balance holds.
  select status into invoice_status
    from erp_invoices
   where tenant_id = new.tenant_id and id = new.invoice_id
   for update;
  if invoice_status <> 'issued' then
    raise exception 'A credit note is only for an issued invoice'
      using errcode = 'check_violation', constraint = 'erp_credit_notes_invoice_not_open';
  end if;
  if new.status = 'issued' then
    owed := erp_invoice_balance(new.tenant_id, new.invoice_id);
    credit := erp_credit_note_total(new.tenant_id, new.id);
    if credit <= 0 then
      raise exception 'A credit note needs at least one line'
        using errcode = 'check_violation', constraint = 'erp_credit_notes_empty';
    end if;
    if credit > owed then
      raise exception 'A credit note cannot take off more than the invoice still owes (% > %)', credit, owed
        using errcode = 'check_violation', constraint = 'erp_credit_notes_over_balance';
    end if;
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.erp_credit_notes_ledger_capture() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if old.status = 'draft' and new.status = 'issued' then
    perform erp_ledger_capture(
      new.tenant_id, 'credit_note', new.id, new.issue_date,
      (select i.currency_code from erp_invoices i where i.tenant_id = new.tenant_id and i.id = new.invoice_id),
      new.issued_by);
  end if;
  return null;
end;
$$;

CREATE FUNCTION public.erp_invoice_balance(p_tenant uuid, p_invoice uuid) RETURNS numeric
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select erp_invoice_total(p_tenant, p_invoice)
       - coalesce((select sum(a.amount) from erp_payment_allocations a
                    where a.tenant_id = p_tenant and a.invoice_id = p_invoice and a.removed_at is null), 0)
       - coalesce((select sum(erp_credit_note_total(c.tenant_id, c.id)) from erp_credit_notes c
                    where c.tenant_id = p_tenant and c.invoice_id = p_invoice and c.status = 'issued'), 0);
$$;

CREATE FUNCTION public.erp_invoice_lines_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  invoice_status text;
begin
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
  select status into invoice_status
    from erp_invoices
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.invoice_id, old.invoice_id);
  -- A draft's lines change freely; so do they while the draft itself is being discarded.
  if invoice_status is null or invoice_status = 'draft' then
    return coalesce(new, old);
  end if;
  raise exception 'An issued invoice''s lines do not change'
    using errcode = 'check_violation', constraint = 'erp_invoice_lines_frozen';
end;
$$;

CREATE FUNCTION public.erp_invoices_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  movable constant text[] := array['status', 'voided_by', 'voided_at', 'void_reason', 'version', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or integr8_purging(old.tenant_id) then
      return old;
    end if;
    raise exception 'An issued invoice is never deleted'
      using errcode = 'check_violation', constraint = 'erp_invoices_frozen';
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  if old.status = 'void'
     or new.status <> 'void'
     or (to_jsonb(new) - movable) <> (to_jsonb(old) - movable) then
    raise exception 'An issued invoice does not change; credit it or void it'
      using errcode = 'check_violation', constraint = 'erp_invoices_frozen';
  end if;
  if exists (select 1 from erp_payment_allocations a
              where a.tenant_id = old.tenant_id and a.invoice_id = old.id and a.removed_at is null)
     or exists (select 1 from erp_credit_notes c
                 where c.tenant_id = old.tenant_id and c.invoice_id = old.id and c.status = 'issued') then
    raise exception 'An invoice with a payment or a credit against it is not voided; credit it instead'
      using errcode = 'check_violation', constraint = 'erp_invoices_void_settled';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.erp_invoices_ledger_capture() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if old.status = 'draft' and new.status = 'issued' then
    perform erp_ledger_capture(new.tenant_id, 'invoice', new.id, new.issue_date, new.currency_code, new.issued_by);
  elsif old.status = 'issued' and new.status = 'void' then
    perform erp_ledger_capture(
      new.tenant_id, 'invoice_void', new.id,
      (new.voided_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      new.currency_code, new.voided_by);
  end if;
  return null;
end;
$$;

CREATE FUNCTION public.erp_ledger_backfill(p_tenant uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
     where m.tenant_id = p_tenant
       and m.kind not in ('transfer_out', 'transfer_in', 'assembly_consumption', 'assembly_output')
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

CREATE FUNCTION public.erp_payment_allocations_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.erp_payment_receipts_ledger_capture() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  perform erp_ledger_capture(
    new.tenant_id, 'payment', new.id, new.received_on, new.currency_code, new.recorded_by);
  return null;
end;
$$;

CREATE FUNCTION public.erp_payment_reversals_apply() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE erp_credit_note_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    credit_note_id uuid NOT NULL,
    "position" integer NOT NULL,
    invoice_line_id uuid,
    item_id uuid,
    description text NOT NULL,
    quantity numeric(20,4) NOT NULL,
    unit text DEFAULT 'each'::text NOT NULL,
    unit_price numeric(20,4) NOT NULL,
    discount_bp integer DEFAULT 0 NOT NULL,
    tax_rate_bp integer DEFAULT 0 NOT NULL,
    money_scale smallint DEFAULT 4 NOT NULL,
    CONSTRAINT erp_credit_note_lines_description_present CHECK (((btrim(description) <> ''::text) AND (char_length(description) <= 500))),
    CONSTRAINT erp_credit_note_lines_discount_range CHECK (((discount_bp >= 0) AND (discount_bp <= 10000))),
    CONSTRAINT erp_credit_note_lines_money_scale_range CHECK (((money_scale >= 0) AND (money_scale <= 4))),
    CONSTRAINT erp_credit_note_lines_price_not_negative CHECK ((unit_price >= (0)::numeric)),
    CONSTRAINT erp_credit_note_lines_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT erp_credit_note_lines_tax_range CHECK (((tax_rate_bp >= 0) AND (tax_rate_bp <= 10000))),
    CONSTRAINT erp_credit_note_lines_unit_known CHECK ((unit = ANY (ARRAY['each'::text, 'pair'::text, 'set'::text, 'box'::text, 'pack'::text, 'roll'::text, 'm'::text, 'm2'::text, 'm3'::text, 'l'::text, 'kg'::text, 'g'::text, 'hour'::text])))
);

CREATE TABLE erp_credit_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer,
    invoice_id uuid NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    reason text NOT NULL,
    issue_date date,
    issued_by uuid,
    issued_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_credit_notes_issued_pairing CHECK ((((status = 'draft'::text) = (reference IS NULL)) AND ((status = 'draft'::text) = (issued_at IS NULL)) AND ((issued_at IS NULL) = (issued_by IS NULL)) AND ((issued_at IS NULL) = (issue_date IS NULL)))),
    CONSTRAINT erp_credit_notes_reason_present CHECK (((btrim(reason) <> ''::text) AND (char_length(reason) <= 1000))),
    CONSTRAINT erp_credit_notes_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text]))),
    CONSTRAINT erp_credit_notes_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_finance_settings (
    tenant_id uuid NOT NULL,
    legal_name text,
    address text,
    tax_reference text,
    payment_instructions text,
    footer text,
    default_due_days integer DEFAULT 30 NOT NULL,
    labour_hourly_cost numeric(20,4),
    labour_hourly_rate numeric(20,4),
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_finance_settings_due_days_range CHECK (((default_due_days >= 0) AND (default_due_days <= 365))),
    CONSTRAINT erp_finance_settings_labour_not_negative CHECK ((((labour_hourly_cost IS NULL) OR (labour_hourly_cost >= (0)::numeric)) AND ((labour_hourly_rate IS NULL) OR (labour_hourly_rate >= (0)::numeric)))),
    CONSTRAINT erp_finance_settings_text_lengths CHECK ((((legal_name IS NULL) OR (char_length(legal_name) <= 200)) AND ((address IS NULL) OR (char_length(address) <= 1000)) AND ((tax_reference IS NULL) OR (char_length(tax_reference) <= 100)) AND ((payment_instructions IS NULL) OR (char_length(payment_instructions) <= 2000)) AND ((footer IS NULL) OR (char_length(footer) <= 2000)))),
    CONSTRAINT erp_finance_settings_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_invoice_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    "position" integer NOT NULL,
    item_id uuid,
    description text NOT NULL,
    quantity numeric(20,4) NOT NULL,
    unit text DEFAULT 'each'::text NOT NULL,
    unit_price numeric(20,4) NOT NULL,
    discount_bp integer DEFAULT 0 NOT NULL,
    tax_rate_bp integer DEFAULT 0 NOT NULL,
    sales_order_line_id uuid,
    work_order_material_id uuid,
    money_scale smallint DEFAULT 4 NOT NULL,
    CONSTRAINT erp_invoice_lines_description_present CHECK (((btrim(description) <> ''::text) AND (char_length(description) <= 500))),
    CONSTRAINT erp_invoice_lines_discount_range CHECK (((discount_bp >= 0) AND (discount_bp <= 10000))),
    CONSTRAINT erp_invoice_lines_money_scale_range CHECK (((money_scale >= 0) AND (money_scale <= 4))),
    CONSTRAINT erp_invoice_lines_price_not_negative CHECK ((unit_price >= (0)::numeric)),
    CONSTRAINT erp_invoice_lines_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT erp_invoice_lines_tax_range CHECK (((tax_rate_bp >= 0) AND (tax_rate_bp <= 10000))),
    CONSTRAINT erp_invoice_lines_unit_known CHECK ((unit = ANY (ARRAY['each'::text, 'pair'::text, 'set'::text, 'box'::text, 'pack'::text, 'roll'::text, 'm'::text, 'm2'::text, 'm3'::text, 'l'::text, 'kg'::text, 'g'::text, 'hour'::text])))
);

CREATE TABLE erp_invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer,
    customer_id uuid NOT NULL,
    site_id uuid,
    contact_id uuid,
    sales_order_id uuid,
    work_order_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    currency_code text NOT NULL,
    issue_date date,
    due_date date,
    notes text,
    internal_notes text,
    customer_name text,
    customer_address jsonb,
    contact_name text,
    contact_email text,
    issuer jsonb,
    issued_by uuid,
    issued_at timestamp with time zone,
    voided_by uuid,
    voided_at timestamp with time zone,
    void_reason text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_invoices_currency_shape CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT erp_invoices_dates_ordered CHECK (((due_date IS NULL) OR (issue_date IS NULL) OR (due_date >= issue_date))),
    CONSTRAINT erp_invoices_issued_pairing CHECK ((((status = 'draft'::text) = (reference IS NULL)) AND ((status = 'draft'::text) = (issued_at IS NULL)) AND ((issued_at IS NULL) = (issued_by IS NULL)) AND ((issued_at IS NULL) = (issue_date IS NULL)) AND ((issued_at IS NULL) = (customer_name IS NULL)) AND ((issued_at IS NULL) = (issuer IS NULL)))),
    CONSTRAINT erp_invoices_one_source CHECK (((sales_order_id IS NULL) OR (work_order_id IS NULL))),
    CONSTRAINT erp_invoices_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'void'::text]))),
    CONSTRAINT erp_invoices_text_lengths CHECK ((((notes IS NULL) OR (char_length(notes) <= 10000)) AND ((internal_notes IS NULL) OR (char_length(internal_notes) <= 10000)) AND ((void_reason IS NULL) OR (char_length(void_reason) <= 1000)))),
    CONSTRAINT erp_invoices_version_positive CHECK ((version > 0)),
    CONSTRAINT erp_invoices_void_pairing CHECK ((((status = 'void'::text) = (voided_at IS NOT NULL)) AND ((voided_at IS NULL) = (voided_by IS NULL)) AND ((voided_at IS NULL) = (void_reason IS NULL))))
);

CREATE TABLE erp_payment_allocations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    invoice_id uuid NOT NULL,
    amount numeric(20,4) NOT NULL,
    allocated_by uuid NOT NULL,
    allocated_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_by uuid,
    removed_at timestamp with time zone,
    CONSTRAINT erp_payment_allocations_amount_positive CHECK ((amount > (0)::numeric)),
    CONSTRAINT erp_payment_allocations_removed_pairing CHECK (((removed_at IS NULL) = (removed_by IS NULL)))
);

CREATE TABLE erp_payment_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer,
    customer_id uuid NOT NULL,
    received_on date NOT NULL,
    amount numeric(20,4) NOT NULL,
    currency_code text NOT NULL,
    method text NOT NULL,
    payment_reference text,
    notes text,
    recorded_by uuid NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_payment_receipts_amount_positive CHECK ((amount > (0)::numeric)),
    CONSTRAINT erp_payment_receipts_currency_shape CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT erp_payment_receipts_method_known CHECK ((method = ANY (ARRAY['cash'::text, 'bank_transfer'::text, 'other'::text]))),
    CONSTRAINT erp_payment_receipts_text_lengths CHECK ((((payment_reference IS NULL) OR (char_length(payment_reference) <= 200)) AND ((notes IS NULL) OR (char_length(notes) <= 2000))))
);

CREATE TABLE erp_payment_reversals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    reason text NOT NULL,
    reversed_on date NOT NULL,
    reversed_by uuid NOT NULL,
    reversed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_payment_reversals_reason_length CHECK (((char_length(btrim(reason)) >= 1) AND (char_length(btrim(reason)) <= 2000)))
);

CREATE TABLE finance_document_counters (
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    last_reference integer NOT NULL,
    CONSTRAINT finance_document_counters_kind_known CHECK ((kind = ANY (ARRAY['invoice'::text, 'credit_note'::text, 'payment'::text])))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY erp_credit_note_lines
    ADD CONSTRAINT erp_credit_note_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_credit_note_lines
    ADD CONSTRAINT erp_credit_note_lines_position_unique UNIQUE (tenant_id, credit_note_id, "position");

ALTER TABLE ONLY erp_credit_note_lines
    ADD CONSTRAINT erp_credit_note_lines_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_credit_notes
    ADD CONSTRAINT erp_credit_notes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_credit_notes
    ADD CONSTRAINT erp_credit_notes_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_credit_notes
    ADD CONSTRAINT erp_credit_notes_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_finance_settings
    ADD CONSTRAINT erp_finance_settings_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY erp_invoice_lines
    ADD CONSTRAINT erp_invoice_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_invoice_lines
    ADD CONSTRAINT erp_invoice_lines_position_unique UNIQUE (tenant_id, invoice_id, "position");

ALTER TABLE ONLY erp_invoice_lines
    ADD CONSTRAINT erp_invoice_lines_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_payment_allocations
    ADD CONSTRAINT erp_payment_allocations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_payment_allocations
    ADD CONSTRAINT erp_payment_allocations_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_payment_receipts
    ADD CONSTRAINT erp_payment_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_payment_receipts
    ADD CONSTRAINT erp_payment_receipts_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_payment_receipts
    ADD CONSTRAINT erp_payment_receipts_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_payment_reversals
    ADD CONSTRAINT erp_payment_reversals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_payment_reversals
    ADD CONSTRAINT erp_payment_reversals_receipt_unique UNIQUE (tenant_id, receipt_id);

ALTER TABLE ONLY erp_payment_reversals
    ADD CONSTRAINT erp_payment_reversals_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY finance_document_counters
    ADD CONSTRAINT finance_document_counters_pkey PRIMARY KEY (tenant_id, kind);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX erp_credit_note_lines_by_credit_note ON erp_credit_note_lines USING btree (tenant_id, credit_note_id, "position");

CREATE INDEX erp_credit_notes_by_invoice ON erp_credit_notes USING btree (tenant_id, invoice_id);

CREATE INDEX erp_credit_notes_by_status ON erp_credit_notes USING btree (tenant_id, status, created_at DESC);

CREATE INDEX erp_invoice_lines_by_invoice ON erp_invoice_lines USING btree (tenant_id, invoice_id, "position");

CREATE INDEX erp_invoice_lines_by_material ON erp_invoice_lines USING btree (tenant_id, work_order_material_id) WHERE (work_order_material_id IS NOT NULL);

CREATE INDEX erp_invoice_lines_by_order_line ON erp_invoice_lines USING btree (tenant_id, sales_order_line_id) WHERE (sales_order_line_id IS NOT NULL);

CREATE INDEX erp_invoices_by_customer ON erp_invoices USING btree (tenant_id, customer_id, created_at DESC);

CREATE INDEX erp_invoices_by_sales_order ON erp_invoices USING btree (tenant_id, sales_order_id) WHERE (sales_order_id IS NOT NULL);

CREATE INDEX erp_invoices_by_status ON erp_invoices USING btree (tenant_id, status, created_at DESC);

CREATE INDEX erp_invoices_by_work_order ON erp_invoices USING btree (tenant_id, work_order_id) WHERE (work_order_id IS NOT NULL);

CREATE INDEX erp_payment_allocations_by_invoice ON erp_payment_allocations USING btree (tenant_id, invoice_id) WHERE (removed_at IS NULL);

CREATE INDEX erp_payment_allocations_by_receipt ON erp_payment_allocations USING btree (tenant_id, receipt_id) WHERE (removed_at IS NULL);

CREATE INDEX erp_payment_receipts_by_customer ON erp_payment_receipts USING btree (tenant_id, customer_id, received_on DESC);

CREATE INDEX erp_payment_receipts_by_date ON erp_payment_receipts USING btree (tenant_id, received_on DESC, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp_invoices(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_credit_note_lines
    ADD CONSTRAINT erp_credit_note_lines_credit_note_fk FOREIGN KEY (tenant_id, credit_note_id) REFERENCES erp_credit_notes(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY erp_credit_note_lines
    ADD CONSTRAINT erp_credit_note_lines_invoice_line_fk FOREIGN KEY (tenant_id, invoice_line_id) REFERENCES erp_invoice_lines(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_credit_note_lines
    ADD CONSTRAINT erp_credit_note_lines_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_credit_note_lines
    ADD CONSTRAINT erp_credit_note_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_credit_notes
    ADD CONSTRAINT erp_credit_notes_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp_invoices(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_credit_notes
    ADD CONSTRAINT erp_credit_notes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_finance_settings
    ADD CONSTRAINT erp_finance_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoice_lines
    ADD CONSTRAINT erp_invoice_lines_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp_invoices(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY erp_invoice_lines
    ADD CONSTRAINT erp_invoice_lines_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoice_lines
    ADD CONSTRAINT erp_invoice_lines_material_fk FOREIGN KEY (tenant_id, work_order_material_id) REFERENCES erp_work_order_materials(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoice_lines
    ADD CONSTRAINT erp_invoice_lines_sales_order_line_fk FOREIGN KEY (tenant_id, sales_order_line_id) REFERENCES erp_sales_order_lines(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoice_lines
    ADD CONSTRAINT erp_invoice_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES customer_contacts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_sales_order_fk FOREIGN KEY (tenant_id, sales_order_id) REFERENCES erp_sales_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_invoices
    ADD CONSTRAINT erp_invoices_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_payment_allocations
    ADD CONSTRAINT erp_payment_allocations_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp_invoices(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_payment_allocations
    ADD CONSTRAINT erp_payment_allocations_receipt_fk FOREIGN KEY (tenant_id, receipt_id) REFERENCES erp_payment_receipts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_payment_allocations
    ADD CONSTRAINT erp_payment_allocations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_payment_receipts
    ADD CONSTRAINT erp_payment_receipts_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_payment_receipts
    ADD CONSTRAINT erp_payment_receipts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_payment_reversals
    ADD CONSTRAINT erp_payment_reversals_receipt_fk FOREIGN KEY (tenant_id, receipt_id) REFERENCES erp_payment_receipts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_payment_reversals
    ADD CONSTRAINT erp_payment_reversals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY finance_document_counters
    ADD CONSTRAINT finance_document_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER erp_credit_note_lines_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_credit_note_lines FOR EACH ROW EXECUTE FUNCTION erp_credit_note_lines_guard();

CREATE TRIGGER erp_credit_note_lines_money_scale BEFORE INSERT ON erp_credit_note_lines FOR EACH ROW EXECUTE FUNCTION erp_assign_line_scale();

CREATE TRIGGER erp_credit_notes_assign_reference BEFORE INSERT OR UPDATE ON erp_credit_notes FOR EACH ROW EXECUTE FUNCTION assign_finance_reference('credit_note');

CREATE TRIGGER erp_credit_notes_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_credit_notes FOR EACH ROW EXECUTE FUNCTION erp_credit_notes_guard();

CREATE TRIGGER erp_credit_notes_ledger_capture AFTER UPDATE OF status ON erp_credit_notes FOR EACH ROW EXECUTE FUNCTION erp_credit_notes_ledger_capture();

CREATE TRIGGER erp_credit_notes_set_updated_at BEFORE UPDATE ON erp_credit_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_finance_settings_set_updated_at BEFORE UPDATE ON erp_finance_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_invoice_lines_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_invoice_lines FOR EACH ROW EXECUTE FUNCTION erp_invoice_lines_guard();

CREATE TRIGGER erp_invoice_lines_money_scale BEFORE INSERT ON erp_invoice_lines FOR EACH ROW EXECUTE FUNCTION erp_assign_line_scale();

CREATE TRIGGER erp_invoices_assign_reference BEFORE INSERT OR UPDATE ON erp_invoices FOR EACH ROW EXECUTE FUNCTION assign_finance_reference('invoice');

CREATE TRIGGER erp_invoices_guard BEFORE DELETE OR UPDATE ON erp_invoices FOR EACH ROW EXECUTE FUNCTION erp_invoices_guard();

CREATE TRIGGER erp_invoices_ledger_capture AFTER UPDATE OF status ON erp_invoices FOR EACH ROW EXECUTE FUNCTION erp_invoices_ledger_capture();

CREATE TRIGGER erp_invoices_set_updated_at BEFORE UPDATE ON erp_invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_payment_allocations_guard BEFORE INSERT OR UPDATE ON erp_payment_allocations FOR EACH ROW EXECUTE FUNCTION erp_payment_allocations_guard();

CREATE TRIGGER erp_payment_receipts_assign_reference BEFORE INSERT ON erp_payment_receipts FOR EACH ROW EXECUTE FUNCTION assign_finance_reference('payment');

CREATE TRIGGER erp_payment_receipts_ledger_capture AFTER INSERT ON erp_payment_receipts FOR EACH ROW EXECUTE FUNCTION erp_payment_receipts_ledger_capture();

CREATE TRIGGER erp_payment_reversals_apply AFTER INSERT ON erp_payment_reversals FOR EACH ROW EXECUTE FUNCTION erp_payment_reversals_apply();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE erp_credit_note_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_credit_notes ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_finance_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_invoice_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_invoices ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_payment_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_payment_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_payment_reversals ENABLE ROW LEVEL SECURITY;

ALTER TABLE finance_document_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY erp_credit_note_lines_isolation ON erp_credit_note_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_credit_notes_isolation ON erp_credit_notes TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_finance_settings_isolation ON erp_finance_settings TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_invoice_lines_isolation ON erp_invoice_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_invoices_isolation ON erp_invoices TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_payment_allocations_isolation ON erp_payment_allocations TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_payment_receipts_isolation ON erp_payment_receipts TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_payment_reversals_isolation ON erp_payment_reversals TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY finance_document_counters_isolation ON finance_document_counters FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION assign_finance_reference() IS 'Numbers an invoice or credit note when issued and a payment when recorded; tg_argv[0] names which. Security definer: the runtime role cannot write the counter.';

COMMENT ON FUNCTION erp_ledger_backfill(p_tenant uuid) IS 'Queues documents recorded on or after the ledger''s start for review, and drops pending ones before it. Security definer: the runtime role cannot write the queue.';

COMMENT ON FUNCTION erp_payment_reversals_apply() IS 'Removes a reversed receipt''s allocations and queues the opposite ledger entry (0064).';

COMMENT ON TABLE erp_payment_reversals IS 'A payment receipt taken back, with why (0064). The receipt stays; its allocations are removed and the ledger posts the opposite entry. Insert-only.';

COMMENT ON TABLE finance_document_counters IS 'The last invoice, credit note and payment reference handed out per company. Written only by assign_finance_reference.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_credit_note_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_credit_note_lines TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_credit_notes TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_credit_notes TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_finance_settings TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_finance_settings TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_invoice_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_invoice_lines TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_invoices TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_invoices TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_payment_allocations TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_payment_allocations TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_payment_receipts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_payment_receipts TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_payment_reversals TO integr8_platform;
GRANT SELECT,INSERT ON TABLE erp_payment_reversals TO integr8_app;

GRANT SELECT ON TABLE finance_document_counters TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE finance_document_counters TO integr8_platform;
