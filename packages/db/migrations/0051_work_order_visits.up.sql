-- P25: visits, the scheduling board's unit of planning.
--
-- A job can take several days and several trips. Each trip is a visit: a start,
-- an end and the people from the job's crew who go. The job keeps its own
-- workflow (scheduled → … → complete); a visit is only planned, done or
-- cancelled.
--
-- The rules the board relies on, enforced here for every client:
--
-- 1. **Nobody is double-booked across jobs.** Each person on a visit is a row in
--    work_order_visit_assignees carrying a copy of the visit's times, and an
--    exclusion constraint refuses two planned visits of *different* jobs that
--    overlap for the same person. Overlapping visits of the same job are allowed
--    (two halves of a crew working the same site). Being a constraint, it holds
--    even when two dispatchers drop a visit at the same moment.
-- 2. **Only the job's crew goes on its visits.** Taking someone off the crew
--    takes them off the job's planned visits.
-- 3. **A closed job has no planned visits.** Cancelling a job cancels them;
--    completing it marks those already started done and cancels the rest.
-- 4. **Done and cancelled are final.** A visit that happened, or was called
--    off, is history.
--
-- Work outside office hours is not a conflict: companies run 24/7 teams and
-- flexible hours, so the database has no opinion on it.
--
-- Every visit change touches its job in sync_touches, so a phone's next pull
-- brings the job back with its visits, and writes work_order_events, so the
-- job's history and push notifications cover visits too.

-- btree_gist lets the exclusion constraint mix equality on uuids with overlap on
-- time ranges. Kept in its own schema, out of public, and left installed on the
-- way down: it is harmless, and something else may come to use it.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- work_order_visits
-- ---------------------------------------------------------------------------

create table work_order_visits (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete restrict,
  work_order_id   uuid        not null,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          text        not null default 'planned',
  notes           text,
  completed_at    timestamptz,
  completed_by    uuid,
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text,
  last_actor      uuid        not null,
  revision        integer     not null default 1,
  created_by      uuid        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint work_order_visits_tenant_id_unique unique (tenant_id, id),
  constraint work_order_visits_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint work_order_visits_status_known check (status in ('planned', 'done', 'cancelled')),
  constraint work_order_visits_ends_after_start check (ends_at > starts_at),
  -- A visit is one trip. Longer work is several visits.
  constraint work_order_visits_at_most_a_week check (ends_at - starts_at <= interval '7 days'),
  constraint work_order_visits_notes_length check (notes is null or char_length(notes) <= 2000),
  constraint work_order_visits_done_complete
    check ((status = 'done') = (completed_at is not null and completed_by is not null)),
  constraint work_order_visits_cancelled_complete
    check ((status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null)),
  constraint work_order_visits_reason_when_cancelled
    check (cancel_reason is null or status = 'cancelled'),
  constraint work_order_visits_cancel_reason_length
    check (cancel_reason is null or char_length(cancel_reason) <= 500)
);

comment on table work_order_visits is
  'One trip to do a job: when, and (in work_order_visit_assignees) who. A job may have several. Planned, done or cancelled; done and cancelled are final.';

create index work_order_visits_starts_idx on work_order_visits (tenant_id, starts_at);
create index work_order_visits_work_order_idx on work_order_visits (tenant_id, work_order_id, starts_at);

create trigger work_order_visits_set_updated_at
  before update on work_order_visits
  for each row execute function set_updated_at();

create function guard_work_order_visit() returns trigger
language plpgsql
as $$
declare
  job_state text;
begin
  if tg_op = 'UPDATE' then
    if new.work_order_id is distinct from old.work_order_id
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'visit % keeps its job and creator', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if old.status <> 'planned' then
      raise exception 'visit % is %; it can no longer change', old.id, old.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.revision := old.revision + 1;
  else
    if new.status <> 'planned' then
      raise exception 'a visit starts planned, not %', new.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    new.revision := 1;
  end if;

  if new.status = 'planned' then
    select w.state into job_state
      from work_orders w
     where w.tenant_id = new.tenant_id and w.id = new.work_order_id;
    if job_state in ('complete', 'reviewed', 'cancelled') then
      raise exception 'work order % is %; it cannot have planned visits', new.work_order_id, job_state
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;
  return new;
end;
$$;

comment on function guard_work_order_visit() is
  'Refuses moving a visit to another job, changing a visit that is done or cancelled, and planning a visit on a closed job. Counts revisions.';

