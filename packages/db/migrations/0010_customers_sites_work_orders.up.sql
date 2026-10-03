-- 0010 - customers, sites and work orders.
--
-- The operational records everything else attaches to: who the customer is,
-- where the work happens, and what the job is (P10).
--
--   customers ─┬─ customer_contacts
--              └─ sites (address, coordinates, access notes, a contact)
--   job_types ── job_type_forms (the forms a type of job carries; some required)
--   work_orders (customer, site, type) ─┬─ work_order_forms       copied from the type
--                                       ├─ work_order_checklist_items
--                                       ├─ work_order_assignments  one lead per crew
--                                       ├─ work_order_comments     internal or customer-visible
--                                       └─ work_order_events       history, by trigger
--   attachments      files (0009) linked to a customer, a site or a work order
--   saved_views      a person's filters for a list
--   imports          a CSV file and what became of each row
--   submissions.work_order_id   the job a form was filled for
--
-- Two rules are enforced here rather than trusted to the API, because they must
-- hold for every client:
--
--   * A work order moves only along the transitions below. A free-text status
--     is how field service software becomes unreportable.
--
--       scheduled ──▶ dispatched ──▶ travelling ──▶ on_site ──▶ in_progress ──▶ complete ──▶ reviewed
--           ▲  │         │  ▲            │            ▲             │  ▲            │
--           │  │         │  └────────────┘            └─────────────┘  │            │ (reopen, with a reason)
--           │  │         └──────────────────▶ on_site          awaiting_parts ◀─────┘
--           │  ▼                                                 │ ▲
--        cancelled (with a reason; reinstated to scheduled)      ▼ │  back to scheduled or dispatched
--
--   * A work order cannot become complete while any form its type requires has
--     no submitted submission linked to it.

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------

create table customers (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete restrict,
  name            text        not null,
  account_number  text,
  status          text        not null default 'active',
  email           text,
  phone           text,
  address_line1   text,
  address_line2   text,
  city            text,
  region          text,
  postcode        text,
  country_code    text,
  tags            text[]      not null default '{}',
  notes           text,
  created_by      uuid        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  search          tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(name, '') || ' ' || coalesce(account_number, '') || ' ' ||
      coalesce(email, '') || ' ' || coalesce(phone, '') || ' ' ||
      coalesce(city, '') || ' ' || coalesce(postcode, ''))
  ) stored,

  constraint customers_tenant_id_unique unique (tenant_id, id),
  constraint customers_name_present check (btrim(name) <> '' and char_length(name) <= 200),
  constraint customers_status_known check (status in ('active', 'on_hold', 'closed')),
  constraint customers_account_number_shape
    check (account_number is null or (btrim(account_number) <> '' and char_length(account_number) <= 64)),
  constraint customers_country_code_shape check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint customers_tags_sane check (cardinality(tags) <= 50),
  constraint customers_notes_length check (notes is null or char_length(notes) <= 10000)
);

comment on table customers is
  'A company this company does work for. Closed rather than deleted: work orders and submissions keep pointing at it.';
comment on column customers.status is
  'active, on_hold (no new work without a word with accounts), closed (no new work).';

create unique index customers_account_number_unique on customers (tenant_id, lower(account_number))
  where account_number is not null;
create index customers_name_idx on customers (tenant_id, lower(name), id);
create index customers_search_idx on customers using gin (search);
create index customers_tags_idx on customers using gin (tags);

create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- customer_contacts
-- ---------------------------------------------------------------------------

create table customer_contacts (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  customer_id  uuid        not null,
  name         text        not null,
  job_title    text,
  email        text,
  phone        text,
  is_primary   boolean     not null default false,
  notes        text,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint customer_contacts_tenant_id_unique unique (tenant_id, id),
  -- The key a site's contact references, so it must be one of its own customer's.
  constraint customer_contacts_customer_id_unique unique (tenant_id, customer_id, id),
  constraint customer_contacts_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint customer_contacts_name_present check (btrim(name) <> '' and char_length(name) <= 200),
  constraint customer_contacts_notes_length check (notes is null or char_length(notes) <= 4000),
  constraint customer_contacts_primary_is_current check (not (is_primary and archived_at is not null))
);

create unique index customer_contacts_one_primary on customer_contacts (tenant_id, customer_id)
  where is_primary;
create index customer_contacts_customer_idx on customer_contacts (tenant_id, customer_id, name);

