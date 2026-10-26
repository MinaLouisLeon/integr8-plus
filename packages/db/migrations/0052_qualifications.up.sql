-- P26: skills and certificates.
--
-- A company keeps a list of the qualifications it cares about
-- (qualification_types): a skill, which never expires, or a certificate, which
-- has dates, a number and maybe a scan. People hold them (member_qualifications),
-- job types say which ones their jobs need (job_type_qualifications), and each
-- new job copies that list (work_order_qualifications), which the office can
-- then change for that job alone.
--
-- Qualifications belong to the company member, not to the HR employee profile:
-- the dispatcher needs them, and a company without the HR module needs them too.
--
-- The rule the board applies, in the API rather than here: for each requirement,
-- at least one person on a visit holds it, valid on the visit's dates. Nothing is
-- refused when nobody does. The dispatcher gives a reason and goes ahead, and the
-- reason is kept in work_order_qualification_overrides, which writes the job's
-- history. A rule that depends on today's date cannot be a constraint anyway: a
-- certificate that was valid when the visit was planned lapses on its own.
--
-- Renewing a certificate adds a new record; the old one stays, expired, so the
-- company can show what was held when. Records are removed rather than deleted.

-- ---------------------------------------------------------------------------
-- qualification_types
-- ---------------------------------------------------------------------------

create table qualification_types (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  name         text        not null,
  kind         text        not null,
  description  text,
  version      integer     not null default 1,
  created_by   uuid        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz,

  constraint qualification_types_tenant_id_unique unique (tenant_id, id),
  constraint qualification_types_kind_known check (kind in ('skill', 'certificate')),
  constraint qualification_types_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint qualification_types_description_length
    check (description is null or char_length(description) <= 1000)
);

comment on table qualification_types is
  'The skills and certificates a company tracks. A skill never expires; a certificate has dates. Archived rather than deleted.';

-- One live name per company, whatever its case.
create unique index qualification_types_name_unique
  on qualification_types (tenant_id, lower(btrim(name))) where archived_at is null;

create trigger qualification_types_set_updated_at
  before update on qualification_types
  for each row execute function set_updated_at();

create function guard_qualification_type() returns trigger
language plpgsql
as $$
begin
  if new.kind is distinct from old.kind then
    raise exception 'qualification type % keeps its kind; add a new one instead', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'qualification type % keeps its creator', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  new.version := old.version + 1;
  return new;
end;
$$;

comment on function guard_qualification_type() is
  'Keeps a qualification type''s kind, since records already held were checked against it. Counts versions.';

create trigger qualification_types_guard
  before update on qualification_types
  for each row execute function guard_qualification_type();

-- ---------------------------------------------------------------------------
-- member_qualifications
-- ---------------------------------------------------------------------------

create table member_qualifications (
  id                     uuid        primary key default gen_random_uuid(),
  tenant_id              uuid        not null references tenants (id) on delete restrict,
  user_id                uuid        not null,
  qualification_type_id  uuid        not null,
  -- The certificate's number, as printed on it.
  reference              text,
  issued_on              date,
  -- The last day it is valid. Null: it does not expire.
  expires_on             date,
  notes                  text,
  -- When the expiry alerts went out, so each goes once. Cleared when the dates change.
  expiry_warned_at       timestamptz,
  lapse_alerted_at       timestamptz,
  version                integer     not null default 1,
  created_by             uuid        not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  removed_at             timestamptz,
  removed_by             uuid,

  constraint member_qualifications_tenant_id_unique unique (tenant_id, id),
  constraint member_qualifications_member_fk
    foreign key (tenant_id, user_id) references tenant_users (tenant_id, user_id) on delete restrict,
  constraint member_qualifications_type_fk
    foreign key (tenant_id, qualification_type_id) references qualification_types (tenant_id, id) on delete restrict,
  constraint member_qualifications_dates_ordered
    check (issued_on is null or expires_on is null or expires_on >= issued_on),
  constraint member_qualifications_reference_length
    check (reference is null or char_length(reference) <= 120),
  constraint member_qualifications_notes_length
    check (notes is null or char_length(notes) <= 1000),
  constraint member_qualifications_removed_complete
    check ((removed_at is null) = (removed_by is null))
);

