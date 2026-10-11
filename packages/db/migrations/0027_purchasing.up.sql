-- 0027 — suppliers, purchase orders and goods receipts (CRM/ERP plan, phase E2).
--
--   * erp_suppliers: who the company buys from. Its own directory, separate from
--     customers (PLAN.md ERP-03): no shared "party" table yet.
--
--   * erp_purchase_orders and erp_purchase_order_lines: what was ordered, at
--     what price, with an optional tax rate per line in basis points. An order
--     is drafted by a dispatcher and approved by an owner or admin before
--     anything can be received against it (product decision, 2026-10-11).
--     Lines are edited only while the order is a draft; afterwards only
--     `quantity_received` moves, as goods arrive. Totals are derived, never
--     stored. References are PO-000123, from a counter the runtime role cannot
--     write, like work orders.
--
--   * erp_goods_receipts and erp_goods_receipt_lines: what arrived, when, and
--     where it was put. Each receipt line posts one `receipt` movement to the
--     ledger (0026), once, and folds its price into the item's average cost.
--     A return to the supplier posts a `return_to_supplier` movement against
--     the receipt line and frees that quantity on the order line.
--
-- Vocabularies match @integr8/core (inventory.ts); the schema-invariant suite
-- compares them.

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

create table erp_suppliers (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete restrict,
  name            text        not null,
  contact_name    text,
  email           text,
  phone           text,
  tax_reference   text,
  payment_terms   text,
  lead_time_days  integer,
  address_line1   text,
  address_line2   text,
  city            text,
  region          text,
  postcode        text,
  country_code    text,
  status          text        not null default 'active',
  notes           text,
  version         integer     not null default 1,
  created_by      uuid        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  search          tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(name, '') || ' ' || coalesce(contact_name, '') || ' ' ||
      coalesce(email, '') || ' ' || coalesce(phone, ''))
  ) stored,

  constraint erp_suppliers_tenant_id_unique unique (tenant_id, id),
  constraint erp_suppliers_name_present check (btrim(name) <> '' and char_length(name) <= 200),
  constraint erp_suppliers_status_known check (status in ('active', 'inactive')),
  constraint erp_suppliers_lead_time_sane
    check (lead_time_days is null or lead_time_days between 0 and 3650),
  constraint erp_suppliers_country_shape
    check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint erp_suppliers_notes_length check (notes is null or char_length(notes) <= 10000),
  constraint erp_suppliers_version_positive check (version > 0)
);
create unique index erp_suppliers_name_unique on erp_suppliers (tenant_id, lower(name));
create index erp_suppliers_search_idx on erp_suppliers using gin (search);
create trigger erp_suppliers_set_updated_at
  before update on erp_suppliers
  for each row execute function set_updated_at();

-- An item's usual supplier and their part number, for drafting orders.
alter table erp_items
  add column preferred_supplier_id uuid,
  add column supplier_part_number text,
  add constraint erp_items_supplier_fk
    foreign key (tenant_id, preferred_supplier_id) references erp_suppliers (tenant_id, id) on delete restrict,
  add constraint erp_items_supplier_part_number_length
    check (supplier_part_number is null or char_length(supplier_part_number) <= 100);

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------

create table erp_purchase_order_counters (
  tenant_id       uuid    primary key references tenants (id) on delete restrict,
  last_reference  integer not null
);
comment on table erp_purchase_order_counters is
  'The last purchase order reference handed out per company. Written only by assign_purchase_order_reference.';