create trigger work_order_visits_guard
  before insert or update on work_order_visits
  for each row execute function guard_work_order_visit();

-- ---------------------------------------------------------------------------
-- work_order_visit_assignees
-- ---------------------------------------------------------------------------

create table work_order_visit_assignees (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  visit_id       uuid        not null,
  user_id        uuid        not null,
  -- Copied from the visit by trigger, whatever the writer sends, so the
  -- exclusion constraint below can see times and jobs side by side.
  work_order_id  uuid        not null,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  planned        boolean     not null,
  assigned_by    uuid        not null,
  assigned_at    timestamptz not null default now(),
  -- Removed rather than deleted, so the history says who took someone off.
  removed_at     timestamptz,
  removed_by     uuid,

  constraint work_order_visit_assignees_tenant_id_unique unique (tenant_id, id),
  constraint work_order_visit_assignees_visit_fk
    foreign key (tenant_id, visit_id) references work_order_visits (tenant_id, id) on delete restrict,
  constraint work_order_visit_assignees_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint work_order_visit_assignees_member_fk
    foreign key (tenant_id, user_id) references tenant_users (tenant_id, user_id) on delete restrict,
  constraint work_order_visit_assignees_removed_complete
    check ((removed_at is null) = (removed_by is null)),
  constraint work_order_visit_assignees_no_double_booking
    exclude using gist (
      tenant_id with =,
      user_id with =,
      work_order_id with <>,
      tstzrange(starts_at, ends_at, '[)') with &&
    ) where (planned and removed_at is null)
);

comment on table work_order_visit_assignees is
  'Who goes on a visit. Carries a copy of the visit''s times so that nobody can be on two overlapping planned visits of different jobs.';
comment on constraint work_order_visit_assignees_no_double_booking on work_order_visit_assignees is
  'The same person on two overlapping planned visits of different jobs. Visits of the same job may overlap.';

create unique index work_order_visit_assignees_current_unique
  on work_order_visit_assignees (tenant_id, visit_id, user_id) where removed_at is null;
create index work_order_visit_assignees_person_idx
  on work_order_visit_assignees (tenant_id, user_id, starts_at) where removed_at is null;
create index work_order_visit_assignees_work_order_idx
  on work_order_visit_assignees (tenant_id, work_order_id, user_id) where removed_at is null;

create function guard_work_order_visit_assignee() returns trigger
language plpgsql
as $$
declare
  visit record;
begin
  if tg_op = 'UPDATE' then
    if new.visit_id is distinct from old.visit_id or new.user_id is distinct from old.user_id
       or new.assigned_at is distinct from old.assigned_at or new.assigned_by is distinct from old.assigned_by then
      raise exception 'visit assignment % cannot be moved to another visit or person', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if old.removed_at is not null and new.removed_at is distinct from old.removed_at then
      raise exception 'visit assignment % has ended; add the person again instead', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  select v.work_order_id, v.starts_at, v.ends_at, v.status into visit
    from work_order_visits v
   where v.tenant_id = new.tenant_id and v.id = new.visit_id;
  if not found then
    -- The foreign key refuses it, with a clearer message than anything here.
    return new;
  end if;

  if tg_op = 'INSERT' then
    if visit.status <> 'planned' then
      raise exception 'visit % is %; nobody can be added to it', new.visit_id, visit.status
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    if not exists (
      select 1 from work_order_assignments a
       where a.tenant_id = new.tenant_id and a.work_order_id = visit.work_order_id
         and a.user_id = new.user_id and a.unassigned_at is null
    ) then
      raise exception 'user % is not on the crew of work order %', new.user_id, visit.work_order_id
        using errcode = 'check_violation';
    end if;
  end if;

  new.work_order_id := visit.work_order_id;
  new.starts_at := visit.starts_at;
  new.ends_at := visit.ends_at;
  new.planned := visit.status = 'planned';
  return new;
end;
$$;

comment on function guard_work_order_visit_assignee() is
  'Keeps a visit assignment''s copy of the visit''s job, times and status true, refuses moving it, and admits only the job''s current crew to a planned visit.';

create trigger work_order_visit_assignees_guard
  before insert or update on work_order_visit_assignees
  for each row execute function guard_work_order_visit_assignee();

