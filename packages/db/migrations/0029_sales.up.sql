-- CRM/ERP plan, phase S1: quotes and sales orders (ADR-0006).
--
-- A quote is drafted, issued (frozen: what the customer saw), answered by
-- the customer — through the office or a signed link — and converted into a
-- sales order exactly once. A confirmed order reserves stock per line at a
-- location and is fulfilled through the jobs linked to it. Lines carry a
-- discount and a tax rate in basis points; every total is computed from the
-- lines in SQL and never typed.

insert into feature_flags (key, description, default_enabled)
values
  ('sales',
   'Sales: quotes with customer acceptance, sales orders with stock reservations, linked to jobs. Off until Integr8 switches it on for a company.',
   false);

-- ---------------------------------------------------------------------------
-- Document numbers
-- ---------------------------------------------------------------------------

create table sales_document_counters (
  tenant_id       uuid    not null references tenants (id) on delete restrict,
  kind            text    not null,
  last_reference  integer not null,
  constraint sales_document_counters_pkey primary key (tenant_id, kind),
  constraint sales_document_counters_kind_known check (kind in ('quote', 'sales_order'))
);
comment on table sales_document_counters is
  'The last quote and sales order reference handed out per company. Written only by assign_sales_reference.';

create function assign_sales_reference() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  insert into public.sales_document_counters as counter (tenant_id, kind, last_reference)
  values (new.tenant_id, tg_argv[0], 1)
  on conflict (tenant_id, kind) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;
comment on function assign_sales_reference() is
  'Gives a new quote or sales order the next reference for its company; tg_argv[0] names which. Security definer: the runtime role cannot write the counter.';

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

create table crm_quotes (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as QT-000123; a revision as QT-000123-R2.
  reference          integer     not null default 0,
  revision           integer     not null default 1,
  customer_id        uuid        not null,
  site_id            uuid,
  contact_id         uuid,
  opportunity_id     uuid,
  status             text        not null default 'draft',
  title              text        not null,
  currency_code      text        not null,
  -- The last day the customer may accept, in the company's calendar.
  valid_until        date,
  -- Shown to the customer above and below the lines.
  introduction       text,
  terms              text,
  -- Never shown to the customer.
  internal_notes     text,
  -- Frozen when issued: the customer as the quote named them.
  customer_name      text,
  customer_address   jsonb,
  contact_name       text,
  contact_email      text,
  contact_phone      text,
  issued_by          uuid,
  issued_at          timestamptz,
  -- SHA-256 of the link token, while a link is live (ADR-0006).
  access_token_hash  text,
  -- The customer's answer, however it arrived.
  answered_at        timestamptz,
  answered_by        uuid,
  answered_via       text,
  answered_name      text,
  answered_from      text,
  rejection_reason   text,
  converted_order_id uuid,
  converted_at       timestamptz,
  cancelled_by       uuid,
  cancelled_at       timestamptz,
  cancel_reason      text,
  version            integer     not null default 1,
  created_by         uuid        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint crm_quotes_tenant_id_unique unique (tenant_id, id),
  constraint crm_quotes_reference_unique unique (tenant_id, reference),
  constraint crm_quotes_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint crm_quotes_site_fk
    foreign key (tenant_id, site_id) references sites (tenant_id, id) on delete restrict,
  constraint crm_quotes_contact_fk
    foreign key (tenant_id, contact_id) references customer_contacts (tenant_id, id) on delete restrict,
  constraint crm_quotes_opportunity_fk
    foreign key (tenant_id, opportunity_id) references crm_opportunities (tenant_id, id) on delete restrict,
  constraint crm_quotes_status_known
    check (status in ('draft', 'issued', 'accepted', 'rejected', 'converted', 'cancelled')),
  constraint crm_quotes_answered_via_known
    check (answered_via is null or answered_via in ('office', 'link')),
  constraint crm_quotes_revision_positive check (revision > 0),
  constraint crm_quotes_title_present check (btrim(title) <> '' and char_length(title) <= 200),
  constraint crm_quotes_currency_shape check (currency_code ~ '^[A-Z]{3}$'),
  constraint crm_quotes_text_lengths check (
    (introduction is null or char_length(introduction) <= 4000)
    and (terms is null or char_length(terms) <= 10000)
    and (internal_notes is null or char_length(internal_notes) <= 10000)
    and (rejection_reason is null or char_length(rejection_reason) <= 1000)
    and (cancel_reason is null or char_length(cancel_reason) <= 1000)),
  -- A draft has not been issued; everything else has.
  constraint crm_quotes_issued_pairing check (
    (status in ('draft', 'cancelled') or issued_at is not null)
    and (status <> 'draft' or issued_at is null)
    and (issued_at is null) = (issued_by is null)
    and (issued_at is null) = (customer_name is null)),
  constraint crm_quotes_answered_pairing check (
    (status not in ('accepted', 'rejected', 'converted') or answered_at is not null)
    and (answered_at is null) = (answered_via is null)),
  constraint crm_quotes_converted_pairing check (
    (status = 'converted') = (converted_order_id is not null)
    and (converted_order_id is null) = (converted_at is null)),
  constraint crm_quotes_cancelled_pairing check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is null) = (cancelled_by is null)),
  constraint crm_quotes_version_positive check (version > 0)
);
create index crm_quotes_by_status on crm_quotes (tenant_id, status, created_at desc);
create index crm_quotes_by_customer on crm_quotes (tenant_id, customer_id, created_at desc);
create index crm_quotes_by_opportunity on crm_quotes (tenant_id, opportunity_id) where opportunity_id is not null;
-- A link token names one quote, in any company.
create unique index crm_quotes_token_unique on crm_quotes (access_token_hash) where access_token_hash is not null;