create table erp_purchase_orders (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as PO-000123. Assigned by trigger.
  reference             integer     not null default 0,
  supplier_id           uuid        not null,
  -- As it was when the order was approved, so a renamed supplier does not rewrite history.
  supplier_name         text        not null,
  status                text        not null default 'draft',
  currency_code         text        not null,
  expected_date         date,
  -- Where goods are expected to be put; a receipt may name another location.
  delivery_location_id  uuid,
  notes                 text,
  approved_by           uuid,
  approved_at           timestamptz,
  cancelled_by          uuid,
  cancelled_at          timestamptz,
  cancel_reason         text,
  version               integer     not null default 1,
  created_by            uuid        not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint erp_purchase_orders_tenant_id_unique unique (tenant_id, id),
  constraint erp_purchase_orders_reference_unique unique (tenant_id, reference),
  constraint erp_purchase_orders_supplier_fk
    foreign key (tenant_id, supplier_id) references erp_suppliers (tenant_id, id) on delete restrict,
  constraint erp_purchase_orders_location_fk
    foreign key (tenant_id, delivery_location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_purchase_orders_status_known
    check (status in ('draft', 'approved', 'partially_received', 'received', 'cancelled')),
  constraint erp_purchase_orders_currency_shape check (currency_code ~ '^[A-Z]{3}$'),
  constraint erp_purchase_orders_supplier_name_present check (btrim(supplier_name) <> ''),
  constraint erp_purchase_orders_notes_length check (notes is null or char_length(notes) <= 10000),
  constraint erp_purchase_orders_cancel_reason_length
    check (cancel_reason is null or char_length(cancel_reason) <= 1000),
  -- Approved exactly when it says who and when; the same for cancelled.
  constraint erp_purchase_orders_approved_pairing check (
    (status in ('approved', 'partially_received', 'received')) = (approved_at is not null)
    and (approved_at is null) = (approved_by is null)),
  constraint erp_purchase_orders_cancelled_pairing check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is null) = (cancelled_by is null)),
  constraint erp_purchase_orders_version_positive check (version > 0)
);
comment on table erp_purchase_orders is
  'What the company ordered from a supplier. Drafted, approved by an owner or admin, then received against. Totals are derived from the lines.';

create index erp_purchase_orders_list_idx on erp_purchase_orders (tenant_id, created_at desc, id);
create index erp_purchase_orders_supplier_idx on erp_purchase_orders (tenant_id, supplier_id, status);
create index erp_purchase_orders_status_idx on erp_purchase_orders (tenant_id, status);
create trigger erp_purchase_orders_set_updated_at
  before update on erp_purchase_orders
  for each row execute function set_updated_at();

create function assign_purchase_order_reference() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  insert into public.erp_purchase_order_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;
comment on function assign_purchase_order_reference() is
  'Gives a new purchase order the next reference for its company. Security definer: the runtime role cannot write the counter.';

create trigger erp_purchase_orders_assign_reference
  before insert on erp_purchase_orders
  for each row execute function assign_purchase_order_reference();

create table erp_purchase_order_lines (
  id                 uuid           primary key default gen_random_uuid(),
  tenant_id          uuid           not null references tenants (id) on delete restrict,
  order_id           uuid           not null,
  position           integer        not null,
  item_id            uuid           not null,
  -- The item's name as ordered.
  description        text           not null,
  quantity_ordered   numeric(20, 4) not null,
  quantity_received  numeric(20, 4) not null default 0,
  -- One unit, before tax, in the order's currency.
  unit_price         numeric(20, 4) not null,
  -- Basis points: 1400 is 14 %.
  tax_rate_bp        integer        not null default 0,

  constraint erp_purchase_order_lines_tenant_id_unique unique (tenant_id, id),
  constraint erp_purchase_order_lines_position_unique unique (tenant_id, order_id, position),
  constraint erp_purchase_order_lines_order_fk
    foreign key (tenant_id, order_id) references erp_purchase_orders (tenant_id, id) on delete cascade,
  constraint erp_purchase_order_lines_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_purchase_order_lines_description_present
    check (btrim(description) <> '' and char_length(description) <= 500),
  constraint erp_purchase_order_lines_ordered_positive check (quantity_ordered > 0),
  -- Never more received than ordered (product decision: no over-receipt).
  constraint erp_purchase_order_lines_received_range
    check (quantity_received >= 0 and quantity_received <= quantity_ordered),
  constraint erp_purchase_order_lines_price_not_negative check (unit_price >= 0),
  constraint erp_purchase_order_lines_tax_range check (tax_rate_bp between 0 and 10000)
);
create index erp_purchase_order_lines_order_idx on erp_purchase_order_lines (tenant_id, order_id, position);