-- A visit's new times or status reach its assignments, and through them the
-- exclusion constraint: moving a visit onto someone's other job fails here.
create function propagate_work_order_visit() returns trigger
language plpgsql
as $$
begin
  if (new.starts_at, new.ends_at, new.status) is distinct from (old.starts_at, old.ends_at, old.status) then
    update work_order_visit_assignees a
       set starts_at = new.starts_at
     where a.tenant_id = new.tenant_id and a.visit_id = new.id and a.removed_at is null;
  end if;
  return null;
end;
$$;

comment on function propagate_work_order_visit() is
  'Refreshes a visit''s assignments after its times or status change; their guard copies the new values in.';

create trigger work_order_visits_propagate
  after update on work_order_visits
  for each row execute function propagate_work_order_visit();

-- ---------------------------------------------------------------------------
-- Following the job
-- ---------------------------------------------------------------------------

-- Taken off the crew: taken off the job's planned visits.
create function remove_unassigned_from_visits() returns trigger
language plpgsql
as $$
begin
  if new.unassigned_at is not null and old.unassigned_at is null then
    update work_order_visit_assignees a
       set removed_at = new.unassigned_at, removed_by = new.unassigned_by
     where a.tenant_id = new.tenant_id and a.work_order_id = new.work_order_id
       and a.user_id = new.user_id and a.planned and a.removed_at is null;
  end if;
  return null;
end;
$$;

comment on function remove_unassigned_from_visits() is
  'Takes a person off a job''s planned visits when they are taken off its crew.';

create trigger work_order_assignments_leave_visits
  after update on work_order_assignments
  for each row execute function remove_unassigned_from_visits();

-- A closed job: started visits are done, the rest are called off.
create function close_work_order_visits() returns trigger
language plpgsql
as $$
begin
  if new.state is distinct from old.state and new.state in ('complete', 'cancelled') then
    update work_order_visits v
       set status = 'done', completed_at = least(now(), v.ends_at), completed_by = new.last_actor,
           last_actor = new.last_actor
     where v.tenant_id = new.tenant_id and v.work_order_id = new.id and v.status = 'planned'
       and new.state = 'complete' and v.starts_at <= now();
    update work_order_visits v
       set status = 'cancelled', cancelled_at = now(), cancelled_by = new.last_actor,
           cancel_reason = case when new.state = 'complete' then 'Job completed' else 'Job cancelled' end,
           last_actor = new.last_actor
     where v.tenant_id = new.tenant_id and v.work_order_id = new.id and v.status = 'planned';
  end if;
  return null;
end;
$$;

comment on function close_work_order_visits() is
  'When a job is completed, marks its started planned visits done and cancels the rest; when it is cancelled, cancels them all.';

create trigger work_orders_close_visits
  after update on work_orders
  for each row execute function close_work_order_visits();

-- ---------------------------------------------------------------------------
-- History and push notifications
-- ---------------------------------------------------------------------------

alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off',
    'visit_scheduled', 'visit_rescheduled', 'visit_done', 'visit_cancelled', 'visit_assigned', 'visit_unassigned'
  )),
  drop constraint work_order_events_person_when_assignment,
  add constraint work_order_events_person_when_assignment
    check ((kind in ('assigned', 'unassigned', 'lead_changed', 'visit_assigned', 'visit_unassigned'))
           = (user_id is not null));

create function record_work_order_visit_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  times jsonb := jsonb_build_object('visitId', new.id, 'startsAt', new.starts_at, 'endsAt', new.ends_at);
begin
  if tg_op = 'INSERT' then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
    values (new.tenant_id, new.work_order_id, 'visit_scheduled', new.created_by, times);
    return null;
  end if;

  if new.status = 'done' and old.status <> 'done' then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details, occurred_at)
    values (new.tenant_id, new.work_order_id, 'visit_done', new.completed_by, times, new.completed_at);
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    -- Called off because the job closed: the job's own event says so.
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, reason, details)
    values (new.tenant_id, new.work_order_id, 'visit_cancelled', new.cancelled_by, new.cancel_reason,
            times || jsonb_build_object('viaJob', exists (
              select 1 from public.work_orders w
               where w.tenant_id = new.tenant_id and w.id = new.work_order_id
                 and w.state in ('complete', 'reviewed', 'cancelled'))));
  elsif (new.starts_at, new.ends_at) is distinct from (old.starts_at, old.ends_at) then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
    values (new.tenant_id, new.work_order_id, 'visit_rescheduled', new.last_actor,
            times || jsonb_build_object('from', jsonb_build_object('startsAt', old.starts_at, 'endsAt', old.ends_at)));
  end if;
  return null;