create trigger customer_contacts_set_updated_at
  before update on customer_contacts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------

create table sites (
  id                 uuid          primary key default gen_random_uuid(),
  tenant_id          uuid          not null references tenants (id) on delete restrict,
  customer_id        uuid          not null,
  name               text          not null,
  address_line1      text          not null,
  address_line2      text,
  city               text,
  region             text,
  postcode           text,
  country_code       text,
  latitude           numeric(9, 6),
  longitude          numeric(9, 6),
  -- pending: to be geocoded; found / not_found / failed: what the geocoder said;
  -- manual: placed by a person, and not overwritten until the address changes.
  geocode_status     text          not null default 'pending',
  geocode_accuracy   text,
  geocoded_at        timestamptz,
  contact_id         uuid,
  access_gate_code   text,
  access_parking     text,
  access_ask_for     text,
  access_hazards     text,
  access_notes       text,
  access_updated_at  timestamptz,
  access_updated_by  uuid,
  archived_at        timestamptz,
  created_by         uuid          not null,
  created_at         timestamptz   not null default now(),
  updated_at         timestamptz   not null default now(),
  search             tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(name, '') || ' ' || coalesce(address_line1, '') || ' ' || coalesce(address_line2, '') || ' ' ||
      coalesce(city, '') || ' ' || coalesce(postcode, ''))
  ) stored,

  constraint sites_tenant_id_unique unique (tenant_id, id),
  -- The key a work order's site references, so the site is its customer's.
  constraint sites_customer_id_unique unique (tenant_id, customer_id, id),
  constraint sites_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint sites_contact_fk
    foreign key (tenant_id, customer_id, contact_id) references customer_contacts (tenant_id, customer_id, id)
    on delete restrict,
  constraint sites_name_present check (btrim(name) <> '' and char_length(name) <= 200),
  constraint sites_address_present check (btrim(address_line1) <> ''),
  constraint sites_country_code_shape check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint sites_coordinates_pair check ((latitude is null) = (longitude is null)),
  constraint sites_latitude_range check (latitude is null or latitude between -90 and 90),
  constraint sites_longitude_range check (longitude is null or longitude between -180 and 180),
  constraint sites_geocode_status_known
    check (geocode_status in ('pending', 'found', 'not_found', 'failed', 'manual')),
  constraint sites_located_has_coordinates
    check ((geocode_status in ('found', 'manual')) = (latitude is not null)),
  constraint sites_access_lengths check (
    coalesce(char_length(access_gate_code), 0) <= 200 and coalesce(char_length(access_parking), 0) <= 2000
    and coalesce(char_length(access_ask_for), 0) <= 500 and coalesce(char_length(access_hazards), 0) <= 4000
    and coalesce(char_length(access_notes), 0) <= 4000
  )
);

comment on table sites is
  'Where work happens. Belongs to one customer for good; archived rather than deleted.';
comment on column sites.access_hazards is
  'Safety hazards on arrival. With the other access_ columns, the first thing an engineer sees on a job.';

create index sites_customer_idx on sites (tenant_id, customer_id, name);
create index sites_search_idx on sites using gin (search);
create index sites_geocode_pending_idx on sites (tenant_id) where geocode_status = 'pending';

create trigger sites_set_updated_at
  before update on sites
  for each row execute function set_updated_at();

-- A site stays with its customer; a changed address makes old coordinates wrong.
create function guard_site_change() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.customer_id is distinct from old.customer_id then
      raise exception 'site % belongs to customer % and cannot be moved', old.id, old.customer_id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if (new.address_line1, new.address_line2, new.city, new.region, new.postcode, new.country_code)
       is distinct from
       (old.address_line1, old.address_line2, old.city, old.region, old.postcode, old.country_code)
       and new.latitude is not distinct from old.latitude
       and new.longitude is not distinct from old.longitude then
      new.latitude := null;
      new.longitude := null;
      new.geocode_status := 'pending';
      new.geocode_accuracy := null;
      new.geocoded_at := null;
    end if;
    if (new.access_gate_code, new.access_parking, new.access_ask_for, new.access_hazards, new.access_notes)
       is distinct from
       (old.access_gate_code, old.access_parking, old.access_ask_for, old.access_hazards, old.access_notes) then
      new.access_updated_at := now();
    end if;
  elsif num_nonnulls(new.access_gate_code, new.access_parking, new.access_ask_for, new.access_hazards, new.access_notes) > 0 then
    new.access_updated_at := now();
    new.access_updated_by := coalesce(new.access_updated_by, new.created_by);
  end if;
  return new;