create trigger crm_quotes_assign_reference
  before insert on crm_quotes
  for each row execute function assign_sales_reference('quote');
create trigger crm_quotes_set_updated_at
  before update on crm_quotes
  for each row execute function set_updated_at();

create table crm_quote_lines (
  id            uuid           primary key default gen_random_uuid(),
  tenant_id     uuid           not null references tenants (id) on delete restrict,
  quote_id      uuid           not null,
  position      integer        not null,
  -- A catalogue item, or null for a line written by hand.
  item_id       uuid,
  description   text           not null,
  quantity      numeric(20,4)  not null,
  unit          text           not null default 'each',
  unit_price    numeric(20,4)  not null,
  discount_bp   integer        not null default 0,
  tax_rate_bp   integer        not null default 0,
  constraint crm_quote_lines_tenant_id_unique unique (tenant_id, id),
  constraint crm_quote_lines_position_unique unique (tenant_id, quote_id, position),
  constraint crm_quote_lines_quote_fk
    foreign key (tenant_id, quote_id) references crm_quotes (tenant_id, id) on delete cascade,
  constraint crm_quote_lines_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint crm_quote_lines_description_present
    check (btrim(description) <> '' and char_length(description) <= 500),
  constraint crm_quote_lines_quantity_positive check (quantity > 0),
  constraint crm_quote_lines_unit_known
    check (unit in ('each', 'pair', 'set', 'box', 'pack', 'roll', 'm', 'm2', 'm3', 'l', 'kg', 'g', 'hour')),
  constraint crm_quote_lines_price_not_negative check (unit_price >= 0),
  constraint crm_quote_lines_discount_range check (discount_bp between 0 and 10000),
  constraint crm_quote_lines_tax_range check (tax_rate_bp between 0 and 10000)
);
create index crm_quote_lines_by_quote on crm_quote_lines (tenant_id, quote_id, position);

-- A quote's lines change only while it is a draft: what the customer saw stays.
create function crm_quote_lines_guard() returns trigger
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
create trigger crm_quote_lines_guard
  before insert or update or delete on crm_quote_lines
  for each row execute function crm_quote_lines_guard();

-- ---------------------------------------------------------------------------
-- Sales orders
-- ---------------------------------------------------------------------------