comment on table member_qualifications is
  'A skill or certificate a member holds. Renewal adds a record; the old one stays, expired. Removed rather than deleted.';

create index member_qualifications_member_idx
  on member_qualifications (tenant_id, user_id) where removed_at is null;
create index member_qualifications_type_idx
  on member_qualifications (tenant_id, qualification_type_id) where removed_at is null;
create index member_qualifications_expiry_idx
  on member_qualifications (tenant_id, expires_on) where removed_at is null and expires_on is not null;

create trigger member_qualifications_set_updated_at
  before update on member_qualifications
  for each row execute function set_updated_at();

create function guard_member_qualification() returns trigger
language plpgsql
as $$
declare
  type_kind text;
  type_archived timestamptz;
begin
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id
       or new.qualification_type_id is distinct from old.qualification_type_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'qualification record % keeps its person, type and creator', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if old.removed_at is not null then
      raise exception 'qualification record % was removed; add a new one instead', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    -- New dates: whoever is told about the expiry should hear about it again.
    if new.expires_on is distinct from old.expires_on then
      new.expiry_warned_at := null;
      new.lapse_alerted_at := null;
    end if;
    new.version := old.version + 1;
  else
    new.version := 1;
    new.expiry_warned_at := null;
    new.lapse_alerted_at := null;
  end if;

  select t.kind, t.archived_at into type_kind, type_archived
    from qualification_types t
   where t.tenant_id = new.tenant_id and t.id = new.qualification_type_id;
  if not found then
    -- The foreign key refuses it, with a clearer message than anything here.
    return new;
  end if;
  if tg_op = 'INSERT' and type_archived is not null then
    raise exception 'qualification type % is archived', new.qualification_type_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if type_kind = 'skill' and new.expires_on is not null then
    raise exception 'a skill does not expire'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function guard_member_qualification() is
  'Keeps a qualification record''s person and type, refuses changing a removed one or adding one of an archived type, refuses an expiry on a skill, and resets the expiry alerts when the dates change.';

create trigger member_qualifications_guard
  before insert or update on member_qualifications
  for each row execute function guard_member_qualification();

-- ---------------------------------------------------------------------------
-- What jobs need
-- ---------------------------------------------------------------------------

create table job_type_qualifications (
  tenant_id              uuid        not null references tenants (id) on delete restrict,
  job_type_id            uuid        not null,
  qualification_type_id  uuid        not null,
  created_by             uuid        not null,
  created_at             timestamptz not null default now(),

  primary key (tenant_id, job_type_id, qualification_type_id),
  constraint job_type_qualifications_job_type_fk
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id) on delete cascade,
  constraint job_type_qualifications_type_fk
    foreign key (tenant_id, qualification_type_id) references qualification_types (tenant_id, id) on delete restrict
);

comment on table job_type_qualifications is
  'The qualifications a job type''s jobs need. Copied to each new job, which can then change its own list.';

create table work_order_qualifications (
  tenant_id              uuid        not null references tenants (id) on delete restrict,
  work_order_id          uuid        not null,
  qualification_type_id  uuid        not null,
  added_by               uuid        not null,
  created_at             timestamptz not null default now(),

  primary key (tenant_id, work_order_id, qualification_type_id),
  constraint work_order_qualifications_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete cascade,
  constraint work_order_qualifications_type_fk
    foreign key (tenant_id, qualification_type_id) references qualification_types (tenant_id, id) on delete restrict
);

comment on table work_order_qualifications is
  'The qualifications one job needs: at least one person on each of its visits holds each of them.';

create index work_order_qualifications_type_idx
  on work_order_qualifications (tenant_id, qualification_type_id);

-- The phone shows what a job needs, so a change reaches it with the job.
create trigger work_order_qualifications_touch_sync
  after insert or update or delete on work_order_qualifications
  for each row execute function touch_sync('work_order', 'work_order_id');

-- ---------------------------------------------------------------------------
-- Going ahead anyway
-- ---------------------------------------------------------------------------

