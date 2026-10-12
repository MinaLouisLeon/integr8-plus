-- CRM/ERP plan, phase E3: the machines a company services, their tags and
-- their service history (ADR-0008; plan/v1.1-inventory/P24).
--
-- An asset belongs to one customer's site and is numbered AS-000001 onwards
-- per company. Everything that matters to its history appends an immutable
-- event; an asset is never deleted, only retired, and never moved without an
-- event. A job names zero or more assets, and a submission, a part used or a
-- photo may name the one it concerns. The timeline is read from these rows,
-- never stored.

insert into feature_flags (key, description, default_enabled)
values
  ('assets',
   'Assets: the register of machines a company services, their QR tags and their service history. Off until Integr8 switches it on for a company.',
   false);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table erp_asset_settings (
  tenant_id            uuid        primary key references tenants (id) on delete restrict,
  -- How far ahead a warranty ending is flagged, in days.
  warranty_alert_days  integer     not null default 60,
  version              integer     not null default 1,
  updated_by           uuid,
  updated_at           timestamptz not null default now(),
  constraint erp_asset_settings_alert_range check (warranty_alert_days between 0 and 365),
  constraint erp_asset_settings_version_positive check (version > 0)
);
comment on table erp_asset_settings is
  'Per-company asset settings. Absent means the defaults.';

create trigger erp_asset_settings_set_updated_at
  before update on erp_asset_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Numbering
-- ---------------------------------------------------------------------------

create table asset_reference_counters (
  tenant_id       uuid    primary key references tenants (id) on delete restrict,
  last_reference  integer not null
);
comment on table asset_reference_counters is
  'The last asset number handed out per company. Written only by assign_asset_reference.';

create function assign_asset_reference() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.reference is distinct from old.reference then
      raise exception 'An asset keeps its number'
        using errcode = 'check_violation', constraint = 'erp_assets_reference_fixed';
    end if;
    return new;
  end if;
  insert into public.asset_reference_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;
comment on function assign_asset_reference() is
  'Numbers an asset when it is created, and keeps the number. Security definer: the runtime role cannot write the counter.';

-- ---------------------------------------------------------------------------
-- The register
-- ---------------------------------------------------------------------------