create table erp_sales_orders (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as SO-000123.
  reference           integer     not null default 0,
  -- The quote this came from, if any: one order per quote, ever.
  quote_id            uuid,
  customer_id         uuid        not null,
  site_id             uuid,
  contact_id          uuid,
  status              text        not null default 'draft',
  title               text        not null,
  currency_code       text        not null,
  notes               text,
  internal_notes      text,
  -- Where stock lines are reserved unless a line says otherwise.
  reserve_location_id uuid,
  -- Frozen when confirmed.
  customer_name       text,
  customer_address    jsonb,
  confirmed_by        uuid,
  confirmed_at        timestamptz,
  fulfilled_at        timestamptz,
  cancelled_by        uuid,
  cancelled_at        timestamptz,
  cancel_reason       text,
  version             integer     not null default 1,
  created_by          uuid        not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint erp_sales_orders_tenant_id_unique unique (tenant_id, id),
  constraint erp_sales_orders_reference_unique unique (tenant_id, reference),
  constraint erp_sales_orders_quote_unique unique (tenant_id, quote_id),
  constraint erp_sales_orders_quote_fk
    foreign key (tenant_id, quote_id) references crm_quotes (tenant_id, id) on delete restrict,
  constraint erp_sales_orders_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint erp_sales_orders_site_fk
    foreign key (tenant_id, site_id) references sites (tenant_id, id) on delete restrict,
  constraint erp_sales_orders_contact_fk
    foreign key (tenant_id, contact_id) references customer_contacts (tenant_id, id) on delete restrict,
  constraint erp_sales_orders_location_fk
    foreign key (tenant_id, reserve_location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_sales_orders_status_known
    check (status in ('draft', 'confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled')),
  constraint erp_sales_orders_title_present check (btrim(title) <> '' and char_length(title) <= 200),
  constraint erp_sales_orders_currency_shape check (currency_code ~ '^[A-Z]{3}$'),
  constraint erp_sales_orders_text_lengths check (
    (notes is null or char_length(notes) <= 10000)
    and (internal_notes is null or char_length(internal_notes) <= 10000)
    and (cancel_reason is null or char_length(cancel_reason) <= 1000)),
  constraint erp_sales_orders_confirmed_pairing check (
    (status in ('draft', 'cancelled') or confirmed_at is not null)
    and (status <> 'draft' or confirmed_at is null)
    and (confirmed_at is null) = (confirmed_by is null)
    and (confirmed_at is null) = (customer_name is null)),
  constraint erp_sales_orders_fulfilled_pairing check ((status = 'fulfilled') = (fulfilled_at is not null)),
  constraint erp_sales_orders_cancelled_pairing check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is null) = (cancelled_by is null)),
  constraint erp_sales_orders_version_positive check (version > 0)
);
create index erp_sales_orders_by_status on erp_sales_orders (tenant_id, status, created_at desc);
create index erp_sales_orders_by_customer on erp_sales_orders (tenant_id, customer_id, created_at desc);

create trigger erp_sales_orders_assign_reference
  before insert on erp_sales_orders
  for each row execute function assign_sales_reference('sales_order');
create trigger erp_sales_orders_set_updated_at
  before update on erp_sales_orders
  for each row execute function set_updated_at();

alter table crm_quotes
  add constraint crm_quotes_converted_order_fk
    foreign key (tenant_id, converted_order_id) references erp_sales_orders (tenant_id, id) on delete restrict;