end;
$$;

create trigger sites_guard_change
  before insert or update on sites
  for each row execute function guard_site_change();

-- ---------------------------------------------------------------------------
-- job_types and the forms they carry
-- ---------------------------------------------------------------------------

create table job_types (
  id                          uuid        primary key default gen_random_uuid(),
  tenant_id                   uuid        not null references tenants (id) on delete restrict,
  name                        text        not null,
  code                        text        not null,
  description                 text,
  expected_duration_minutes   integer,
  default_priority            text        not null default 'normal',
  instructions                text,
  -- [{ "id": "…", "label": "…" }], copied onto each new work order of this type.
  checklist                   jsonb       not null default '[]',
  archived_at                 timestamptz,
  created_by                  uuid        not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint job_types_tenant_id_unique unique (tenant_id, id),
  constraint job_types_name_present check (btrim(name) <> '' and char_length(name) <= 120),
  constraint job_types_code_shape check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  constraint job_types_duration_range
    check (expected_duration_minutes is null or expected_duration_minutes between 1 and 10080),
  constraint job_types_priority_known check (default_priority in ('low', 'normal', 'high', 'urgent')),
  constraint job_types_checklist_shape check (jsonb_typeof(checklist) = 'array' and jsonb_array_length(checklist) <= 100),
  constraint job_types_instructions_length check (instructions is null or char_length(instructions) <= 10000)
);

comment on table job_types is
  'The kinds of job a company does, each carrying its forms, checklist, instructions and expected duration.';

create unique index job_types_code_unique on job_types (tenant_id, code);
create unique index job_types_name_unique on job_types (tenant_id, lower(name));

create trigger job_types_set_updated_at
  before update on job_types
  for each row execute function set_updated_at();

create table job_type_forms (
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  job_type_id  uuid        not null,
  form_id      uuid        not null,
  -- Required forms must be submitted before a job of this type can be completed;
  -- the others are offered on the job but optional.
  required     boolean     not null default true,
  position     integer     not null default 0,
  created_at   timestamptz not null default now(),

  constraint job_type_forms_pk primary key (tenant_id, job_type_id, form_id),
  constraint job_type_forms_job_type_fk
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id) on delete restrict,
  constraint job_type_forms_form_fk
    foreign key (tenant_id, form_id) references forms (tenant_id, id) on delete restrict
);

create index job_type_forms_form_idx on job_type_forms (tenant_id, form_id);

-- ---------------------------------------------------------------------------
-- work_orders
-- ---------------------------------------------------------------------------

create table work_order_counters (
  tenant_id       uuid    primary key references tenants (id) on delete restrict,
  last_reference  integer not null
);

comment on table work_order_counters is
  'The last work order reference handed out per company. Written only by assign_work_order_reference.';

create table work_orders (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as WO-000123. Assigned by trigger.
  reference         integer     not null default 0,
  customer_id       uuid        not null,
  site_id           uuid        not null,
  job_type_id       uuid        not null,
  title             text        not null,
  description       text,
  instructions      text,
  priority          text        not null default 'normal',
  state             text        not null default 'scheduled',
  due_from          timestamptz,
  due_by            timestamptz,
  state_changed_at  timestamptz not null default now(),
  completed_at      timestamptz,
  reviewed_at       timestamptz,
  cancelled_at      timestamptz,
  last_actor        uuid        not null,
  last_reason       text,
  revision          integer     not null default 1,
  created_by        uuid        not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search            tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(description, ''))
  ) stored,

  constraint work_orders_tenant_id_unique unique (tenant_id, id),
  constraint work_orders_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint work_orders_site_fk
    foreign key (tenant_id, customer_id, site_id) references sites (tenant_id, customer_id, id) on delete restrict,
  constraint work_orders_job_type_fk
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id) on delete restrict,
  constraint work_orders_title_present check (btrim(title) <> '' and char_length(title) <= 200),
  constraint work_orders_text_lengths check (
    coalesce(char_length(description), 0) <= 10000 and coalesce(char_length(instructions), 0) <= 10000
  ),
  constraint work_orders_priority_known check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint work_orders_state_known check (state in (
    'scheduled', 'dispatched', 'travelling', 'on_site', 'in_progress', 'awaiting_parts',
    'complete', 'reviewed', 'cancelled'
  )),
  constraint work_orders_due_window check (due_from is null or due_by is null or due_by >= due_from),
  constraint work_orders_revision_positive check (revision >= 1),
  constraint work_orders_reason_length check (last_reason is null or char_length(last_reason) <= 2000),
  constraint work_orders_completed_matches_state
    check ((state in ('complete', 'reviewed')) = (completed_at is not null)),
  constraint work_orders_reviewed_matches_state check ((state = 'reviewed') = (reviewed_at is not null)),
  constraint work_orders_cancelled_matches_state check ((state = 'cancelled') = (cancelled_at is not null))
);

