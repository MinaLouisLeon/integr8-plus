-- CRM/ERP plan, phase E2 (second half): the parts used on a job (ADR-0005).
--
-- A use is recorded here and, for a stock item, posted to the ledger (0026) as
-- one `consumption` movement. When the location does not hold enough, nothing
-- posts and the row is kept as a `conflict` with what was asked for and what
-- was there, for a dispatcher to resolve. Stock never goes negative.
--
-- A phone records a use offline under its own id (`client_action_id`) and
-- sends it as many times as it takes; the unique index makes the second
-- arrival find the first.

create table erp_work_order_materials (
  id                 uuid           primary key default gen_random_uuid(),
  tenant_id          uuid           not null references tenants (id) on delete restrict,
  work_order_id      uuid           not null,
  item_id            uuid           not null,
  -- Where the part came from; null for services and non-stock items.
  location_id        uuid,
  quantity           numeric(20,4)  not null,
  returned_quantity  numeric(20,4)  not null default 0,
  -- The item's average unit cost when it posted; the default cost for an item
  -- that is not stock. Null until a conflict is resolved.
  unit_cost          numeric(20,4),
  status             text           not null default 'posted',
  -- What the location held when the use was refused (status = conflict).
  available_quantity numeric(20,4),
  -- The phone's own id for the action, carried unchanged on every retry.
  client_action_id   text,
  note               text,
  recorded_by        uuid           not null,
  recorded_at        timestamptz    not null default now(),
  -- When the engineer did it, by the phone's clock as the server reads it.
  occurred_at        timestamptz    not null default now(),
  cancelled_by       uuid,
  cancelled_at       timestamptz,
  version            integer        not null default 1,
  constraint erp_work_order_materials_tenant_id_unique unique (tenant_id, id),
  constraint erp_work_order_materials_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint erp_work_order_materials_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_work_order_materials_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_work_order_materials_quantity_positive check (quantity > 0),
  constraint erp_work_order_materials_returned_range
    check (returned_quantity >= 0 and returned_quantity <= quantity),
  constraint erp_work_order_materials_status_known
    check (status in ('posted', 'conflict', 'cancelled')),
  constraint erp_work_order_materials_cancelled_pairing check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is null) = (cancelled_by is null)),
  constraint erp_work_order_materials_conflict_shape
    check (status <> 'conflict' or available_quantity is not null),
  constraint erp_work_order_materials_note_length check (note is null or char_length(note) <= 1000),
  constraint erp_work_order_materials_client_action_length
    check (client_action_id is null or char_length(client_action_id) between 1 and 100),
  constraint erp_work_order_materials_version_positive check (version > 0)
);
create unique index erp_work_order_materials_client_action_unique
  on erp_work_order_materials (tenant_id, client_action_id) where client_action_id is not null;
create index erp_work_order_materials_by_job
  on erp_work_order_materials (tenant_id, work_order_id, recorded_at);
create index erp_work_order_materials_conflicts
  on erp_work_order_materials (tenant_id, recorded_at) where status = 'conflict';

-- A part used on a job is part of the job the phone shows (0011).
create trigger erp_work_order_materials_touch_sync
  after insert or update on erp_work_order_materials
  for each row execute function touch_sync('work_order', 'work_order_id');

grant select, insert, update on erp_work_order_materials to integr8_app;

alter table erp_work_order_materials enable row level security;
create policy erp_work_order_materials_isolation on erp_work_order_materials
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
