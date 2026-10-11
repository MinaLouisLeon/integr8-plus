-- 0026 — the catalogue and the stock ledger (CRM/ERP plan, phase E1).
--
--   * Two module switches, both off: `inventory` and `purchasing` (E2 uses the
--     second). Integr8 staff turn them on per company.
--
--   * erp_item_categories and erp_items: what a company stocks, buys, uses and
--     sells. Units are a fixed list (UNITS in @integr8/core). Each stock item
--     carries one weighted average unit cost for the company, changed only by a
--     goods receipt (E2) or a priced manual receipt.
--
--   * erp_stock_locations: warehouses, vans and customer sites. A van is
--     assigned to at most one engineer, and an engineer has at most one van.
--
--   * erp_stock_movements: the ledger. Append-only: corrections are new
--     movements. Each carries a `source_key` unique per company, so a retried
--     posting is refused rather than counted twice (ADR-0003).
--
--   * erp_stock_balances: how much of each item is at each location — a
--     projection the ledger's trigger maintains, never written by the
--     application. `on_hand >= 0` is a constraint: stock never goes negative,
--     and the trigger's upsert takes the row lock that makes concurrent issues
--     of the same item from the same place run one after the other.
--
--   * erp_reorder_levels, erp_stock_counts and erp_stock_count_lines.
--
-- Vocabularies match @integr8/core (inventory.ts); the schema-invariant suite
-- compares them.

insert into feature_flags (key, description, default_enabled)
values
  ('inventory',
   'Inventory: catalogue, stock locations and vans, the stock ledger, parts used on jobs. Off until Integr8 switches it on for a company.',
   false),
  ('purchasing',
   'Purchasing: suppliers, purchase orders with approval, goods receipts. Off until Integr8 switches it on for a company.',
   false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The catalogue
-- ---------------------------------------------------------------------------

create table erp_item_categories (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete restrict,
  name        text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,

  constraint erp_item_categories_tenant_id_unique unique (tenant_id, id),
  constraint erp_item_categories_name_present
    check (btrim(name) <> '' and char_length(name) <= 100)
);
create unique index erp_item_categories_name_unique on erp_item_categories (tenant_id, lower(name));
create trigger erp_item_categories_set_updated_at
  before update on erp_item_categories
  for each row execute function set_updated_at();

create table erp_items (
  id                 uuid           primary key default gen_random_uuid(),
  tenant_id          uuid           not null references tenants (id) on delete restrict,
  sku                text           not null,
  name               text           not null,
  description        text,
  kind               text           not null default 'stock_item',
  category_id        uuid,
  unit               text           not null default 'each',
  barcode            text,
  -- Suggestions; documents snapshot their own prices.
  default_unit_cost  numeric(20, 4),
  sale_price         numeric(20, 4),
  -- The company's weighted average cost of one unit, in its currency.
  average_unit_cost  numeric(20, 4) not null default 0,
  version            integer        not null default 1,
  created_by         uuid           not null,
  created_at         timestamptz    not null default now(),
  updated_at         timestamptz    not null default now(),
  archived_at        timestamptz,
  search             tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(sku, '') || ' ' || coalesce(name, '') || ' ' ||
      coalesce(barcode, '') || ' ' || coalesce(description, ''))
  ) stored,

  constraint erp_items_tenant_id_unique unique (tenant_id, id),
  constraint erp_items_category_fk
    foreign key (tenant_id, category_id) references erp_item_categories (tenant_id, id) on delete restrict,
  constraint erp_items_sku_shape check (btrim(sku) <> '' and char_length(sku) <= 64),
  constraint erp_items_name_present check (btrim(name) <> '' and char_length(name) <= 200),
  constraint erp_items_description_length check (description is null or char_length(description) <= 10000),
  constraint erp_items_barcode_shape check (barcode is null or (btrim(barcode) <> '' and char_length(barcode) <= 64)),
  constraint erp_items_kind_known check (kind in ('stock_item', 'non_stock_item', 'service')),
  constraint erp_items_unit_known
    check (unit in ('each', 'pair', 'set', 'box', 'pack', 'roll', 'm', 'm2', 'm3', 'l', 'kg', 'g', 'hour')),
  constraint erp_items_costs_not_negative
    check ((default_unit_cost is null or default_unit_cost >= 0)
       and (sale_price is null or sale_price >= 0)
       and average_unit_cost >= 0),
  constraint erp_items_version_positive check (version > 0)
);
comment on table erp_items is
  'The catalogue: stock items (counted in the ledger), non-stock items and services. Archived, never deleted.';

create unique index erp_items_sku_unique on erp_items (tenant_id, lower(sku));
create unique index erp_items_barcode_unique on erp_items (tenant_id, barcode) where barcode is not null;
create index erp_items_name_idx on erp_items (tenant_id, lower(name), id);
create index erp_items_search_idx on erp_items using gin (search);
create trigger erp_items_set_updated_at
  before update on erp_items
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------