comment on table work_orders is
  'A job: for a customer, at one of its sites, of a type. Its state moves only along the transitions enforce_work_order_state allows.';
comment on column work_orders.last_actor is
  'Who made the change being written. work_order_events records it.';

create unique index work_orders_reference_unique on work_orders (tenant_id, reference);
create index work_orders_state_idx on work_orders (tenant_id, state, due_by, id);
create index work_orders_due_idx on work_orders (tenant_id, due_by, id);
create index work_orders_customer_idx on work_orders (tenant_id, customer_id, created_at desc);
create index work_orders_site_idx on work_orders (tenant_id, site_id, created_at desc);
create index work_orders_job_type_idx on work_orders (tenant_id, job_type_id);
create index work_orders_search_idx on work_orders using gin (search);

create trigger work_orders_set_updated_at
  before update on work_orders
  for each row execute function set_updated_at();

-- Security definer: the runtime role cannot write the counter, so references
-- cannot be skipped, reused or chosen.
create function assign_work_order_reference() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.work_order_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;

comment on function assign_work_order_reference() is
  'Gives a new work order the next reference for its company. Security definer: the runtime role cannot write work_order_counters.';

create trigger work_orders_assign_reference
  before insert on work_orders
  for each row execute function assign_work_order_reference();

create table work_order_forms (
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  work_order_id  uuid        not null,
  form_id        uuid        not null,
  required       boolean     not null default true,
  position       integer     not null default 0,
  added_by       uuid        not null,
  created_at     timestamptz not null default now(),

  constraint work_order_forms_pk primary key (tenant_id, work_order_id, form_id),
  constraint work_order_forms_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint work_order_forms_form_fk
    foreign key (tenant_id, form_id) references forms (tenant_id, id) on delete restrict
);

comment on table work_order_forms is
  'The forms on one job. Copied from its type when it is created, so changing a type later does not change a job already out.';

create table work_order_checklist_items (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  work_order_id  uuid        not null,
  position       integer     not null,
  label          text        not null,
  done           boolean     not null default false,
  done_by        uuid,
  done_at        timestamptz,
  created_at     timestamptz not null default now(),

  constraint work_order_checklist_items_tenant_id_unique unique (tenant_id, id),
  constraint work_order_checklist_items_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint work_order_checklist_items_label_present check (btrim(label) <> '' and char_length(label) <= 300),
  constraint work_order_checklist_items_done_complete
    check (done = (done_by is not null and done_at is not null))
);

create index work_order_checklist_items_work_order_idx
  on work_order_checklist_items (tenant_id, work_order_id, position);

create table work_order_assignments (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  work_order_id  uuid        not null,
  user_id        uuid        not null,
  is_lead        boolean     not null default false,
  assigned_by    uuid        not null,
  assigned_at    timestamptz not null default now(),
  -- Unassigned rather than deleted, so the history says who took someone off.
  unassigned_at  timestamptz,
  unassigned_by  uuid,

  constraint work_order_assignments_tenant_id_unique unique (tenant_id, id),
  constraint work_order_assignments_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint work_order_assignments_member_fk
    foreign key (tenant_id, user_id) references tenant_users (tenant_id, user_id) on delete restrict,
  constraint work_order_assignments_unassigned_complete
    check ((unassigned_at is null) = (unassigned_by is null)),
  constraint work_order_assignments_lead_is_current check (not (is_lead and unassigned_at is not null))
);

create unique index work_order_assignments_current_unique
  on work_order_assignments (tenant_id, work_order_id, user_id) where unassigned_at is null;
create unique index work_order_assignments_one_lead
  on work_order_assignments (tenant_id, work_order_id) where is_lead;
create index work_order_assignments_user_idx
  on work_order_assignments (tenant_id, user_id, work_order_id) where unassigned_at is null;

