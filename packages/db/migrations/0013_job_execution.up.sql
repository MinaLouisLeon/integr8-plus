-- 0013 — running a working day from the phone (P14).
--
--   * When things happened. A job moved on offline is stamped with when the phone
--     recorded it, not when it synced: the API sets integr8.happened_at for the
--     transaction, and the trigger uses it within bounds (never in the future,
--     never before the job's previous state change, never more than 31 days ago).
--     Each event keeps recorded_at, when the server learned of it.
--   * The working day. shifts: an engineer clocks in and out; one open shift each.
--   * Before and after photos. A job type asks for a number of each; a job copies
--     the numbers; photos are the job's attachments with a stage.
--   * Customer sign-off. A signature with the signer's name and role, or why nobody
--     could sign. A job type can require it.
--   * Completion refuses missing photos and a missing sign-off, as it refuses
--     missing forms.
--   * Push devices, and a job queued for each event a crew should hear about.

-- ---------------------------------------------------------------------------
-- When it happened
-- ---------------------------------------------------------------------------

alter table work_order_events
  add column recorded_at timestamptz not null default now();

comment on column work_order_events.occurred_at is
  'When it happened. For a change a phone made offline, when the phone recorded it; otherwise when it was written.';
comment on column work_order_events.recorded_at is
  'When the server wrote it.';

create function work_order_happened_at(previous timestamptz) returns timestamptz
language plpgsql
stable
as $$
declare
  claimed text := current_setting('integr8.happened_at', true);
  happened timestamptz;
begin
  if claimed is null or claimed = '' then
    return now();
  end if;
  happened := claimed::timestamptz;
  return least(now(), greatest(happened, coalesce(previous, happened), now() - interval '31 days'));
end;
$$;

comment on function work_order_happened_at(timestamptz) is
  'The time a state change happened: integr8.happened_at when the API set it for a change recorded offline, kept between the previous state change and now; otherwise now().';

-- ---------------------------------------------------------------------------
-- Before and after photos, and sign-off, on job types and jobs
-- ---------------------------------------------------------------------------

alter table job_types
  add column before_photos smallint not null default 0,
  add column after_photos smallint not null default 0,
  add column signature_required boolean not null default false,
  add constraint job_types_photo_counts check (before_photos between 0 and 20 and after_photos between 0 and 20);

comment on column job_types.before_photos is 'Photos an engineer takes before starting work. Copied to each new job.';
comment on column job_types.after_photos is 'Photos an engineer takes when the work is done. Copied to each new job.';
comment on column job_types.signature_required is 'Whether a job of this type needs the customer to sign off before completing.';

alter table work_orders
  add column before_photos smallint not null default 0,
  add column after_photos smallint not null default 0,
  add column signature_required boolean not null default false,
  add column signed_off_at timestamptz,
  add column signed_off_by uuid,
  add column signoff_file_id uuid,
  add column signoff_name text,
  add column signoff_role text,
  add column signoff_unavailable_reason text,
  add constraint work_orders_photo_counts check (before_photos between 0 and 20 and after_photos between 0 and 20),
  add constraint work_orders_signoff_file_fk
    foreign key (tenant_id, signoff_file_id) references files (tenant_id, id) on delete restrict,
  add constraint work_orders_signoff_shape check (
    (signed_off_at is null
      and signed_off_by is null and signoff_file_id is null and signoff_name is null
      and signoff_role is null and signoff_unavailable_reason is null)
    or (signed_off_at is not null and signed_off_by is not null and (
      -- Signed: a signature and who signed.
      (signoff_file_id is not null and btrim(coalesce(signoff_name, '')) <> ''
        and char_length(signoff_name) <= 200 and coalesce(char_length(signoff_role), 0) <= 100
        and signoff_unavailable_reason is null)
      -- Nobody could sign, and why.
      or (signoff_file_id is null and signoff_name is null and signoff_role is null
        and btrim(coalesce(signoff_unavailable_reason, '')) <> ''
        and char_length(signoff_unavailable_reason) <= 2000)
    ))
  );

comment on column work_orders.signed_off_at is
  'When the customer signed off, by the phone that recorded it; or when the engineer recorded why nobody could.';

alter table attachments
  add column stage text,
  add constraint attachments_stage_known check (stage is null or stage in ('before', 'after')),
  add constraint attachments_stage_is_job_photo check (stage is null or (work_order_id is not null and kind = 'photo'));

comment on column attachments.stage is 'For a job photo: taken before the work started, or after it was done.';

create index attachments_work_order_stage_idx on attachments (tenant_id, work_order_id, stage)
  where stage is not null and removed_at is null;

alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off'
  ));

