-- CRM/ERP plan, phase B1: a company's invoices, credit notes and payment
-- receipts, and the settings its invoices and job costs need (ADR-0004,
-- ADR-0007).
--
-- This is the company's own commercial ledger, apart from Integr8's
-- subscription billing (`subscriptions`, `billing_events`) and not a certified
-- tax document. An invoice is drafted, then issued — numbered, frozen, with
-- the customer and the company's issuer details copied onto it — and is never
-- edited afterwards: a credit note reduces it, and an invoice nothing was paid
-- against may be voided. A payment receipt is immutable and is allocated to
-- the customer's invoices, never beyond what it brought or what an invoice
-- still owes. Every amount is computed from lines in SQL.
--
-- Also: the purge of a company (0015, last redefined in 0026) now marks the
-- transaction it runs in, and the line guards of 0029 let that purge — and
-- only that purge — delete issued quote and order lines. Without it a company
-- with an issued quote could not be purged.

insert into feature_flags (key, description, default_enabled)
values
  ('finance',
   'Finance: the company''s own invoices, credit notes, payment receipts and job costs. Not Integr8''s billing. Off until Integr8 switches it on for a company.',
   false);

-- ---------------------------------------------------------------------------
-- The purge marker
-- ---------------------------------------------------------------------------

-- True only inside purge_tenant() for that company: the marker is set by the
-- purge itself, and the runtime role cannot pass for it even if it set the
-- same marker, because the purge runs as the schema owner.
create function integr8_purging(p_tenant uuid) returns boolean
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select current_setting('integr8.purging', true) = p_tenant::text
     and current_user <> 'integr8_app';
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
  -- Tells the document guards (0029, 0030) that this company is going: they
  -- refuse to delete issued lines and documents for anyone else.
  perform set_config('integr8.purging', p_tenant::text, true);

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

  perform set_config('integr8.purging', '', true);
end;
$$;

create or replace function crm_quote_lines_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  quote_status text;
begin
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
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
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
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

-- ---------------------------------------------------------------------------
-- Settings: who issues the invoice, and what an hour costs
-- ---------------------------------------------------------------------------

create table erp_finance_settings (
  tenant_id            uuid           primary key references tenants (id) on delete restrict,
  -- The issuer block printed on every invoice, copied onto it when issued.
  legal_name           text,
  address              text,
  tax_reference        text,
  payment_instructions text,
  footer               text,
  -- Days from issue to due unless an invoice says otherwise.
  default_due_days     integer        not null default 30,
  -- What an hour of a job costs the company (job profitability), and what it
  -- charges for one (the labour line of an invoice made from a job). Optional:
  -- without a cost, a job's cost is its parts only and says so.
  labour_hourly_cost   numeric(20,4),
  labour_hourly_rate   numeric(20,4),
  version              integer        not null default 1,
  updated_by           uuid,
  updated_at           timestamptz    not null default now(),
  constraint erp_finance_settings_due_days_range check (default_due_days between 0 and 365),
  constraint erp_finance_settings_labour_not_negative check (
    (labour_hourly_cost is null or labour_hourly_cost >= 0)
    and (labour_hourly_rate is null or labour_hourly_rate >= 0)),
  constraint erp_finance_settings_text_lengths check (
    (legal_name is null or char_length(legal_name) <= 200)
    and (address is null or char_length(address) <= 1000)
    and (tax_reference is null or char_length(tax_reference) <= 100)
    and (payment_instructions is null or char_length(payment_instructions) <= 2000)
    and (footer is null or char_length(footer) <= 2000)),
  constraint erp_finance_settings_version_positive check (version > 0)
);
create trigger erp_finance_settings_set_updated_at
  before update on erp_finance_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Document numbers
-- ---------------------------------------------------------------------------

create table finance_document_counters (
  tenant_id       uuid    not null references tenants (id) on delete restrict,
  kind            text    not null,
  last_reference  integer not null,
  constraint finance_document_counters_pkey primary key (tenant_id, kind),
  constraint finance_document_counters_kind_known check (kind in ('invoice', 'credit_note', 'payment'))
);
comment on table finance_document_counters is
  'The last invoice, credit note and payment reference handed out per company. Written only by assign_finance_reference.';

-- Invoices and credit notes are numbered when they are issued, so a discarded
-- draft never leaves a gap; a payment is numbered when it is recorded. Once a
-- document has its number, the number never changes.
create function assign_finance_reference() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
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
comment on function assign_finance_reference() is
  'Numbers an invoice or credit note when issued and a payment when recorded; tg_argv[0] names which. Security definer: the runtime role cannot write the counter.';

