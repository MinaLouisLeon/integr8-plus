-- 0008 - the submission lifecycle.
--
-- 0006 bound a submission to one published version and stopped there. P08 needs
-- the rest, and every rule below is one that must hold for every client and
-- every role, so each is enforced here rather than trusted to the API:
--
--   draft --submit--> submitted --reopen--> reopened --amend--> submitted
--
--   * Drafts live on the server, so a form started on a laptop can be finished
--     on another device. A draft's answers change freely.
--   * Submitted answers cannot change. Correcting one means reopening it with a
--     reason, then submitting the correction with a reason.
--   * Every submit, reopen and amendment is written to submission_events by a
--     trigger, with the answers as they were submitted. The runtime role cannot
--     write that table itself, and nobody can change or delete a row in it.
--     "No silent edits" is therefore not a convention the API keeps: an UPDATE
--     that would be silent is refused.
--   * Reportable answers are copied into submission_values, typed and indexed,
--     by the same trigger, whenever a submission becomes submitted. Which
--     answers are reportable is fixed per version at publish
--     (form_versions.reportable_fields, computed by @integr8/form-engine).
--
-- And the files those answers point at: media_objects records every upload, so
-- the API can refuse a submission that names a file nobody uploaded. Where the
-- bytes live is behind a storage interface in the API; P09 moves them to R2.
--
-- Postgres cannot give each company's forms their own generated columns without
-- running DDL at publish, so "JSONB plus generated columns for reportable
-- fields" is realised as a typed side table. The one generated column is the
-- full-text search vector over the answers.

-- ---------------------------------------------------------------------------
-- form_versions: which answers are reportable, fixed at publish
-- ---------------------------------------------------------------------------

alter table form_versions add column reportable_fields jsonb;

-- NOT VALID: versions published before this migration have no list and cannot
-- be given one, because a published version is immutable. They report nothing;
-- every version published from here on must carry one.
alter table form_versions
  add constraint form_versions_reportable_fields_shape
    check (reportable_fields is null or jsonb_typeof(reportable_fields) = 'array'),
  add constraint form_versions_reportable_fields_at_publish
    check (status = 'draft' or reportable_fields is not null) not valid;

comment on column form_versions.reportable_fields is
  'Set at publish from @integr8/form-engine reportableFields: [{field, type, multiple}]. Which answers of this version are copied into submission_values.';

-- ---------------------------------------------------------------------------
-- media_objects: every uploaded file
-- ---------------------------------------------------------------------------