create table work_order_comments (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  work_order_id  uuid        not null,
  author_id      uuid        not null,
  -- internal: only this company's people. customer: may be shown to the customer (P29).
  visibility     text        not null,
  body           text        not null,
  created_at     timestamptz not null default now(),

  constraint work_order_comments_tenant_id_unique unique (tenant_id, id),
  constraint work_order_comments_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint work_order_comments_visibility_known check (visibility in ('internal', 'customer')),
  constraint work_order_comments_body_present check (btrim(body) <> '' and char_length(body) <= 10000)
);

comment on table work_order_comments is
  'Notes on a job. Internal notes and customer-visible notes are kept apart by visibility; neither is edited or deleted.';

create index work_order_comments_work_order_idx on work_order_comments (tenant_id, work_order_id, created_at);

-- ---------------------------------------------------------------------------
-- work_order_events: the history, written by trigger
-- ---------------------------------------------------------------------------

create table work_order_events (
  id             uuid        primary key default gen_random_uuid(),
  -- Order of writing. Events from one transaction share occurred_at.
  sequence       bigint      generated always as identity,
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  work_order_id  uuid        not null,
  kind           text        not null,
  from_state     text,
  to_state       text,
  user_id        uuid,
  actor_id       uuid        not null,
  reason         text,
  details        jsonb       not null default '{}',
  occurred_at    timestamptz not null default now(),

  constraint work_order_events_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed'
  )),
  constraint work_order_events_transition_complete
    check ((kind = 'transitioned') = (from_state is not null and to_state is not null)),
  constraint work_order_events_person_when_assignment
    check ((kind in ('assigned', 'unassigned', 'lead_changed')) = (user_id is not null))
);

comment on table work_order_events is
  'Append-only history of a work order: creation, every transition, reschedule, edit and assignment change. Written only by trigger.';

create index work_order_events_work_order_idx on work_order_events (tenant_id, work_order_id, sequence);

create function reject_work_order_events_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'work_order_events is append-only; % is not permitted', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

create trigger work_order_events_no_update
  before update on work_order_events
  for each statement execute function reject_work_order_events_mutation();
create trigger work_order_events_no_delete
  before delete on work_order_events
  for each statement execute function reject_work_order_events_mutation();
create trigger work_order_events_no_truncate
  before truncate on work_order_events
  for each statement execute function reject_work_order_events_mutation();

-- ---------------------------------------------------------------------------
-- The state machine, enforced
-- ---------------------------------------------------------------------------

create function work_order_transition_allowed(from_state text, to_state text) returns boolean
language sql
immutable
as $$
  select (from_state, to_state) in (
    ('scheduled', 'dispatched'),
    ('scheduled', 'cancelled'),
    ('dispatched', 'scheduled'),
    ('dispatched', 'travelling'),
    ('dispatched', 'on_site'),
    ('dispatched', 'cancelled'),
    ('travelling', 'dispatched'),
    ('travelling', 'on_site'),
    ('travelling', 'cancelled'),
    ('on_site', 'in_progress'),
    ('on_site', 'travelling'),
    ('in_progress', 'awaiting_parts'),
    ('in_progress', 'complete'),
    ('awaiting_parts', 'in_progress'),
    ('awaiting_parts', 'scheduled'),
    ('awaiting_parts', 'dispatched'),
    ('awaiting_parts', 'cancelled'),
    ('complete', 'reviewed'),
    ('complete', 'in_progress'),
    ('cancelled', 'scheduled')
  );
$$;

comment on function work_order_transition_allowed(text, text) is
  'The work order state machine. Mirrored by WORK_ORDER_TRANSITIONS in @integr8/core, and checked against it by the schema-invariant suite.';

create function enforce_work_order_state() returns trigger
language plpgsql
as $$
declare
  missing text;