-- ---------------------------------------------------------------------------
-- Amounts, computed the one way everything else computes them (0029)
-- ---------------------------------------------------------------------------

-- A line's total: gross, less discount, plus tax, each rounded once to four places.
create function erp_line_total(quantity numeric, unit_price numeric, discount_bp integer, tax_rate_bp integer)
  returns numeric
  language sql
  immutable
  set search_path = pg_catalog, public
as $$
  select net + round(net * tax_rate_bp / 10000, 4)
    from (select round(gross - round(gross * discount_bp / 10000, 4), 4) as net
            from (select round(quantity * unit_price, 4) as gross) g) n;
$$;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

create table erp_invoices (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as INV-000123; given when issued.
  reference        integer,
  customer_id      uuid        not null,
  site_id          uuid,
  contact_id       uuid,
  -- Where the lines came from, if anywhere: one order or one job.
  sales_order_id   uuid,
  work_order_id    uuid,
  status           text        not null default 'draft',
  currency_code    text        not null,
  -- In the company's calendar.
  issue_date       date,
  due_date         date,
  -- Printed for the customer; internal notes never are.
  notes            text,
  internal_notes   text,
  -- Frozen when issued: the customer as billed, and the company as issuer.
  customer_name    text,
  customer_address jsonb,
  contact_name     text,
  contact_email    text,
  issuer           jsonb,
  issued_by        uuid,
  issued_at        timestamptz,
  voided_by        uuid,
  voided_at        timestamptz,
  void_reason      text,
  version          integer     not null default 1,
  created_by       uuid        not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint erp_invoices_tenant_id_unique unique (tenant_id, id),
  constraint erp_invoices_reference_unique unique (tenant_id, reference),
  constraint erp_invoices_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint erp_invoices_site_fk
    foreign key (tenant_id, site_id) references sites (tenant_id, id) on delete restrict,
  constraint erp_invoices_contact_fk
    foreign key (tenant_id, contact_id) references customer_contacts (tenant_id, id) on delete restrict,
  constraint erp_invoices_sales_order_fk
    foreign key (tenant_id, sales_order_id) references erp_sales_orders (tenant_id, id) on delete restrict,
  constraint erp_invoices_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint erp_invoices_status_known check (status in ('draft', 'issued', 'void')),
  constraint erp_invoices_one_source check (sales_order_id is null or work_order_id is null),
  constraint erp_invoices_currency_shape check (currency_code ~ '^[A-Z]{3}$'),
  constraint erp_invoices_dates_ordered check (due_date is null or issue_date is null or due_date >= issue_date),
  constraint erp_invoices_text_lengths check (
    (notes is null or char_length(notes) <= 10000)
    and (internal_notes is null or char_length(internal_notes) <= 10000)
    and (void_reason is null or char_length(void_reason) <= 1000)),
  constraint erp_invoices_issued_pairing check (
    (status = 'draft') = (reference is null)
    and (status = 'draft') = (issued_at is null)
    and (issued_at is null) = (issued_by is null)
    and (issued_at is null) = (issue_date is null)
    and (issued_at is null) = (customer_name is null)
    and (issued_at is null) = (issuer is null)),
  constraint erp_invoices_void_pairing check (
    (status = 'void') = (voided_at is not null)
    and (voided_at is null) = (voided_by is null)
    and (voided_at is null) = (void_reason is null)),
  constraint erp_invoices_version_positive check (version > 0)
);
create index erp_invoices_by_status on erp_invoices (tenant_id, status, created_at desc);
create index erp_invoices_by_customer on erp_invoices (tenant_id, customer_id, created_at desc);
create index erp_invoices_by_sales_order on erp_invoices (tenant_id, sales_order_id) where sales_order_id is not null;
create index erp_invoices_by_work_order on erp_invoices (tenant_id, work_order_id) where work_order_id is not null;

create trigger erp_invoices_assign_reference
  before insert or update on erp_invoices
  for each row execute function assign_finance_reference('invoice');
create trigger erp_invoices_set_updated_at
  before update on erp_invoices
  for each row execute function set_updated_at();