create table erp_sales_order_lines (
  id                  uuid           primary key default gen_random_uuid(),
  tenant_id           uuid           not null references tenants (id) on delete restrict,
  order_id            uuid           not null,
  position            integer        not null,
  item_id             uuid,
  description         text           not null,
  quantity            numeric(20,4)  not null,
  unit                text           not null default 'each',
  unit_price          numeric(20,4)  not null,
  discount_bp         integer        not null default 0,
  tax_rate_bp         integer        not null default 0,
  -- Reserved at `reserve_location_id` while the order is open (ADR-0006).
  quantity_reserved   numeric(20,4)  not null default 0,
  reserve_location_id uuid,
  -- Delivered: parts used on linked jobs, or the job that did the service signed off.
  quantity_fulfilled  numeric(20,4)  not null default 0,
  constraint erp_sales_order_lines_tenant_id_unique unique (tenant_id, id),
  constraint erp_sales_order_lines_position_unique unique (tenant_id, order_id, position),
  constraint erp_sales_order_lines_order_fk
    foreign key (tenant_id, order_id) references erp_sales_orders (tenant_id, id) on delete cascade,
  constraint erp_sales_order_lines_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_sales_order_lines_location_fk
    foreign key (tenant_id, reserve_location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_sales_order_lines_description_present
    check (btrim(description) <> '' and char_length(description) <= 500),
  constraint erp_sales_order_lines_quantity_positive check (quantity > 0),
  constraint erp_sales_order_lines_unit_known
    check (unit in ('each', 'pair', 'set', 'box', 'pack', 'roll', 'm', 'm2', 'm3', 'l', 'kg', 'g', 'hour')),
  constraint erp_sales_order_lines_price_not_negative check (unit_price >= 0),
  constraint erp_sales_order_lines_discount_range check (discount_bp between 0 and 10000),
  constraint erp_sales_order_lines_tax_range check (tax_rate_bp between 0 and 10000),
  constraint erp_sales_order_lines_reserved_range
    check (quantity_reserved >= 0 and quantity_reserved <= quantity),
  constraint erp_sales_order_lines_reserved_placed
    check (quantity_reserved = 0 or reserve_location_id is not null),
  constraint erp_sales_order_lines_fulfilled_range
    check (quantity_fulfilled >= 0 and quantity_fulfilled <= quantity)
);
create index erp_sales_order_lines_by_order on erp_sales_order_lines (tenant_id, order_id, position);
-- What is reserved where: read for every balance shown.
create index erp_sales_order_lines_reserved
  on erp_sales_order_lines (tenant_id, item_id, reserve_location_id)
  where quantity_reserved > 0;

-- Lines change only while the order is a draft; afterwards only what is
-- reserved and fulfilled moves.
create function erp_sales_order_lines_guard() returns trigger
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
create trigger erp_sales_order_lines_guard
  before insert or update or delete on erp_sales_order_lines
  for each row execute function erp_sales_order_lines_guard();

-- The jobs that deliver an order: zero or many, linked or created on purpose.
create table erp_sales_order_work_orders (
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  order_id       uuid        not null,
  work_order_id  uuid        not null,
  linked_by      uuid        not null,
  linked_at      timestamptz not null default now(),
  constraint erp_sales_order_work_orders_pkey primary key (tenant_id, order_id, work_order_id),
  constraint erp_sales_order_work_orders_order_fk
    foreign key (tenant_id, order_id) references erp_sales_orders (tenant_id, id) on delete cascade,
  constraint erp_sales_order_work_orders_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict
);
create index erp_sales_order_work_orders_by_job on erp_sales_order_work_orders (tenant_id, work_order_id);

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

grant select on sales_document_counters to integr8_app;
grant select, insert, update on crm_quotes to integr8_app;
grant select, insert, update, delete on crm_quote_lines to integr8_app;
grant select, insert, update on erp_sales_orders to integr8_app;
grant select, insert, update, delete on erp_sales_order_lines to integr8_app;
grant select, insert, delete on erp_sales_order_work_orders to integr8_app;

alter table sales_document_counters enable row level security;
create policy sales_document_counters_isolation on sales_document_counters
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table crm_quotes enable row level security;
create policy crm_quotes_isolation on crm_quotes
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table crm_quote_lines enable row level security;
create policy crm_quote_lines_isolation on crm_quote_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_sales_orders enable row level security;
create policy erp_sales_orders_isolation on erp_sales_orders
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_sales_order_lines enable row level security;
create policy erp_sales_order_lines_isolation on erp_sales_order_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_sales_order_work_orders enable row level security;
create policy erp_sales_order_work_orders_isolation on erp_sales_order_work_orders
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