-- The state machine refuses completion without the photos and the sign-off, and
-- stamps a change made offline with when it happened. Otherwise as in 0010.
create or replace function enforce_work_order_state() returns trigger
language plpgsql
as $$
declare
  missing text;
  happened timestamptz;
  photos_before integer;
  photos_after integer;
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

      select count(*) filter (where a.stage = 'before'), count(*) filter (where a.stage = 'after')
        into photos_before, photos_after
        from attachments a
       where a.tenant_id = new.tenant_id and a.work_order_id = new.id and a.removed_at is null;
      if photos_before < new.before_photos or photos_after < new.after_photos then
        raise exception 'work order % cannot be completed: photos missing (before % of %, after % of %)',
          old.id, photos_before, new.before_photos, photos_after, new.after_photos
          using errcode = 'check_violation';
      end if;

      if new.signature_required and new.signed_off_at is null then
        raise exception 'work order % cannot be completed: the customer has not signed off', old.id
          using errcode = 'check_violation';
      end if;
    end if;

    -- When it happened: now, or when a phone recorded it offline (0013).
    happened := work_order_happened_at(old.state_changed_at);
    new.state_changed_at := happened;
    new.completed_at := case
      when new.state = 'complete' then happened
      when new.state = 'reviewed' then old.completed_at
    end;
    new.reviewed_at := case when new.state = 'reviewed' then happened end;
    new.cancelled_at := case when new.state = 'cancelled' then happened end;
  else
    if old.state in ('complete', 'reviewed', 'cancelled')
       and (new.customer_id, new.site_id, new.job_type_id, new.title, new.description, new.instructions,
            new.priority, new.due_from, new.due_by, new.before_photos, new.after_photos,
            new.signature_required, new.signed_off_at, new.signoff_file_id, new.signoff_name,
            new.signoff_role, new.signoff_unavailable_reason, new.signed_off_by)
           is distinct from
           (old.customer_id, old.site_id, old.job_type_id, old.title, old.description, old.instructions,
            old.priority, old.due_from, old.due_by, old.before_photos, old.after_photos,
            old.signature_required, old.signed_off_at, old.signoff_file_id, old.signoff_name,
            old.signoff_role, old.signoff_unavailable_reason, old.signed_off_by) then
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

-- The history records when a change happened, and each sign-off. Otherwise as in 0010.
create or replace function record_work_order_change() returns trigger
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
    insert into public.work_order_events (tenant_id, work_order_id, kind, from_state, to_state, actor_id, reason, occurred_at)
    values (new.tenant_id, new.id, 'transitioned', old.state, new.state, new.last_actor, new.last_reason,
            new.state_changed_at);
  end if;

  if (new.due_from, new.due_by) is distinct from (old.due_from, old.due_by) then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, reason, details)
    values (new.tenant_id, new.id, 'rescheduled', new.last_actor, new.last_reason,
            jsonb_build_object('from', jsonb_build_object('dueFrom', old.due_from, 'dueBy', old.due_by),
                               'to', jsonb_build_object('dueFrom', new.due_from, 'dueBy', new.due_by)));
  end if;

  if new.signed_off_at is not null
     and (new.signed_off_at, new.signoff_file_id, new.signoff_name, new.signoff_role, new.signoff_unavailable_reason)
         is distinct from
         (old.signed_off_at, old.signoff_file_id, old.signoff_name, old.signoff_role, old.signoff_unavailable_reason) then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details, occurred_at)
    values (new.tenant_id, new.id, 'signed_off', new.signed_off_by,
            jsonb_build_object('name', new.signoff_name, 'role', new.signoff_role,
                               'fileId', new.signoff_file_id, 'unavailableReason', new.signoff_unavailable_reason),
            new.signed_off_at);
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

-- ---------------------------------------------------------------------------
-- The working day
-- ---------------------------------------------------------------------------