create table erp_invoice_lines (
  id                     uuid           primary key default gen_random_uuid(),
  tenant_id              uuid           not null references tenants (id) on delete restrict,
  invoice_id             uuid           not null,
  position               integer        not null,
  item_id                uuid,
  description            text           not null,
  quantity               numeric(20,4)  not null,
  unit                   text           not null default 'each',
  unit_price             numeric(20,4)  not null,
  discount_bp            integer        not null default 0,
  tax_rate_bp            integer        not null default 0,
  -- What the line bills, when it came from an order or a job: nothing is
  -- billed twice (counted across every invoice that is not void).
  sales_order_line_id    uuid,
  work_order_material_id uuid,
  constraint erp_invoice_lines_tenant_id_unique unique (tenant_id, id),
  constraint erp_invoice_lines_position_unique unique (tenant_id, invoice_id, position),
  constraint erp_invoice_lines_invoice_fk
    foreign key (tenant_id, invoice_id) references erp_invoices (tenant_id, id) on delete cascade,
  constraint erp_invoice_lines_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_invoice_lines_sales_order_line_fk
    foreign key (tenant_id, sales_order_line_id) references erp_sales_order_lines (tenant_id, id) on delete restrict,
  constraint erp_invoice_lines_material_fk
    foreign key (tenant_id, work_order_material_id) references erp_work_order_materials (tenant_id, id) on delete restrict,
  constraint erp_invoice_lines_description_present
    check (btrim(description) <> '' and char_length(description) <= 500),
  constraint erp_invoice_lines_quantity_positive check (quantity > 0),
  constraint erp_invoice_lines_unit_known
    check (unit in ('each', 'pair', 'set', 'box', 'pack', 'roll', 'm', 'm2', 'm3', 'l', 'kg', 'g', 'hour')),
  constraint erp_invoice_lines_price_not_negative check (unit_price >= 0),
  constraint erp_invoice_lines_discount_range check (discount_bp between 0 and 10000),
  constraint erp_invoice_lines_tax_range check (tax_rate_bp between 0 and 10000)
);
create index erp_invoice_lines_by_invoice on erp_invoice_lines (tenant_id, invoice_id, position);
create index erp_invoice_lines_by_order_line
  on erp_invoice_lines (tenant_id, sales_order_line_id) where sales_order_line_id is not null;
create index erp_invoice_lines_by_material
  on erp_invoice_lines (tenant_id, work_order_material_id) where work_order_material_id is not null;

-- What an invoice adds up to.
create function erp_invoice_total(p_tenant uuid, p_invoice uuid) returns numeric
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(sum(erp_line_total(l.quantity, l.unit_price, l.discount_bp, l.tax_rate_bp)), 0)
    from erp_invoice_lines l
   where l.tenant_id = p_tenant and l.invoice_id = p_invoice;
$$;

-- ---------------------------------------------------------------------------
-- Credit notes
-- ---------------------------------------------------------------------------

create table erp_credit_notes (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as CN-000123; given when issued.
  reference   integer,
  invoice_id  uuid        not null,
  status      text        not null default 'draft',
  -- Printed: why the invoice is reduced.
  reason      text        not null,
  issue_date  date,
  issued_by   uuid,
  issued_at   timestamptz,
  version     integer     not null default 1,
  created_by  uuid        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint erp_credit_notes_tenant_id_unique unique (tenant_id, id),
  constraint erp_credit_notes_reference_unique unique (tenant_id, reference),
  constraint erp_credit_notes_invoice_fk
    foreign key (tenant_id, invoice_id) references erp_invoices (tenant_id, id) on delete restrict,
  constraint erp_credit_notes_status_known check (status in ('draft', 'issued')),
  constraint erp_credit_notes_reason_present check (btrim(reason) <> '' and char_length(reason) <= 1000),
  constraint erp_credit_notes_issued_pairing check (
    (status = 'draft') = (reference is null)
    and (status = 'draft') = (issued_at is null)
    and (issued_at is null) = (issued_by is null)
    and (issued_at is null) = (issue_date is null)),
  constraint erp_credit_notes_version_positive check (version > 0)
);
create index erp_credit_notes_by_invoice on erp_credit_notes (tenant_id, invoice_id);
create index erp_credit_notes_by_status on erp_credit_notes (tenant_id, status, created_at desc);

create trigger erp_credit_notes_assign_reference
  before insert or update on erp_credit_notes
  for each row execute function assign_finance_reference('credit_note');
create trigger erp_credit_notes_set_updated_at
  before update on erp_credit_notes
  for each row execute function set_updated_at();