create table erp_assets (
  id                     uuid        primary key default gen_random_uuid(),
  tenant_id              uuid        not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as AS-000123; given when created.
  reference              integer     not null default 0,
  customer_id            uuid        not null,
  site_id                uuid        not null,
  -- What it is in the catalogue, if it is one of the company's items.
  item_id                uuid,
  name                   text        not null,
  make                   text,
  model                  text,
  -- The manufacturer's serial: unique within the company when given.
  serial_number          text,
  -- Where on the site: "plant room, second boiler from the door".
  location_note          text,
  install_date           date,
  warranty_expires_on    date,
  status                 text        not null default 'active',
  -- The last condition recorded, and by whom and when.
  condition              text,
  condition_recorded_at  timestamptz,
  condition_recorded_by  uuid,
  -- What the printed QR code links to: unique across Integr8, reissued on demand.
  tag_code               text        not null,
  notes                  text,
  -- The phone's own id for registering it, carried unchanged on every retry.
  client_action_id       text,
  version                integer     not null default 1,
  created_by             uuid        not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  retired_at             timestamptz,
  retired_by             uuid,
  constraint erp_assets_tenant_id_unique unique (tenant_id, id),
  constraint erp_assets_reference_unique unique (tenant_id, reference),
  constraint erp_assets_tag_code_unique unique (tag_code),
  constraint erp_assets_site_fk
    foreign key (tenant_id, customer_id, site_id) references sites (tenant_id, customer_id, id) on delete restrict,
  constraint erp_assets_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_assets_status_known check (status in ('active', 'out_of_service', 'retired')),
  constraint erp_assets_condition_known check (condition is null or condition in ('good', 'fair', 'poor', 'unusable')),
  constraint erp_assets_condition_pairing check (
    (condition is null) = (condition_recorded_at is null)
    and (condition_recorded_at is null) = (condition_recorded_by is null)),
  constraint erp_assets_retired_pairing check (
    (status = 'retired') = (retired_at is not null)
    and (retired_at is null) = (retired_by is null)),
  constraint erp_assets_tag_code_shape check (tag_code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  constraint erp_assets_name_present check (btrim(name) <> '' and char_length(name) <= 200),
  constraint erp_assets_text_lengths check (
    (make is null or char_length(make) <= 200)
    and (model is null or char_length(model) <= 200)
    and (serial_number is null or (btrim(serial_number) <> '' and char_length(serial_number) <= 200))
    and (location_note is null or char_length(location_note) <= 500)
    and (notes is null or char_length(notes) <= 2000)),
  constraint erp_assets_client_action_length
    check (client_action_id is null or char_length(client_action_id) between 1 and 100),
  constraint erp_assets_version_positive check (version > 0)
);
comment on table erp_assets is
  'A machine a company services, at one customer''s site. Never deleted: retired. Every change that matters appends an erp_asset_events row.';

create unique index erp_assets_serial_unique
  on erp_assets (tenant_id, lower(btrim(serial_number))) where serial_number is not null;
create unique index erp_assets_client_action_unique
  on erp_assets (tenant_id, client_action_id) where client_action_id is not null;
create index erp_assets_by_site on erp_assets (tenant_id, site_id, reference);
create index erp_assets_by_customer on erp_assets (tenant_id, customer_id, reference);
create index erp_assets_by_warranty on erp_assets (tenant_id, warranty_expires_on)
  where warranty_expires_on is not null and status <> 'retired';

create trigger erp_assets_assign_reference
  before insert or update on erp_assets
  for each row execute function assign_asset_reference();
create trigger erp_assets_set_updated_at
  before update on erp_assets
  for each row execute function set_updated_at();
-- A phone holds the assets of its sites: a change to one is a change to the site.
create trigger erp_assets_touch_sync after insert or update on erp_assets
  for each row execute function touch_sync('site', 'site_id');

-- ---------------------------------------------------------------------------
-- The history
-- ---------------------------------------------------------------------------

create table erp_asset_events (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants (id) on delete restrict,
  asset_id          uuid        not null,
  kind              text        not null,
  -- Relocation: where it was.
  from_customer_id  uuid,
  from_site_id      uuid,
  -- Status changes: what it was and what it became.
  from_status       text,
  to_status         text,
  -- Condition recorded.
  condition         text,
  -- Edits: { field: [before, after] } for each field that changed.
  changes           jsonb,
  -- The job it happened on, if any.
  work_order_id     uuid,
  note              text,
  actor_id          uuid        not null,
  -- When it happened, by the phone's clock as the server reads it.
  occurred_at       timestamptz not null default now(),
  recorded_at       timestamptz not null default now(),
  client_action_id  text,
  constraint erp_asset_events_tenant_id_unique unique (tenant_id, id),
  constraint erp_asset_events_asset_fk
    foreign key (tenant_id, asset_id) references erp_assets (tenant_id, id) on delete restrict,
  constraint erp_asset_events_from_site_fk
    foreign key (tenant_id, from_customer_id, from_site_id) references sites (tenant_id, customer_id, id) on delete restrict,
  constraint erp_asset_events_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint erp_asset_events_kind_known check (kind in (
    'registered', 'updated', 'relocated', 'status_changed', 'condition_recorded', 'tag_reissued')),
  constraint erp_asset_events_relocated_shape check (
    (kind = 'relocated') = (from_site_id is not null)
    and (from_site_id is null) = (from_customer_id is null)),
  constraint erp_asset_events_status_shape check (
    (kind = 'status_changed') = (to_status is not null)
    and (to_status is null) = (from_status is null)),
  constraint erp_asset_events_status_known check (
    (from_status is null or from_status in ('active', 'out_of_service', 'retired'))
    and (to_status is null or to_status in ('active', 'out_of_service', 'retired'))),
  constraint erp_asset_events_condition_shape check (
    (kind = 'condition_recorded') = (condition is not null)),
  constraint erp_asset_events_condition_known check (
    condition is null or condition in ('good', 'fair', 'poor', 'unusable')),
  constraint erp_asset_events_changes_shape check (
    changes is null or jsonb_typeof(changes) = 'object'),
  constraint erp_asset_events_note_length check (note is null or char_length(note) <= 1000),
  constraint erp_asset_events_client_action_length
    check (client_action_id is null or char_length(client_action_id) between 1 and 100)
);
comment on table erp_asset_events is
  'What happened to an asset, appended and never changed: the runtime role may only insert and read.';

create index erp_asset_events_by_asset on erp_asset_events (tenant_id, asset_id, occurred_at desc);
create unique index erp_asset_events_client_action_unique
  on erp_asset_events (tenant_id, client_action_id) where client_action_id is not null;

-- ---------------------------------------------------------------------------
-- Jobs, submissions, parts and photos
-- ---------------------------------------------------------------------------

create table erp_work_order_assets (
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  work_order_id  uuid        not null,
  asset_id       uuid        not null,
  linked_by      uuid        not null,
  linked_at      timestamptz not null default now(),
  constraint erp_work_order_assets_pkey primary key (tenant_id, work_order_id, asset_id),
  constraint erp_work_order_assets_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint erp_work_order_assets_asset_fk
    foreign key (tenant_id, asset_id) references erp_assets (tenant_id, id) on delete restrict
);
comment on table erp_work_order_assets is
  'The assets a job is for: zero or more, at the job''s site when linked.';

create index erp_work_order_assets_by_asset on erp_work_order_assets (tenant_id, asset_id, linked_at desc);

create trigger erp_work_order_assets_touch_sync after insert or delete on erp_work_order_assets
  for each row execute function touch_sync('work_order', 'work_order_id');

alter table submissions
  add column asset_id uuid,
  add constraint submissions_asset_fk
    foreign key (tenant_id, asset_id) references erp_assets (tenant_id, id) on delete restrict;
comment on column submissions.asset_id is
  'The asset this form was filled for, if any; one of the job''s assets.';
create index submissions_asset_idx on submissions (tenant_id, asset_id, form_id)
  where asset_id is not null;

alter table erp_work_order_materials
  add column asset_id uuid,
  add constraint erp_work_order_materials_asset_fk
    foreign key (tenant_id, asset_id) references erp_assets (tenant_id, id) on delete restrict;
comment on column erp_work_order_materials.asset_id is
  'The asset the part was fitted to, if any; one of the job''s assets.';
create index erp_work_order_materials_asset_idx on erp_work_order_materials (tenant_id, asset_id)
  where asset_id is not null;

-- A photo or manual may belong to an asset, as it may to a customer, a site or a job.
alter table attachments
  add column asset_id uuid,
  add constraint attachments_asset_fk
    foreign key (tenant_id, asset_id) references erp_assets (tenant_id, id) on delete restrict,
  drop constraint attachments_one_owner,
  add constraint attachments_one_owner check (num_nonnulls(customer_id, site_id, work_order_id, asset_id) = 1);
create index attachments_asset_idx on attachments (tenant_id, asset_id) where asset_id is not null;

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

grant select, insert, update on erp_asset_settings to integr8_app;
grant select on asset_reference_counters to integr8_app;
-- Retired, never deleted.
grant select, insert, update on erp_assets to integr8_app;
-- Appended, never changed.
grant select, insert on erp_asset_events to integr8_app;
grant select, insert, delete on erp_work_order_assets to integr8_app;

alter table erp_asset_settings enable row level security;
create policy erp_asset_settings_isolation on erp_asset_settings
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table asset_reference_counters enable row level security;
create policy asset_reference_counters_isolation on asset_reference_counters
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table erp_assets enable row level security;
create policy erp_assets_isolation on erp_assets
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_asset_events enable row level security;
create policy erp_asset_events_isolation on erp_asset_events
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_work_order_assets enable row level security;
create policy erp_work_order_assets_isolation on erp_work_order_assets
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