end;
$$;

comment on function record_work_order_visit_change() is
  'Writes work_order_events when a visit is scheduled, moved, done or cancelled. Security definer: the runtime role cannot write the history.';

create trigger work_order_visits_record
  after insert or update on work_order_visits
  for each row execute function record_work_order_visit_change();

create function record_work_order_visit_assignee() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  visit record;
  -- Taken off because they left the crew: the crew's own 'unassigned' event
  -- already says so, and already tells them.
  via_crew boolean;
begin
  select v.starts_at, v.ends_at into visit
    from public.work_order_visits v
   where v.tenant_id = new.tenant_id and v.id = new.visit_id;

  if tg_op = 'INSERT' then
    insert into public.work_order_events (tenant_id, work_order_id, kind, user_id, actor_id, details)
    values (new.tenant_id, new.work_order_id, 'visit_assigned', new.user_id, new.assigned_by,
            jsonb_build_object('visitId', new.visit_id, 'startsAt', visit.starts_at, 'endsAt', visit.ends_at));
  elsif new.removed_at is not null and old.removed_at is null then
    via_crew := exists (
      select 1 from public.work_order_assignments a
       where a.tenant_id = new.tenant_id and a.work_order_id = new.work_order_id
         and a.user_id = new.user_id and a.unassigned_at = new.removed_at
    ) and not exists (
      select 1 from public.work_order_assignments a
       where a.tenant_id = new.tenant_id and a.work_order_id = new.work_order_id
         and a.user_id = new.user_id and a.unassigned_at is null
    );
    insert into public.work_order_events (tenant_id, work_order_id, kind, user_id, actor_id, details)
    values (new.tenant_id, new.work_order_id, 'visit_unassigned', new.user_id, new.removed_by,
            jsonb_build_object('visitId', new.visit_id, 'startsAt', visit.starts_at, 'endsAt', visit.ends_at,
                               'viaCrew', via_crew));
  end if;
  return null;
end;
$$;

comment on function record_work_order_visit_assignee() is
  'Writes work_order_events when someone is added to or taken off a visit. Security definer, like record_work_order_assignment.';

create trigger work_order_visit_assignees_record
  after insert or update on work_order_visit_assignees
  for each row execute function record_work_order_visit_assignee();

-- As in 0013, plus visit events. A visit taken off someone because they left the
-- crew, or called off because its job closed, is not pushed: the job's own event
-- already was.
create or replace function queue_work_order_push() returns trigger
language plpgsql
as $$
begin
  if new.kind in ('assigned', 'rescheduled', 'visit_scheduled', 'visit_rescheduled', 'visit_assigned')
     or (new.kind = 'visit_cancelled' and not coalesce((new.details ->> 'viaJob')::boolean, false))
     or (new.kind = 'visit_unassigned' and not coalesce((new.details ->> 'viaCrew')::boolean, false))
     or (new.kind = 'transitioned' and new.to_state in ('dispatched', 'cancelled'))
     or (new.kind = 'updated' and new.details -> 'fields' ? 'priority') then
    insert into public.jobs (tenant_id, queue, payload, max_attempts)
    values (new.tenant_id, 'push.work_order_event', jsonb_build_object('eventId', new.id), 3);
  end if;
  return null;
end;
$$;

comment on function queue_work_order_push() is
  'Queues push.work_order_event for an assignment, a reschedule, a dispatch or cancellation, a priority change, and a visit scheduled, moved, cancelled, or given or taken from someone.';

-- ---------------------------------------------------------------------------
-- Sync: a visit is part of its job
-- ---------------------------------------------------------------------------

create trigger work_order_visits_touch_sync after insert or update on work_order_visits
  for each row execute function touch_sync('work_order', 'work_order_id');
create trigger work_order_visit_assignees_touch_sync after insert or update on work_order_visit_assignees
  for each row execute function touch_sync('work_order', 'work_order_id');

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------
--
-- Append-or-revoke, as elsewhere: visits are cancelled and people removed, not
-- deleted.

grant select, insert, update on work_order_visits to integr8_app;
grant select, insert, update on work_order_visit_assignees to integr8_app;

alter table work_order_visits enable row level security;
create policy work_order_visits_isolation on work_order_visits
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table work_order_visit_assignees enable row level security;
create policy work_order_visit_assignees_isolation on work_order_visit_assignees
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