create table erp_credit_note_lines (
  id               uuid           primary key default gen_random_uuid(),
  tenant_id        uuid           not null references tenants (id) on delete restrict,
  credit_note_id   uuid           not null,
  position         integer        not null,
  -- The invoice line this credits, when it credits one.
  invoice_line_id  uuid,
  item_id          uuid,
  description      text           not null,
  quantity         numeric(20,4)  not null,
  unit             text           not null default 'each',
  unit_price       numeric(20,4)  not null,
  discount_bp      integer        not null default 0,
  tax_rate_bp      integer        not null default 0,
  constraint erp_credit_note_lines_tenant_id_unique unique (tenant_id, id),
  constraint erp_credit_note_lines_position_unique unique (tenant_id, credit_note_id, position),
  constraint erp_credit_note_lines_credit_note_fk
    foreign key (tenant_id, credit_note_id) references erp_credit_notes (tenant_id, id) on delete cascade,
  constraint erp_credit_note_lines_invoice_line_fk
    foreign key (tenant_id, invoice_line_id) references erp_invoice_lines (tenant_id, id) on delete restrict,
  constraint erp_credit_note_lines_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_credit_note_lines_description_present
    check (btrim(description) <> '' and char_length(description) <= 500),
  constraint erp_credit_note_lines_quantity_positive check (quantity > 0),
  constraint erp_credit_note_lines_unit_known
    check (unit in ('each', 'pair', 'set', 'box', 'pack', 'roll', 'm', 'm2', 'm3', 'l', 'kg', 'g', 'hour')),
  constraint erp_credit_note_lines_price_not_negative check (unit_price >= 0),
  constraint erp_credit_note_lines_discount_range check (discount_bp between 0 and 10000),
  constraint erp_credit_note_lines_tax_range check (tax_rate_bp between 0 and 10000)
);
create index erp_credit_note_lines_by_credit_note on erp_credit_note_lines (tenant_id, credit_note_id, position);

create function erp_credit_note_total(p_tenant uuid, p_credit_note uuid) returns numeric
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(sum(erp_line_total(l.quantity, l.unit_price, l.discount_bp, l.tax_rate_bp)), 0)
    from erp_credit_note_lines l
   where l.tenant_id = p_tenant and l.credit_note_id = p_credit_note;
$$;

-- ---------------------------------------------------------------------------
-- Payment receipts and allocations
-- ---------------------------------------------------------------------------

create table erp_payment_receipts (
  id                uuid           primary key default gen_random_uuid(),
  tenant_id         uuid           not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as RC-000123; given when recorded.
  reference         integer,
  customer_id       uuid           not null,
  received_on       date           not null,
  amount            numeric(20,4)  not null,
  currency_code     text           not null,
  method            text           not null,
  -- The bank's or the customer's reference for it, if any.
  payment_reference text,
  notes             text,
  recorded_by       uuid           not null,
  recorded_at       timestamptz    not null default now(),
  constraint erp_payment_receipts_tenant_id_unique unique (tenant_id, id),
  constraint erp_payment_receipts_reference_unique unique (tenant_id, reference),
  constraint erp_payment_receipts_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint erp_payment_receipts_amount_positive check (amount > 0),
  constraint erp_payment_receipts_currency_shape check (currency_code ~ '^[A-Z]{3}$'),
  constraint erp_payment_receipts_method_known check (method in ('cash', 'bank_transfer', 'other')),
  constraint erp_payment_receipts_text_lengths check (
    (payment_reference is null or char_length(payment_reference) <= 200)
    and (notes is null or char_length(notes) <= 2000))
);
create index erp_payment_receipts_by_customer on erp_payment_receipts (tenant_id, customer_id, received_on desc);
create index erp_payment_receipts_by_date on erp_payment_receipts (tenant_id, received_on desc, recorded_at desc);

create trigger erp_payment_receipts_assign_reference
  before insert on erp_payment_receipts
  for each row execute function assign_finance_reference('payment');

create table erp_payment_allocations (
  id            uuid           primary key default gen_random_uuid(),
  tenant_id     uuid           not null references tenants (id) on delete restrict,
  receipt_id    uuid           not null,
  invoice_id    uuid           not null,
  amount        numeric(20,4)  not null,
  allocated_by  uuid           not null,
  allocated_at  timestamptz    not null default now(),
  -- A wrong allocation is removed, not edited or deleted: the history stays.
  removed_by    uuid,
  removed_at    timestamptz,
  constraint erp_payment_allocations_tenant_id_unique unique (tenant_id, id),
  constraint erp_payment_allocations_receipt_fk
    foreign key (tenant_id, receipt_id) references erp_payment_receipts (tenant_id, id) on delete restrict,
  constraint erp_payment_allocations_invoice_fk
    foreign key (tenant_id, invoice_id) references erp_invoices (tenant_id, id) on delete restrict,
  constraint erp_payment_allocations_amount_positive check (amount > 0),
  constraint erp_payment_allocations_removed_pairing check ((removed_at is null) = (removed_by is null))
);
create index erp_payment_allocations_by_receipt
  on erp_payment_allocations (tenant_id, receipt_id) where removed_at is null;
