-- Ninth round (ADR-0013): serial numbers and batches.
--
-- A stock item is tracked by `none`, `serial` or `batch`. A lot is one
-- serial number (one unit) or one batch code (with an optional expiry) of an
-- item. Every movement of a tracked item names its lot, and the lot's stock
-- per location is the ledger's second projection, written only by trigger:
-- never below zero, and a serial number is never in two places or twice in
-- one. Movements made before an item was tracked keep no lot; an item becomes
-- tracked only with nothing on hand or through a count that gives each unit
-- its lot (the API's rule).

alter table erp_items
  add column tracking text not null default 'none',
  add constraint erp_items_tracking_known check (tracking in ('none', 'serial', 'batch')),
  add constraint erp_items_tracking_stock_only check (tracking = 'none' or kind = 'stock_item');

create table erp_stock_lots (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete restrict,
  item_id     uuid        not null,
  kind        text        not null,
  -- The serial number or batch code, as printed.
  code        text        not null,
  -- A batch's expiry day, if it has one.
  expires_on  date,
  created_by  uuid        not null,
  created_at  timestamptz not null default now(),
  constraint erp_stock_lots_tenant_id_unique unique (tenant_id, id),
  constraint erp_stock_lots_code_unique unique (tenant_id, item_id, code),
  constraint erp_stock_lots_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_stock_lots_kind_known check (kind in ('serial', 'batch')),
  constraint erp_stock_lots_code_present check (btrim(code) <> '' and char_length(code) <= 100),
  constraint erp_stock_lots_expiry_batch_only check (kind = 'batch' or expires_on is null)
);
create index erp_stock_lots_code_idx on erp_stock_lots (tenant_id, lower(code));
comment on table erp_stock_lots is
  'Serial numbers and batches of tracked items (ADR-0013). Never changed or deleted.';

alter table erp_stock_movements
  add column lot_id uuid,
  add constraint erp_stock_movements_lot_fk
    foreign key (tenant_id, lot_id) references erp_stock_lots (tenant_id, id) on delete restrict;
create index erp_stock_movements_lot_idx on erp_stock_movements (tenant_id, lot_id, occurred_at)
  where lot_id is not null;

create table erp_stock_lot_balances (
  tenant_id    uuid           not null references tenants (id) on delete restrict,
  lot_id       uuid           not null,
  location_id  uuid           not null,
  item_id      uuid           not null,
  on_hand      numeric(20, 4) not null,
  updated_at   timestamptz    not null default now(),
  primary key (tenant_id, lot_id, location_id),
  constraint erp_stock_lot_balances_lot_fk
    foreign key (tenant_id, lot_id) references erp_stock_lots (tenant_id, id) on delete restrict,
  constraint erp_stock_lot_balances_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_stock_lot_balances_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_stock_lot_balances_not_negative check (on_hand >= 0)
);
create index erp_stock_lot_balances_item_idx on erp_stock_lot_balances (tenant_id, item_id, location_id)
  where on_hand > 0;
comment on table erp_stock_lot_balances is
  'How much of each serial or batch is at each location: the ledger''s projection per lot, written only by its trigger.';

-- A tracked item's movement names a lot of that item, of the item's kind; a
-- serial moves one at a time. An untracked item's names none.
create function erp_stock_movements_lot_check() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
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
create trigger erp_stock_movements_lot_check
  before insert on erp_stock_movements
  for each row execute function erp_stock_movements_lot_check();

-- Each movement with a lot adds its quantity to the lot's balance there; a
-- serial number is never held more than once, anywhere.
create function erp_stock_apply_lot_movement() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
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
create trigger erp_stock_movements_apply_lot
  after insert on erp_stock_movements
  for each row execute function erp_stock_apply_lot_movement();

-- A lot's balance at a location, locked until the transaction ends (as
-- erp_stock_lock_balance does for an item's).
create function erp_stock_lock_lot_balance(p_tenant uuid, p_lot uuid, p_location uuid) returns numeric
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
    from erp_stock_lot_balances
   where tenant_id = p_tenant and lot_id = p_lot and location_id = p_location
     for update;
  return coalesce(held, 0);
end;
$$;
revoke all on function erp_stock_lock_lot_balance(uuid, uuid, uuid) from public;
grant execute on function erp_stock_lock_lot_balance(uuid, uuid, uuid) to integr8_app;

-- A count of a tracked item counts each of its lots.
alter table erp_stock_count_lines
  add column lot_id uuid,
  -- A lot named by the count that the company has not seen before, created
  -- when the count is posted.
  add column lot_code text,
  add column lot_expires_on date,
  add constraint erp_stock_count_lines_lot_fk
    foreign key (tenant_id, lot_id) references erp_stock_lots (tenant_id, id) on delete restrict,
  add constraint erp_stock_count_lines_lot_code_length
    check (lot_code is null or (btrim(lot_code) <> '' and char_length(lot_code) <= 100)),
  drop constraint erp_stock_count_lines_pkey,
  add constraint erp_stock_count_lines_unique
    unique nulls not distinct (tenant_id, count_id, item_id, lot_id, lot_code);

-- A part used on a job names the serial numbers or batches it took, as the
-- phone or the office chose them: kept so a refused use can be retried with
-- them, or with others.
alter table erp_work_order_materials
  add column lots jsonb,
  add constraint erp_work_order_materials_lots_shape check (lots is null or jsonb_typeof(lots) = 'array');

grant select, insert on erp_stock_lots to integr8_app;
grant select on erp_stock_lot_balances to integr8_app;

alter table erp_stock_lots enable row level security;
create policy erp_stock_lots_isolation on erp_stock_lots
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_stock_lot_balances enable row level security;
create policy erp_stock_lot_balances_isolation on erp_stock_lot_balances
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