begin
  if new.last_actor is null then
    raise exception 'work order % was written without last_actor', new.id
      using errcode = 'not_null_violation';
  end if;

  if tg_op = 'INSERT' then
    if new.state <> 'scheduled' then
      raise exception 'a work order starts scheduled, not %', new.state
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.state_changed_at := now();
    return new;
  end if;

  if new.reference is distinct from old.reference or new.created_by is distinct from old.created_by then
    raise exception 'work order % keeps its reference and creator', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if new.state is distinct from old.state then
    if not work_order_transition_allowed(old.state, new.state) then
      raise exception 'work order % cannot go from % to %', old.id, old.state, new.state
        using errcode = 'object_not_in_prerequisite_state';
    end if;

    -- Cancelling, reopening a completed job and reinstating a cancelled one each
    -- undo something a person relied on, so each says why.
    if (new.state = 'cancelled'
        or (old.state = 'complete' and new.state = 'in_progress')
        or old.state = 'cancelled')
       and (new.last_reason is null or btrim(new.last_reason) = '') then
      raise exception 'moving work order % from % to % needs a reason', old.id, old.state, new.state
        using errcode = 'check_violation';
    end if;

    if new.state = 'dispatched' and not exists (
      select 1 from work_order_assignments a
       where a.tenant_id = new.tenant_id and a.work_order_id = new.id and a.unassigned_at is null
    ) then
      raise exception 'work order % cannot be dispatched with nobody assigned', old.id
        using errcode = 'check_violation';
    end if;

    if new.state = 'complete' then
      select string_agg(f.title, ', ' order by wof.position, f.title) into missing
        from work_order_forms wof
        join forms f on f.tenant_id = wof.tenant_id and f.id = wof.form_id
       where wof.tenant_id = new.tenant_id
         and wof.work_order_id = new.id
         and wof.required
         and not exists (
           select 1 from submissions s
            where s.tenant_id = wof.tenant_id
              and s.work_order_id = wof.work_order_id
              and s.form_id = wof.form_id
              and s.status = 'submitted'
         );
      if missing is not null then
        raise exception 'work order % cannot be completed: required forms not submitted: %', old.id, missing
          using errcode = 'check_violation';
      end if;
    end if;

    new.state_changed_at := now();
    new.completed_at := case
      when new.state = 'complete' then now()
      when new.state = 'reviewed' then old.completed_at
    end;
    new.reviewed_at := case when new.state = 'reviewed' then now() end;
    new.cancelled_at := case when new.state = 'cancelled' then now() end;
  else
    if old.state in ('complete', 'reviewed', 'cancelled')
       and (new.customer_id, new.site_id, new.job_type_id, new.title, new.description, new.instructions,
            new.priority, new.due_from, new.due_by)
           is distinct from
           (old.customer_id, old.site_id, old.job_type_id, old.title, old.description, old.instructions,
            old.priority, old.due_from, old.due_by) then
      raise exception 'work order % is %; reopen it before changing it', old.id, old.state
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.state_changed_at := old.state_changed_at;
    new.completed_at := old.completed_at;
    new.reviewed_at := old.reviewed_at;
    new.cancelled_at := old.cancelled_at;
  end if;

  new.revision := old.revision + 1;
  return new;
end;
$$;

comment on function enforce_work_order_state() is
  'Refuses a work order change the state machine does not allow: a transition that is not in the table, cancelling or reopening without a reason, dispatching with nobody assigned, completing with required forms unsubmitted, or editing a closed job.';

-- Named to sort before work_orders_set_updated_at.
create trigger work_orders_enforce_state
  before insert or update on work_orders
  for each row execute function enforce_work_order_state();

create function record_work_order_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  changed text[] := '{}';
begin
  if tg_op = 'INSERT' then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
    values (new.tenant_id, new.id, 'created', new.last_actor,
            jsonb_build_object('reference', new.reference, 'state', new.state));
    return null;
  end if;

  if new.state is distinct from old.state then
    insert into public.work_order_events (tenant_id, work_order_id, kind, from_state, to_state, actor_id, reason)
    values (new.tenant_id, new.id, 'transitioned', old.state, new.state, new.last_actor, new.last_reason);
  end if;

  if (new.due_from, new.due_by) is distinct from (old.due_from, old.due_by) then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, reason, details)
    values (new.tenant_id, new.id, 'rescheduled', new.last_actor, new.last_reason,
            jsonb_build_object('from', jsonb_build_object('dueFrom', old.due_from, 'dueBy', old.due_by),
                               'to', jsonb_build_object('dueFrom', new.due_from, 'dueBy', new.due_by)));
  end if;

  if new.customer_id is distinct from old.customer_id then changed := array_append(changed, 'customer'); end if;
  if new.site_id is distinct from old.site_id then changed := array_append(changed, 'site'); end if;
  if new.job_type_id is distinct from old.job_type_id then changed := array_append(changed, 'jobType'); end if;
  if new.title is distinct from old.title then changed := array_append(changed, 'title'); end if;
  if new.description is distinct from old.description then changed := array_append(changed, 'description'); end if;
  if new.instructions is distinct from old.instructions then changed := array_append(changed, 'instructions'); end if;
  if new.priority is distinct from old.priority then changed := array_append(changed, 'priority'); end if;

  if cardinality(changed) > 0 then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
    values (new.tenant_id, new.id, 'updated', new.last_actor, jsonb_build_object('fields', to_jsonb(changed)));
  end if;

  return null;