create index erp_payment_allocations_by_invoice
  on erp_payment_allocations (tenant_id, invoice_id) where removed_at is null;

-- What an issued invoice still owes: its total, less what payments were
-- allocated to it and what issued credit notes took off.
create function erp_invoice_balance(p_tenant uuid, p_invoice uuid) returns numeric
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select erp_invoice_total(p_tenant, p_invoice)
       - coalesce((select sum(a.amount) from erp_payment_allocations a
                    where a.tenant_id = p_tenant and a.invoice_id = p_invoice and a.removed_at is null), 0)
       - coalesce((select sum(erp_credit_note_total(c.tenant_id, c.id)) from erp_credit_notes c
                    where c.tenant_id = p_tenant and c.invoice_id = p_invoice and c.status = 'issued'), 0);
$$;

-- ---------------------------------------------------------------------------
-- Guards: what the database keeps true whatever the application does
-- ---------------------------------------------------------------------------

-- A draft changes freely and may be discarded. Once issued, an invoice is
-- frozen: the only change is issued → void, with who, when and why, and only
-- while nothing has been paid or credited against it. A void invoice never
-- changes again.
create function erp_invoices_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
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
create trigger erp_invoices_guard
  before update or delete on erp_invoices
  for each row execute function erp_invoices_guard();

create function erp_invoice_lines_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
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
create trigger erp_invoice_lines_guard
  before insert or update or delete on erp_invoice_lines
  for each row execute function erp_invoice_lines_guard();

-- A credit note is issued against an issued invoice, for no more than the
-- invoice still owes; once issued it never changes and is never deleted.
create function erp_credit_notes_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
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
create trigger erp_credit_notes_guard
  before insert or update or delete on erp_credit_notes
  for each row execute function erp_credit_notes_guard();

create function erp_credit_note_lines_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
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
create trigger erp_credit_note_lines_guard
  before insert or update or delete on erp_credit_note_lines
  for each row execute function erp_credit_note_lines_guard();

-- An allocation puts part of a receipt against one of the same customer's
-- issued invoices in the same currency, never more than the receipt has left
-- nor more than the invoice still owes. Both rows are locked while it is
-- decided, so two allocations cannot both spend the same money. Removing an
-- allocation is the only change it allows. Security definer: the runtime
-- role may read receipts but never lock or change them.
create function erp_payment_allocations_guard() returns trigger
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
create trigger erp_payment_allocations_guard
  before insert or update on erp_payment_allocations
  for each row execute function erp_payment_allocations_guard();

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

grant select, insert, update on erp_finance_settings to integr8_app;
grant select on finance_document_counters to integr8_app;
grant select, insert, update, delete on erp_invoices to integr8_app;
grant select, insert, update, delete on erp_invoice_lines to integr8_app;
grant select, insert, update, delete on erp_credit_notes to integr8_app;
grant select, insert, update, delete on erp_credit_note_lines to integr8_app;
-- A receipt is recorded and then only read.
grant select, insert on erp_payment_receipts to integr8_app;
grant select, insert, update on erp_payment_allocations to integr8_app;

alter table erp_finance_settings enable row level security;
create policy erp_finance_settings_isolation on erp_finance_settings
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table finance_document_counters enable row level security;
create policy finance_document_counters_isolation on finance_document_counters
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table erp_invoices enable row level security;
create policy erp_invoices_isolation on erp_invoices
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_invoice_lines enable row level security;
create policy erp_invoice_lines_isolation on erp_invoice_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_credit_notes enable row level security;
create policy erp_credit_notes_isolation on erp_credit_notes
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_credit_note_lines enable row level security;
create policy erp_credit_note_lines_isolation on erp_credit_note_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_payment_receipts enable row level security;
create policy erp_payment_receipts_isolation on erp_payment_receipts
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_payment_allocations enable row level security;
create policy erp_payment_allocations_isolation on erp_payment_allocations
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