create table work_order_qualification_overrides (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  work_order_id  uuid        not null,
  visit_id       uuid        not null,
  reason         text        not null,
  -- What was missing, as the dispatcher was shown it: [{ qualificationTypeId, name }].
  missing        jsonb       not null,
  -- Who was on the visit when they went ahead.
  assignee_ids   uuid[]      not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  created_by     uuid        not null,
  created_at     timestamptz not null default now(),

  constraint work_order_qualification_overrides_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint work_order_qualification_overrides_visit_fk
    foreign key (tenant_id, visit_id) references work_order_visits (tenant_id, id) on delete restrict,
  constraint work_order_qualification_overrides_reason_length
    check (char_length(btrim(reason)) between 1 and 500),
  constraint work_order_qualification_overrides_missing_shape
    check (jsonb_typeof(missing) = 'array' and jsonb_array_length(missing) > 0)
);

comment on table work_order_qualification_overrides is
  'A dispatcher planned a visit where nobody held a required qualification, and said why. Append-only.';

create index work_order_qualification_overrides_work_order_idx
  on work_order_qualification_overrides (tenant_id, work_order_id, created_at);

-- Append-only, except while purge_tenant() (0015, 0030) removes the whole company.
create function reject_qualification_override_mutation() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and current_setting('integr8.purging', true) = old.tenant_id::text then
    return old;
  end if;
  raise exception 'work_order_qualification_overrides is append-only; % is not permitted', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

comment on function reject_qualification_override_mutation() is
  'Refuses changing or deleting an override, except deleting while its company is purged.';

create trigger work_order_qualification_overrides_append_only
  before update or delete on work_order_qualification_overrides
  for each row execute function reject_qualification_override_mutation();

alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off',
    'visit_scheduled', 'visit_rescheduled', 'visit_done', 'visit_cancelled', 'visit_assigned', 'visit_unassigned',
    'qualification_override'
  ));

create function record_qualification_override() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, reason, details)
  values (new.tenant_id, new.work_order_id, 'qualification_override', new.created_by, new.reason,
          jsonb_build_object('visitId', new.visit_id, 'startsAt', new.starts_at, 'endsAt', new.ends_at,
                             'missing', new.missing, 'assigneeIds', to_jsonb(new.assignee_ids)));
  return null;
end;
$$;

comment on function record_qualification_override() is
  'Writes the job''s history when a visit goes ahead without a required qualification. Security definer: the runtime role cannot write the history.';

create trigger work_order_qualification_overrides_record
  after insert on work_order_qualification_overrides
  for each row execute function record_qualification_override();

-- ---------------------------------------------------------------------------
-- A certificate's scan
-- ---------------------------------------------------------------------------

alter table attachments
  add column member_qualification_id uuid,
  add constraint attachments_member_qualification_fk
    foreign key (tenant_id, member_qualification_id) references member_qualifications (tenant_id, id),
  drop constraint attachments_one_owner,
  add constraint attachments_one_owner check (num_nonnulls(
    customer_id, site_id, work_order_id, asset_id, expense_claim_id, item_id, work_order_purchase_id,
    member_qualification_id) = 1);
create index attachments_member_qualification_idx on attachments (tenant_id, member_qualification_id)
  where member_qualification_id is not null;

-- ---------------------------------------------------------------------------
-- How early the company hears
-- ---------------------------------------------------------------------------

alter table tenant_settings
  add column qualification_warning_days integer not null default 30,
  add constraint tenant_settings_qualification_warning_days_bounds
    check (qualification_warning_days between 1 and 365);

comment on column tenant_settings.qualification_warning_days is
  'How many days before a certificate expires its holder and the managers are warned (0052).';

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------

grant select, insert, update on qualification_types to integr8_app;
grant select, insert, update on member_qualifications to integr8_app;
-- Requirement lists are sets: an entry is there or it is not.
grant select, insert, delete on job_type_qualifications to integr8_app;
grant select, insert, delete on work_order_qualifications to integr8_app;
grant select, insert on work_order_qualification_overrides to integr8_app;

alter table qualification_types enable row level security;
create policy qualification_types_isolation on qualification_types
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table member_qualifications enable row level security;
create policy member_qualifications_isolation on member_qualifications
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table job_type_qualifications enable row level security;
create policy job_type_qualifications_isolation on job_type_qualifications
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table work_order_qualifications enable row level security;
create policy work_order_qualifications_isolation on work_order_qualifications
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table work_order_qualification_overrides enable row level security;
create policy work_order_qualification_overrides_isolation on work_order_qualification_overrides
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