end;
$$;

comment on function record_work_order_change() is
  'Writes work_order_events for creation, transitions, reschedules and edits. Security definer: the runtime role cannot write the history.';

create trigger work_orders_record_change
  after insert or update on work_orders
  for each row execute function record_work_order_change();

create function record_work_order_assignment() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.work_order_events (tenant_id, work_order_id, kind, user_id, actor_id, details)
    values (new.tenant_id, new.work_order_id, 'assigned', new.user_id, new.assigned_by,
            jsonb_build_object('lead', new.is_lead));
  elsif new.unassigned_at is not null and old.unassigned_at is null then
    insert into public.work_order_events (tenant_id, work_order_id, kind, user_id, actor_id)
    values (new.tenant_id, new.work_order_id, 'unassigned', new.user_id, new.unassigned_by);
  elsif new.is_lead is distinct from old.is_lead then
    insert into public.work_order_events (tenant_id, work_order_id, kind, user_id, actor_id, details)
    values (new.tenant_id, new.work_order_id, 'lead_changed', new.user_id, new.assigned_by,
            jsonb_build_object('lead', new.is_lead));
  end if;
  return null;
end;
$$;

comment on function record_work_order_assignment() is
  'Writes work_order_events when someone is assigned, unassigned, or made or unmade lead. Security definer, like record_work_order_change.';

create function guard_work_order_assignment() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.work_order_id is distinct from old.work_order_id or new.user_id is distinct from old.user_id
       or new.assigned_at is distinct from old.assigned_at then
      raise exception 'assignment % cannot be moved to another job or person', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if old.unassigned_at is not null then
      raise exception 'assignment % has ended; assign the person again instead', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;
  return new;
end;
$$;

create trigger work_order_assignments_guard
  before update on work_order_assignments
  for each row execute function guard_work_order_assignment();

create trigger work_order_assignments_record
  after insert or update on work_order_assignments
  for each row execute function record_work_order_assignment();

-- ---------------------------------------------------------------------------
-- submissions: the job a form was filled for
-- ---------------------------------------------------------------------------

alter table submissions
  add column work_order_id uuid,
  add constraint submissions_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict;

comment on column submissions.work_order_id is
  'The job this form was filled for, if any. Set when the draft is started and never changed; the form must be one of the job''s.';

create index submissions_work_order_idx on submissions (tenant_id, work_order_id, form_id)
  where work_order_id is not null;

create function guard_submission_work_order() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.work_order_id is distinct from old.work_order_id then
      raise exception 'submission % was filled for work order % and cannot be moved', old.id, old.work_order_id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    return new;
  end if;
  if new.work_order_id is not null and not exists (
    select 1 from work_order_forms wof
     where wof.tenant_id = new.tenant_id and wof.work_order_id = new.work_order_id and wof.form_id = new.form_id
  ) then
    raise exception 'form % is not one of work order %''s forms', new.form_id, new.work_order_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- After submissions_lifecycle, which sets form_id checks; named to sort after it.
create trigger submissions_work_order_guard
  before insert or update on submissions
  for each row execute function guard_submission_work_order();

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------

create table attachments (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  file_id        uuid        not null,
  customer_id    uuid,
  site_id        uuid,
  work_order_id  uuid,
  title          text        not null,
  kind           text        not null default 'other',
  added_by       uuid        not null,
  created_at     timestamptz not null default now(),
  removed_at     timestamptz,
  removed_by     uuid,

  constraint attachments_tenant_id_unique unique (tenant_id, id),
  constraint attachments_file_fk
    foreign key (tenant_id, file_id) references files (tenant_id, id) on delete restrict,
  constraint attachments_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint attachments_site_fk
    foreign key (tenant_id, site_id) references sites (tenant_id, id) on delete restrict,
  constraint attachments_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint attachments_one_owner check (num_nonnulls(customer_id, site_id, work_order_id) = 1),
  constraint attachments_title_present check (btrim(title) <> '' and char_length(title) <= 200),
  constraint attachments_kind_known check (kind in ('site_plan', 'manual', 'report', 'photo', 'other')),
  constraint attachments_removed_complete check ((removed_at is null) = (removed_by is null))
);