create table erp_stock_locations (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  name         text        not null,
  kind         text        not null,
  -- A van's engineer. Only vans have one.
  assigned_to  uuid,
  -- A site location's customer site. Only site locations have one.
  site_id      uuid,
  notes        text,
  version      integer     not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz,

  constraint erp_stock_locations_tenant_id_unique unique (tenant_id, id),
  constraint erp_stock_locations_assignee_fk
    foreign key (tenant_id, assigned_to) references tenant_users (tenant_id, user_id) on delete restrict,
  constraint erp_stock_locations_site_fk
    foreign key (tenant_id, site_id) references sites (tenant_id, id) on delete restrict,
  constraint erp_stock_locations_name_present check (btrim(name) <> '' and char_length(name) <= 100),
  constraint erp_stock_locations_notes_length check (notes is null or char_length(notes) <= 2000),
  constraint erp_stock_locations_kind_known check (kind in ('warehouse', 'van', 'site')),
  constraint erp_stock_locations_assignee_is_van check (assigned_to is null or kind = 'van'),
  constraint erp_stock_locations_site_is_site check ((site_id is not null) = (kind = 'site')),
  constraint erp_stock_locations_version_positive check (version > 0)
);
create unique index erp_stock_locations_name_unique on erp_stock_locations (tenant_id, lower(name));
-- One van per engineer, so "the van assigned to me" means one place.
create unique index erp_stock_locations_one_van_each on erp_stock_locations (tenant_id, assigned_to)
  where assigned_to is not null and archived_at is null;
create trigger erp_stock_locations_set_updated_at
  before update on erp_stock_locations
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Stock counts (referenced by the ledger)
-- ---------------------------------------------------------------------------

create table erp_stock_counts (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  location_id  uuid        not null,
  status       text        not null default 'draft',
  notes        text,
  version      integer     not null default 1,
  created_by   uuid        not null,
  posted_by    uuid,
  posted_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint erp_stock_counts_tenant_id_unique unique (tenant_id, id),
  constraint erp_stock_counts_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_stock_counts_status_known check (status in ('draft', 'posted', 'cancelled')),
  constraint erp_stock_counts_posted_pairing
    check ((status = 'posted') = (posted_at is not null and posted_by is not null)),
  constraint erp_stock_counts_notes_length check (notes is null or char_length(notes) <= 2000),
  constraint erp_stock_counts_version_positive check (version > 0)
);
create index erp_stock_counts_location_idx on erp_stock_counts (tenant_id, location_id, created_at desc);
create trigger erp_stock_counts_set_updated_at
  before update on erp_stock_counts
  for each row execute function set_updated_at();

create table erp_stock_count_lines (
  tenant_id         uuid           not null references tenants (id) on delete restrict,
  count_id          uuid           not null,
  item_id           uuid           not null,
  counted_quantity  numeric(20, 4) not null,
  -- What the system held when the count was posted; the variance is the difference.
  expected_quantity numeric(20, 4),

  primary key (tenant_id, count_id, item_id),
  constraint erp_stock_count_lines_count_fk
    foreign key (tenant_id, count_id) references erp_stock_counts (tenant_id, id) on delete cascade,
  constraint erp_stock_count_lines_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_stock_count_lines_counted_not_negative check (counted_quantity >= 0)
);

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create table erp_stock_movements (
  id              uuid           primary key default gen_random_uuid(),
  tenant_id       uuid           not null references tenants (id) on delete restrict,
  -- Movements written together (a transfer's two halves, a count's variances).
  posting_id      uuid           not null,
  item_id         uuid           not null,
  location_id     uuid           not null,
  kind            text           not null,
  -- Signed: positive adds stock at the location, negative takes it away.
  quantity        numeric(20, 4) not null,
  -- The cost of one unit when it moved, in the company currency. Seen by those who move stock.
  unit_cost       numeric(20, 4),
  -- Unique per company: the same posting can never be written twice.
  source_key      text           not null,
  reason          text,
  stock_count_id  uuid,
  reversal_of     uuid,
  actor_id        uuid           not null,
  occurred_at     timestamptz    not null default now(),

  constraint erp_stock_movements_tenant_id_unique unique (tenant_id, id),
  constraint erp_stock_movements_source_unique unique (tenant_id, source_key),
  constraint erp_stock_movements_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_stock_movements_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_stock_movements_count_fk
    foreign key (tenant_id, stock_count_id) references erp_stock_counts (tenant_id, id) on delete restrict,
  constraint erp_stock_movements_reversal_fk
    -- No action rather than restrict: a purge deletes a correction and what it
    -- corrects in one statement, and only the end of that statement is checked.
    foreign key (tenant_id, reversal_of) references erp_stock_movements (tenant_id, id) on delete no action,
  constraint erp_stock_movements_kind_known check (kind in (
    'receipt', 'issue', 'transfer_out', 'transfer_in', 'adjustment', 'count_adjustment',
    'consumption', 'consumption_return', 'return_to_supplier')),
  constraint erp_stock_movements_quantity_signed check (
    quantity <> 0 and case
      when kind in ('receipt', 'transfer_in', 'consumption_return') then quantity > 0
      when kind in ('issue', 'transfer_out', 'consumption', 'return_to_supplier') then quantity < 0
      else true
    end),
  constraint erp_stock_movements_cost_not_negative check (unit_cost is null or unit_cost >= 0),
  constraint erp_stock_movements_source_shape check (char_length(source_key) between 1 and 200),
  constraint erp_stock_movements_reason_length check (reason is null or char_length(reason) <= 1000),
  constraint erp_stock_movements_count_kind check ((stock_count_id is not null) = (kind = 'count_adjustment'))
);
comment on table erp_stock_movements is
  'The stock ledger. Append-only; balances are derived from it (erp_stock_balances is its projection).';