create table shifts (
  -- Chosen by the phone that clocked in, so a resend finds it.
  id              uuid        primary key,
  tenant_id       uuid        not null references tenants (id) on delete restrict,
  user_id         uuid        not null,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  start_location  jsonb,
  end_location    jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint shifts_tenant_id_unique unique (tenant_id, id),
  constraint shifts_member_fk
    foreign key (tenant_id, user_id) references tenant_users (tenant_id, user_id) on delete restrict,
  constraint shifts_ends_after_start check (ended_at is null or ended_at >= started_at),
  constraint shifts_at_most_a_week check (ended_at is null or ended_at - started_at <= interval '7 days'),
  constraint shifts_start_location_shape check (start_location is null
    or (
      jsonb_typeof(start_location) = 'object'
      and (
        (start_location ->> 'status' = 'captured'
          and start_location ?& array['latitude', 'longitude', 'capturedAt'])
        or start_location ->> 'status' in ('denied', 'unavailable')
      )
    )),
  constraint shifts_end_location_shape check (end_location is null
    or (
      jsonb_typeof(end_location) = 'object'
      and (
        (end_location ->> 'status' = 'captured'
          and end_location ?& array['latitude', 'longitude', 'capturedAt'])
        or end_location ->> 'status' in ('denied', 'unavailable')
      )
    )),
  constraint shifts_end_location_when_ended check (ended_at is not null or end_location is null)
);

comment on table shifts is
  'An engineer''s working day: clocked in and out on the phone, at the times the phone recorded. One open shift per person.';

create unique index shifts_one_open_per_person on shifts (tenant_id, user_id) where ended_at is null;
create index shifts_person_idx on shifts (tenant_id, user_id, started_at desc);

create trigger shifts_set_updated_at
  before update on shifts
  for each row execute function set_updated_at();

create function protect_shift() returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id or new.started_at is distinct from old.started_at
     or new.start_location is distinct from old.start_location then
    raise exception 'shift % keeps who worked it and when it started', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.ended_at is not null
     and (new.ended_at, new.end_location) is distinct from (old.ended_at, old.end_location) then
    raise exception 'shift % has ended; its end cannot change', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

comment on function protect_shift() is
  'Refuses changing who worked a shift or when it started, and changing a shift once it has ended.';

create trigger shifts_protect
  before update on shifts
  for each row execute function protect_shift();

-- ---------------------------------------------------------------------------
-- Push notifications
-- ---------------------------------------------------------------------------

create table push_devices (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants (id) on delete restrict,
  user_id             uuid        not null,
  -- The session that registered it: a revoked or expired session gets no pushes.
  session_id          uuid        not null,
  token               text        not null,
  platform            text        not null,
  device_label        text,
  created_at          timestamptz not null default now(),
  last_registered_at  timestamptz not null default now(),
  disabled_at         timestamptz,
  disabled_reason     text,

  constraint push_devices_tenant_id_unique unique (tenant_id, id),
  constraint push_devices_token_unique unique (tenant_id, token),
  constraint push_devices_member_fk
    foreign key (tenant_id, user_id) references tenant_users (tenant_id, user_id) on delete restrict,
  constraint push_devices_session_fk
    foreign key (tenant_id, session_id) references sessions (tenant_id, id) on delete cascade,
  constraint push_devices_token_shape check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$'),
  constraint push_devices_platform_known check (platform in ('ios', 'android')),
  constraint push_devices_label_length check (coalesce(char_length(device_label), 0) <= 200),
  constraint push_devices_disabled_pair check ((disabled_at is null) = (disabled_reason is null)),
  constraint push_devices_disabled_reason_known
    check (disabled_reason is null or disabled_reason in ('signed_out', 'not_registered', 'replaced'))
);

comment on table push_devices is
  'Where to send a person push notifications: an Expo push token per phone, tied to the session that registered it.';

create index push_devices_person_idx on push_devices (tenant_id, user_id) where disabled_at is null;

-- Each event a crew should hear about queues a job; the worker decides who and what.
create function queue_work_order_push() returns trigger
language plpgsql
as $$
begin
  if new.kind in ('assigned', 'rescheduled')
     or (new.kind = 'transitioned' and new.to_state in ('dispatched', 'cancelled'))
     or (new.kind = 'updated' and new.details -> 'fields' ? 'priority') then
    insert into public.jobs (tenant_id, queue, payload, max_attempts)
    values (new.tenant_id, 'push.work_order_event', jsonb_build_object('eventId', new.id), 3);
  end if;
  return null;
end;
$$;

comment on function queue_work_order_push() is
  'Queues push.work_order_event for an assignment, a reschedule, a dispatch or cancellation, and a priority change.';

create trigger work_order_events_queue_push
  after insert on work_order_events
  for each row execute function queue_work_order_push();

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------

grant select, insert, update on shifts to integr8_app;
grant select, insert, update on push_devices to integr8_app;

alter table shifts enable row level security;

create policy shifts_isolation on shifts
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table push_devices enable row level security;

create policy push_devices_isolation on push_devices
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