comment on table attachments is
  'A file from the ledger shown on a customer, a site or a work order: site plans, manuals, previous reports. Removed rather than deleted.';

create index attachments_customer_idx on attachments (tenant_id, customer_id) where customer_id is not null;
create index attachments_site_idx on attachments (tenant_id, site_id) where site_id is not null;
create index attachments_work_order_idx on attachments (tenant_id, work_order_id) where work_order_id is not null;
create index attachments_file_idx on attachments (tenant_id, file_id) where removed_at is null;

-- ---------------------------------------------------------------------------
-- saved_views
-- ---------------------------------------------------------------------------

create table saved_views (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete restrict,
  owner_id    uuid        not null,
  resource    text        not null,
  name        text        not null,
  filters     jsonb       not null,
  shared      boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint saved_views_tenant_id_unique unique (tenant_id, id),
  constraint saved_views_resource_known check (resource in ('work_orders')),
  constraint saved_views_name_present check (btrim(name) <> '' and char_length(name) <= 80),
  constraint saved_views_filters_shape check (jsonb_typeof(filters) = 'object')
);

create unique index saved_views_name_unique on saved_views (tenant_id, owner_id, resource, lower(name));

create trigger saved_views_set_updated_at
  before update on saved_views
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- imports
-- ---------------------------------------------------------------------------

create table imports (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete restrict,
  kind            text        not null,
  status          text        not null default 'pending',
  file_name       text        not null,
  source          text        not null,
  total_rows      integer     not null default 0,
  succeeded_rows  integer     not null default 0,
  failed_rows     integer     not null default 0,
  -- [{ "row": 12, "column": "site", "code": "not_found", "message": "…" }]
  errors          jsonb       not null default '[]',
  created_by      uuid        not null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,

  constraint imports_tenant_id_unique unique (tenant_id, id),
  constraint imports_kind_known check (kind in ('customers', 'sites', 'work_orders')),
  constraint imports_status_known check (status in ('pending', 'running', 'completed', 'failed')),
  constraint imports_source_size check (octet_length(source) <= 5242880),
  constraint imports_counts_sane
    check (total_rows >= 0 and succeeded_rows >= 0 and failed_rows >= 0 and succeeded_rows + failed_rows <= total_rows),
  constraint imports_errors_shape check (jsonb_typeof(errors) = 'array'),
  constraint imports_completed_matches_status
    check ((status in ('completed', 'failed')) = (completed_at is not null))
);

comment on table imports is
  'A CSV import and its outcome, row by row. Each row is written or refused on its own, so one bad row never aborts the file.';

create index imports_tenant_idx on imports (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- Append-or-revoke, as elsewhere: records are closed, archived, cancelled,
-- unassigned or removed, not deleted. The exceptions are a job type's form list
-- and a job's form list, which are configuration, and a person's saved views.

grant select, insert, update on customers to integr8_app;
grant select, insert, update on customer_contacts to integr8_app;
grant select, insert, update on sites to integr8_app;
grant select, insert, update on job_types to integr8_app;
grant select, insert, update, delete on job_type_forms to integr8_app;
grant select, insert, update on work_orders to integr8_app;
grant select, insert, update, delete on work_order_forms to integr8_app;
grant select, insert, update on work_order_checklist_items to integr8_app;
grant select, insert, update on work_order_assignments to integr8_app;
grant select, insert on work_order_comments to integr8_app;
grant select on work_order_events to integr8_app;
grant select, insert, update on attachments to integr8_app;
grant select, insert, update, delete on saved_views to integr8_app;
grant select, insert, update on imports to integr8_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

do $$
declare
  scoped text;
begin
  foreach scoped in array array[
    'customers', 'customer_contacts', 'sites', 'job_types', 'job_type_forms',
    'work_orders', 'work_order_forms', 'work_order_checklist_items', 'work_order_assignments',
    'work_order_comments', 'attachments', 'saved_views', 'imports'
  ] loop
    execute format('alter table %I enable row level security', scoped);
    execute format(
      'create policy %I on %I for all to integr8_app using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id())',
      scoped || '_isolation', scoped);
  end loop;
end;
$$;

alter table work_order_events enable row level security;
create policy work_order_events_isolation on work_order_events
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

-- The counter is reached only through assign_work_order_reference.
alter table work_order_counters enable row level security;
create policy work_order_counters_isolation on work_order_counters
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());