create index erp_stock_movements_item_idx
  on erp_stock_movements (tenant_id, item_id, occurred_at desc, id);
create index erp_stock_movements_location_idx
  on erp_stock_movements (tenant_id, location_id, occurred_at desc, id);
create index erp_stock_movements_posting_idx on erp_stock_movements (tenant_id, posting_id);

create table erp_stock_balances (
  tenant_id    uuid           not null references tenants (id) on delete restrict,
  item_id      uuid           not null,
  location_id  uuid           not null,
  on_hand      numeric(20, 4) not null,
  updated_at   timestamptz    not null default now(),

  primary key (tenant_id, item_id, location_id),
  constraint erp_stock_balances_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_stock_balances_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  -- Stock never goes negative (product decision, 2026-10-11).
  constraint erp_stock_balances_not_negative check (on_hand >= 0)
);
comment on table erp_stock_balances is
  'How much of each item is at each location: the ledger''s projection, written only by its trigger.';
create index erp_stock_balances_location_idx on erp_stock_balances (tenant_id, location_id);

-- Each movement adds its quantity to its balance. The update locks the
-- balance row, so concurrent movements of one item at one place apply one at a
-- time, and the check constraint refuses any that would take it below zero.
-- (Not `insert … on conflict do update`: Postgres checks the constraint on the
-- row it would insert before it finds the conflict, so a negative movement
-- against stock that is there would be refused.)
create function erp_stock_apply_movement() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
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

create trigger erp_stock_movements_apply
  after insert on erp_stock_movements
  for each row execute function erp_stock_apply_movement();

-- How much of an item is at a location, with that balance row locked until the
-- caller's transaction ends. The runtime role may only read balances, and a
-- `select … for update` needs more than that, so the lock is taken here, with
-- the owner's rights. The company is named by the caller and must be the one
-- the transaction is scoped to; the schema owner, who has no scope, may name
-- any (the test harness and the purge run as the owner). Zero when the item
-- has never been there: nothing to lock, the first movement creates the row.
create function erp_stock_lock_balance(p_tenant uuid, p_item uuid, p_location uuid) returns numeric
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
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
revoke all on function erp_stock_lock_balance(uuid, uuid, uuid) from public;
grant execute on function erp_stock_lock_balance(uuid, uuid, uuid) to integr8_app;

create function erp_stock_movements_immutable() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'The stock ledger is append-only: post a correcting movement instead'
    using errcode = 'check_violation', constraint = 'erp_stock_movements_append_only';
end;
$$;

-- Named like the other append-only guards, so purge_tenant() can lift it for
-- the one deletion allowed: a whole company's, once it is due.
create trigger erp_stock_movements_no_delete
  before update or delete on erp_stock_movements
  for each row execute function erp_stock_movements_immutable();

-- A company's ledger goes when the company does, and only then: the purge
-- lifts this table's guard as it lifts the other append-only ones (0015).
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


-- ---------------------------------------------------------------------------
-- Reorder levels
-- ---------------------------------------------------------------------------

create table erp_reorder_levels (
  tenant_id    uuid           not null references tenants (id) on delete restrict,
  item_id      uuid           not null,
  location_id  uuid           not null,
  minimum      numeric(20, 4) not null,

  primary key (tenant_id, item_id, location_id),
  constraint erp_reorder_levels_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_reorder_levels_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_reorder_levels_minimum_not_negative check (minimum >= 0)
);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

grant select, insert, update
  on erp_item_categories, erp_items, erp_stock_locations, erp_stock_counts
  to integr8_app;
-- Draft count lines are edited by replacing them; reorder levels are set and cleared.
grant select, insert, update, delete on erp_stock_count_lines, erp_reorder_levels to integr8_app;
-- The ledger is appended to, never changed.
grant select, insert on erp_stock_movements to integr8_app;
-- Balances are read; only the ledger's trigger writes them.
grant select on erp_stock_balances to integr8_app;

alter table erp_item_categories enable row level security;
create policy erp_item_categories_isolation on erp_item_categories
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_items enable row level security;
create policy erp_items_isolation on erp_items
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_stock_locations enable row level security;
create policy erp_stock_locations_isolation on erp_stock_locations
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_stock_counts enable row level security;
create policy erp_stock_counts_isolation on erp_stock_counts
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_stock_count_lines enable row level security;
create policy erp_stock_count_lines_isolation on erp_stock_count_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_stock_movements enable row level security;
create policy erp_stock_movements_isolation on erp_stock_movements
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_stock_balances enable row level security;
create policy erp_stock_balances_isolation on erp_stock_balances
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_reorder_levels enable row level security;
create policy erp_reorder_levels_isolation on erp_reorder_levels
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