create table media_objects (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  content_type  text        not null,
  byte_size     bigint      not null,
  -- Where the storage adapter keeps the bytes. Opaque to everything but the adapter.
  storage_key   text        not null,
  status        text        not null default 'pending',
  created_by    uuid        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  stored_at     timestamptz,

  constraint media_objects_tenant_id_unique unique (tenant_id, id),
  constraint media_objects_storage_key_unique unique (storage_key),
  constraint media_objects_status_known check (status in ('pending', 'stored')),
  constraint media_objects_stored_complete check ((status = 'stored') = (stored_at is not null)),
  constraint media_objects_content_type_format check (content_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  constraint media_objects_byte_size_positive check (byte_size > 0)
);

comment on table media_objects is
  'One uploaded file. Pending until the bytes are confirmed in storage; a submission may only reference a stored object of its own company.';

create index media_objects_tenant_idx on media_objects (tenant_id, created_at desc);

create trigger media_objects_set_updated_at
  before update on media_objects
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- submissions: status, drafts, revision, search
-- ---------------------------------------------------------------------------

alter table submissions
  add column form_id uuid,
  add column status text not null default 'submitted',
  add column revision integer not null default 1,
  add column last_actor uuid,
  add column last_reason text,
  add column amended_at timestamptz;

-- Every submission so far was submitted, by the person recorded, against a
-- version of a form it can be traced to.
update submissions s
   set form_id = v.form_id,
       last_actor = s.submitted_by
  from form_versions v
 where v.tenant_id = s.tenant_id and v.id = s.form_version_id;

alter table submissions
  alter column form_id set not null,
  alter column last_actor set not null,
  -- A draft has not been submitted yet.
  alter column submitted_at drop not null,
  alter column submitted_at drop default,
  add column search tsvector
    generated always as (jsonb_to_tsvector('simple'::regconfig, answers, '["string"]'::jsonb)) stored;

alter table submissions
  add constraint submissions_form_fk
    foreign key (tenant_id, form_id) references forms (tenant_id, id) on delete restrict,
  add constraint submissions_status_known check (status in ('draft', 'submitted', 'reopened')),
  -- Submitted at least once, and not a draft, are one fact: a reopened
  -- submission keeps the time it was first submitted.
  add constraint submissions_submitted_at_matches_status
    check ((status = 'draft') = (submitted_at is null)),
  add constraint submissions_revision_positive check (revision >= 1),
  add constraint submissions_reason_length check (last_reason is null or char_length(last_reason) <= 2000);

comment on column submissions.submitted_by is
  'The person filling the form in: who started the draft, and who submitted it.';
comment on column submissions.submitted_at is
  'When it was first submitted. Null while a draft; kept through reopening and amendment.';
comment on column submissions.revision is
  'Incremented by every change. A save or submit naming an older revision is refused, so two devices cannot overwrite each other.';
comment on column submissions.last_actor is
  'Who made the change being written. Set on every insert and update; submission_events records it.';
comment on column submissions.last_reason is
  'Why a reopening or amendment was made. Required for both, by trigger.';
comment on column submissions.search is
  'Generated: every string answer, for full-text search across submissions.';

create index submissions_form_idx on submissions (tenant_id, form_id, submitted_at desc) where status <> 'draft';
create index submissions_submitter_idx on submissions (tenant_id, submitted_by, updated_at desc);
create index submissions_search_idx on submissions using gin (search);

-- ---------------------------------------------------------------------------
-- submission_events: the history nobody can rewrite
-- ---------------------------------------------------------------------------

create table submission_events (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  submission_id  uuid        not null,
  sequence       integer     not null,
  kind           text        not null,
  -- The answers as submitted, for `submitted` and `amended`. A reopening changes no answers.
  answers        jsonb,
  actor_id       uuid        not null,
  reason         text,
  occurred_at    timestamptz not null default now(),

  constraint submission_events_submission_fk
    foreign key (tenant_id, submission_id) references submissions (tenant_id, id) on delete restrict,
  constraint submission_events_sequence_unique unique (submission_id, sequence),
  constraint submission_events_kind_known check (kind in ('submitted', 'reopened', 'amended')),
  constraint submission_events_answers_when_submitted
    check ((kind = 'reopened') = (answers is null)),
  constraint submission_events_reason_when_changed
    check (kind = 'submitted' or (reason is not null and btrim(reason) <> ''))
);

comment on table submission_events is
  'Append-only history of a submission: each submit, reopen and amendment, with the answers submitted. Written only by trigger; updates and deletes are refused for every role.';

create index submission_events_submission_idx on submission_events (tenant_id, submission_id, sequence);

create function reject_submission_events_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'submission_events is append-only; % is not permitted', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

create trigger submission_events_no_update
  before update on submission_events
  for each statement execute function reject_submission_events_mutation();

create trigger submission_events_no_delete
  before delete on submission_events
  for each statement execute function reject_submission_events_mutation();

create trigger submission_events_no_truncate
  before truncate on submission_events
  for each statement execute function reject_submission_events_mutation();

-- Submissions submitted before this migration get the event they would have had.
insert into submission_events (tenant_id, submission_id, sequence, kind, answers, actor_id, occurred_at)
select tenant_id, id, 1, 'submitted', answers, submitted_by, submitted_at
  from submissions;

-- ---------------------------------------------------------------------------
-- submission_values: reportable answers, typed and indexed
-- ---------------------------------------------------------------------------

create table submission_values (
  tenant_id        uuid        not null references tenants (id) on delete restrict,
  submission_id    uuid        not null,
  form_id          uuid        not null,
  form_version_id  uuid        not null,
  field_id         text        not null,
  -- Position within a multi-select answer; 0 for everything else.
  ordinal          integer     not null default 0,
  value_type       text        not null,
  value_text       text,
  value_number     numeric,
  value_date       date,
  value_time       time,
  value_timestamp  timestamptz,
  value_boolean    boolean,
  submitted_at     timestamptz not null,

  constraint submission_values_pk primary key (tenant_id, submission_id, field_id, ordinal),
  constraint submission_values_submission_fk
    foreign key (tenant_id, submission_id) references submissions (tenant_id, id) on delete restrict,
  constraint submission_values_type_known
    check (value_type in ('text', 'number', 'date', 'time', 'datetime', 'boolean')),
  -- Exactly the column the type names holds the value.
  constraint submission_values_one_value check (
    num_nonnulls(value_text, value_number, value_date, value_time, value_timestamp, value_boolean) = 1
    and case value_type
      when 'text' then value_text is not null
      when 'number' then value_number is not null
      when 'date' then value_date is not null
      when 'time' then value_time is not null
      when 'datetime' then value_timestamp is not null
      when 'boolean' then value_boolean is not null
    end
  )
);

comment on table submission_values is
  'The reportable answers of submitted submissions, one typed row per answer (per option for a multi-select). Maintained by trigger from submissions.answers; read-only to the runtime role.';

-- One index per kind of value, leading with what every filter names: the
-- company, the form and the field.
create index submission_values_text_idx on submission_values (tenant_id, form_id, field_id, value_text)
  where value_text is not null;
create index submission_values_number_idx on submission_values (tenant_id, form_id, field_id, value_number)
  where value_number is not null;
create index submission_values_date_idx on submission_values (tenant_id, form_id, field_id, value_date)
  where value_date is not null;
create index submission_values_time_idx on submission_values (tenant_id, form_id, field_id, value_time)
  where value_time is not null;
create index submission_values_timestamp_idx on submission_values (tenant_id, form_id, field_id, value_timestamp)
  where value_timestamp is not null;
create index submission_values_boolean_idx on submission_values (tenant_id, form_id, field_id, value_boolean)
  where value_boolean is not null;

-- ---------------------------------------------------------------------------
-- The lifecycle, enforced
-- ---------------------------------------------------------------------------

create function enforce_submission_lifecycle() returns trigger
language plpgsql
as $$
declare
  version_form uuid;
begin
  if new.last_actor is null then
    raise exception 'submission % was written without last_actor; every change names who made it', new.id
      using errcode = 'not_null_violation';
  end if;

  if tg_op = 'INSERT' then
    select form_id into version_form
      from form_versions
     where tenant_id = new.tenant_id and id = new.form_version_id;
    if new.form_id is distinct from version_form then
      raise exception 'submission % names form % but its version belongs to form %',
        new.id, new.form_id, version_form
        using errcode = 'check_violation';
    end if;
    if new.status = 'reopened' then
      raise exception 'a submission cannot be created reopened'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    -- Submitted in one step: the database says when, not the client.
    if new.status = 'submitted' then
      new.submitted_at := now();
    end if;
    return new;
  end if;

  if new.form_id is distinct from old.form_id then
    raise exception 'submission % belongs to form % and cannot be moved', old.id, old.form_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if new.submitted_by is distinct from old.submitted_by then
    raise exception 'submission % was filled by % and that cannot be reassigned', old.id, old.submitted_by
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The transitions that exist. Anything else is refused.
  if not (
       (old.status = new.status and old.status in ('draft', 'reopened'))
    or (old.status = 'draft' and new.status = 'submitted')
    or (old.status = 'submitted' and new.status = 'reopened')
    or (old.status = 'reopened' and new.status = 'submitted')
    or (old.status = 'submitted' and new.status = 'submitted' and new.answers = old.answers)
  ) then
    if old.status = 'submitted' and new.status = 'submitted' then
      raise exception 'submission % is submitted; its answers cannot change without reopening it', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    raise exception 'submission % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if old.status = 'submitted' and new.status = 'reopened'
     and (new.last_reason is null or btrim(new.last_reason) = '') then
    raise exception 'reopening submission % needs a reason', old.id
      using errcode = 'check_violation';
  end if;

  if old.status = 'reopened' and new.status = 'submitted' then
    if new.last_reason is null or btrim(new.last_reason) = '' then
      raise exception 'amending submission % needs a reason', old.id
        using errcode = 'check_violation';
    end if;
    new.amended_at := now();
  end if;

  if old.status = 'draft' and new.status = 'submitted' then
    new.submitted_at := now();
  end if;

  if new.submitted_at is distinct from old.submitted_at and old.submitted_at is not null then
    raise exception 'submission % was first submitted at %; that cannot change', old.id, old.submitted_at
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return new;
end;
$$;

comment on function enforce_submission_lifecycle() is
  'Refuses a submission change the lifecycle does not allow: editing submitted answers, skipping a state, moving it to another form or person, or reopening and amending without a reason.';

-- Named to sort before submissions_set_updated_at, so a refused change touches nothing.
create trigger submissions_lifecycle
  before insert or update on submissions
  for each row execute function enforce_submission_lifecycle();

-- Security definer: the runtime role holds no write privilege on either table
-- this writes, so nothing but this function can add history or report values.
-- search_path is pinned for the reason 0005 gives.
create function record_submission_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  event_kind text;
  next_sequence integer;
  reportable jsonb;
begin
  if tg_op = 'INSERT' then
    event_kind := case when new.status = 'submitted' then 'submitted' end;
  elsif old.status is distinct from new.status then
    event_kind := case
      when old.status = 'draft' then 'submitted'
      when new.status = 'reopened' then 'reopened'
      else 'amended'
    end;
  end if;

  if event_kind is null then
    return null;
  end if;

  select coalesce(max(sequence), 0) + 1 into next_sequence
    from public.submission_events
   where submission_id = new.id;

  insert into public.submission_events
    (tenant_id, submission_id, sequence, kind, answers, actor_id, reason)
  values
    (new.tenant_id, new.id, next_sequence, event_kind,
     case when event_kind = 'reopened' then null else new.answers end,
     new.last_actor,
     case when event_kind = 'submitted' then null else new.last_reason end);

  if event_kind = 'reopened' then
    -- The last submitted values stay reportable while a correction is drafted.
    return null;
  end if;

  delete from public.submission_values where submission_id = new.id;

  select reportable_fields into reportable
    from public.form_versions
   where tenant_id = new.tenant_id and id = new.form_version_id;

  insert into public.submission_values
    (tenant_id, submission_id, form_id, form_version_id, field_id, ordinal, value_type,
     value_text, value_number, value_date, value_time, value_timestamp, value_boolean, submitted_at)
  select new.tenant_id, new.id, new.form_id, new.form_version_id, entry.field, entry.ordinal, entry.type,
         case when entry.type = 'text' then left(entry.value, 512) end,
         case when entry.type = 'number' then entry.value::numeric end,
         case when entry.type = 'date' then entry.value::date end,
         case when entry.type = 'time' then entry.value::time end,
         case when entry.type = 'datetime' then entry.value::timestamptz end,
         case when entry.type = 'boolean' then entry.value::boolean end,
         new.submitted_at
    from (
      select spec ->> 'field' as field,
             spec ->> 'type' as type,
             0 as ordinal,
             new.answers ->> (spec ->> 'field') as value
        from jsonb_array_elements(coalesce(reportable, '[]'::jsonb)) as spec
       where not coalesce((spec ->> 'multiple')::boolean, false)
      union all
      select spec ->> 'field',
             spec ->> 'type',
             (option.ordinality - 1)::integer,
             option.value
        from jsonb_array_elements(coalesce(reportable, '[]'::jsonb)) as spec
        cross join lateral jsonb_array_elements_text(
          case when jsonb_typeof(new.answers -> (spec ->> 'field')) = 'array'
               then new.answers -> (spec ->> 'field')
               else '[]'::jsonb end
        ) with ordinality as option (value, ordinality)
       where coalesce((spec ->> 'multiple')::boolean, false)
    ) as entry
   where entry.value is not null and entry.value <> '';

  return null;
end;
$$;

comment on function record_submission_change() is
  'Writes submission_events for every submit, reopen and amendment, and refreshes submission_values when a submission becomes submitted. Security definer: the runtime role cannot write either table directly.';

create trigger submissions_record_change
  after insert or update on submissions
  for each row execute function record_submission_change();

-- Values for submissions made before this migration, against versions that
-- carry a reportable list. None do yet, so this is a no-op kept for symmetry.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select, insert, update on media_objects to integr8_app;
grant select on submission_events to integr8_app;
grant select on submission_values to integr8_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table media_objects enable row level security;

create policy media_objects_isolation on media_objects
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table submission_events enable row level security;

create policy submission_events_isolation on submission_events
  for select
  to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table submission_values enable row level security;

create policy submission_values_isolation on submission_values
  for select
  to integr8_app
  using (tenant_id = app_current_tenant_id());