-- Lines change only while the order is a draft; afterwards only what has
-- been received moves, and that only as receipts and returns are posted.
create function erp_purchase_order_lines_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  order_status text;
begin
  select status into order_status
    from erp_purchase_orders
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.order_id, old.order_id);
  if order_status = 'draft' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and new.order_id = old.order_id and new.position = old.position and new.item_id = old.item_id
     and new.description = old.description and new.quantity_ordered = old.quantity_ordered
     and new.unit_price = old.unit_price and new.tax_rate_bp = old.tax_rate_bp then
    return new;
  end if;
  raise exception 'An approved purchase order''s lines do not change'
    using errcode = 'check_violation', constraint = 'erp_purchase_order_lines_frozen';
end;
$$;

create trigger erp_purchase_order_lines_guard
  before insert or update or delete on erp_purchase_order_lines
  for each row execute function erp_purchase_order_lines_guard();

-- ---------------------------------------------------------------------------
-- Goods receipts
-- ---------------------------------------------------------------------------

create table erp_goods_receipts (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  order_id       uuid        not null,
  location_id    uuid        not null,
  -- The supplier's delivery note or invoice number, if any.
  supplier_note  text,
  notes          text,
  received_by    uuid        not null,
  received_at    timestamptz not null default now(),

  constraint erp_goods_receipts_tenant_id_unique unique (tenant_id, id),
  constraint erp_goods_receipts_order_fk
    foreign key (tenant_id, order_id) references erp_purchase_orders (tenant_id, id) on delete restrict,
  constraint erp_goods_receipts_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_goods_receipts_supplier_note_length
    check (supplier_note is null or char_length(supplier_note) <= 200),
  constraint erp_goods_receipts_notes_length check (notes is null or char_length(notes) <= 2000)
);
create index erp_goods_receipts_order_idx on erp_goods_receipts (tenant_id, order_id, received_at desc);

create table erp_goods_receipt_lines (
  id                 uuid           primary key default gen_random_uuid(),
  tenant_id          uuid           not null references tenants (id) on delete restrict,
  receipt_id         uuid           not null,
  order_line_id      uuid           not null,
  quantity           numeric(20, 4) not null,
  -- What was paid for one unit: the order line's price when it was received.
  unit_cost          numeric(20, 4) not null,
  -- Sent back to the supplier since, out of `quantity`.
  returned_quantity  numeric(20, 4) not null default 0,

  constraint erp_goods_receipt_lines_tenant_id_unique unique (tenant_id, id),
  constraint erp_goods_receipt_lines_receipt_fk
    foreign key (tenant_id, receipt_id) references erp_goods_receipts (tenant_id, id) on delete restrict,
  constraint erp_goods_receipt_lines_order_line_fk
    foreign key (tenant_id, order_line_id) references erp_purchase_order_lines (tenant_id, id) on delete restrict,
  constraint erp_goods_receipt_lines_quantity_positive check (quantity > 0),
  constraint erp_goods_receipt_lines_cost_not_negative check (unit_cost >= 0),
  constraint erp_goods_receipt_lines_returned_range
    check (returned_quantity >= 0 and returned_quantity <= quantity)
);
create index erp_goods_receipt_lines_receipt_idx on erp_goods_receipt_lines (tenant_id, receipt_id);
create index erp_goods_receipt_lines_order_line_idx on erp_goods_receipt_lines (tenant_id, order_line_id);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

grant select, insert, update on erp_suppliers, erp_purchase_orders to integr8_app;
-- Draft lines are replaced wholesale; the guard refuses it once approved.
grant select, insert, update, delete on erp_purchase_order_lines to integr8_app;
-- Receipts are history: written, and their returned quantity kept up to date.
grant select, insert on erp_goods_receipts to integr8_app;
grant select, insert, update on erp_goods_receipt_lines to integr8_app;

alter table erp_suppliers enable row level security;
create policy erp_suppliers_isolation on erp_suppliers
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- The counter is reached only through assign_purchase_order_reference.
alter table erp_purchase_order_counters enable row level security;
create policy erp_purchase_order_counters_isolation on erp_purchase_order_counters
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table erp_purchase_orders enable row level security;
create policy erp_purchase_orders_isolation on erp_purchase_orders
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_purchase_order_lines enable row level security;
create policy erp_purchase_order_lines_isolation on erp_purchase_order_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_goods_receipts enable row level security;
create policy erp_goods_receipts_isolation on erp_goods_receipts
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_goods_receipt_lines enable row level security;
create policy erp_goods_receipt_lines_isolation on erp_goods_receipt_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
