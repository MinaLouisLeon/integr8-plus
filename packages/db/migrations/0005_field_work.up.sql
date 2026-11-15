-- Customers, sites, job types, work orders, visits, shifts and qualifications.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.assign_work_order_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  insert into public.work_order_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;

CREATE FUNCTION public.close_work_order_visits() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.enforce_work_order_form_signoff() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  forms_asking text;
begin
  if new.state = 'complete' and old.state is distinct from 'complete' and new.signed_off_at is null then
    select string_agg(distinct f.title, ', ') into forms_asking
      from submissions s
      join forms f on f.tenant_id = s.tenant_id and f.id = s.form_id
     where s.tenant_id = new.tenant_id
       and s.work_order_id = new.id
       and f.signature_required;
    if forms_asking is not null then
      raise exception 'work order % cannot be completed: the customer has not signed off (asked for by %)',
        old.id, forms_asking
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.enforce_work_order_state() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.guard_member_qualification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.guard_qualification_type() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.guard_site_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.guard_work_order_assignment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.guard_work_order_visit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.guard_work_order_visit_assignee() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.propagate_work_order_visit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (new.starts_at, new.ends_at, new.status) is distinct from (old.starts_at, old.ends_at, old.status) then
    update work_order_visit_assignees a
       set starts_at = new.starts_at
     where a.tenant_id = new.tenant_id and a.visit_id = new.id and a.removed_at is null;
  end if;
  return null;
end;
$$;

CREATE FUNCTION public.protect_shift() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.queue_work_order_push() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.kind in ('assigned', 'rescheduled', 'visit_rescheduled', 'visit_assigned')
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

CREATE FUNCTION public.record_qualification_override() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, reason, details)
  values (new.tenant_id, new.work_order_id, 'qualification_override', new.created_by, new.reason,
          jsonb_build_object('visitId', new.visit_id, 'startsAt', new.starts_at, 'endsAt', new.ends_at,
                             'missing', new.missing, 'assigneeIds', to_jsonb(new.assignee_ids)));
  return null;
end;
$$;

CREATE FUNCTION public.record_work_order_assignment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.record_work_order_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.record_work_order_visit_assignee() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.record_work_order_visit_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.reject_qualification_override_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and current_setting('integr8.purging', true) = old.tenant_id::text then
    return old;
  end if;
  raise exception 'work_order_qualification_overrides is append-only; % is not permitted', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

CREATE FUNCTION public.reject_work_order_events_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'work_order_events is append-only; % is not permitted', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

CREATE FUNCTION public.remove_unassigned_from_visits() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.touch_sync() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  kind   text := tg_argv[0];
  column_name text := tg_argv[1];
  target record;
  entity uuid;
begin
  if tg_op = 'DELETE' then
    target := old;
  else
    target := new;
  end if;
  entity := (to_jsonb(target) ->> column_name)::uuid;
  if entity is not null then
    insert into public.sync_touches (tenant_id, entity_kind, entity_id)
    values (target.tenant_id, kind, entity);
  end if;
  -- A row that moved to another parent touches the old parent too.
  if tg_op = 'UPDATE' and (to_jsonb(old) ->> column_name) is distinct from (to_jsonb(new) ->> column_name)
     and (to_jsonb(old) ->> column_name) is not null then
    insert into public.sync_touches (tenant_id, entity_kind, entity_id)
    values (old.tenant_id, kind, (to_jsonb(old) ->> column_name)::uuid);
  end if;
  return null;
end;
$$;

CREATE FUNCTION public.track_work_order_deadlines() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.state is not distinct from old.state then
    return null;
  end if;
  update work_order_deadlines d
     set responded_at = case
           when d.responded_at is null and new.state = 'dispatched' then new.state_changed_at
           else d.responded_at end,
         completed_at = case
           when d.completed_at is null and new.state = 'complete' then new.state_changed_at
           else d.completed_at end,
         closed_at = case
           when new.state = 'cancelled' then new.state_changed_at
           when old.state = 'cancelled' then null
           else d.closed_at end
   where d.tenant_id = new.tenant_id and d.work_order_id = new.id;
  return null;
end;
$$;

CREATE FUNCTION public.work_order_happened_at(previous timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE plpgsql STABLE
    AS $$
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

CREATE FUNCTION public.work_order_transition_allowed(from_state text, to_state text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
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

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    file_id uuid NOT NULL,
    customer_id uuid,
    site_id uuid,
    work_order_id uuid,
    title text NOT NULL,
    kind text DEFAULT 'other'::text NOT NULL,
    added_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    removed_by uuid,
    stage text,
    asset_id uuid,
    expense_claim_id uuid,
    item_id uuid,
    work_order_purchase_id uuid,
    is_main boolean DEFAULT false NOT NULL,
    member_qualification_id uuid,
    CONSTRAINT attachments_kind_known CHECK ((kind = ANY (ARRAY['site_plan'::text, 'manual'::text, 'report'::text, 'photo'::text, 'other'::text]))),
    CONSTRAINT attachments_main_is_item CHECK (((NOT is_main) OR (item_id IS NOT NULL))),
    CONSTRAINT attachments_one_owner CHECK ((num_nonnulls(customer_id, site_id, work_order_id, asset_id, expense_claim_id, item_id, work_order_purchase_id, member_qualification_id) = 1)),
    CONSTRAINT attachments_removed_complete CHECK (((removed_at IS NULL) = (removed_by IS NULL))),
    CONSTRAINT attachments_stage_is_job_photo CHECK (((stage IS NULL) OR ((work_order_id IS NOT NULL) AND (kind = 'photo'::text)))),
    CONSTRAINT attachments_stage_known CHECK (((stage IS NULL) OR (stage = ANY (ARRAY['before'::text, 'after'::text])))),
    CONSTRAINT attachments_title_present CHECK (((btrim(title) <> ''::text) AND (char_length(title) <= 200)))
);

CREATE TABLE customer_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    name text NOT NULL,
    job_title text,
    email text,
    phone text,
    is_primary boolean DEFAULT false NOT NULL,
    notes text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_contacts_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 200))),
    CONSTRAINT customer_contacts_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 4000))),
    CONSTRAINT customer_contacts_primary_is_current CHECK ((NOT (is_primary AND (archived_at IS NOT NULL))))
);

CREATE TABLE customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    account_number text,
    status text DEFAULT 'active'::text NOT NULL,
    email text,
    phone text,
    address_line1 text,
    address_line2 text,
    city text,
    region text,
    postcode text,
    country_code text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    notes text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((((((((((COALESCE(name, ''::text) || ' '::text) || COALESCE(account_number, ''::text)) || ' '::text) || COALESCE(email, ''::text)) || ' '::text) || COALESCE(phone, ''::text)) || ' '::text) || COALESCE(city, ''::text)) || ' '::text) || COALESCE(postcode, ''::text)))) STORED,
    is_demo boolean DEFAULT false NOT NULL,
    CONSTRAINT customers_account_number_shape CHECK (((account_number IS NULL) OR ((btrim(account_number) <> ''::text) AND (char_length(account_number) <= 64)))),
    CONSTRAINT customers_country_code_shape CHECK (((country_code IS NULL) OR (country_code ~ '^[A-Z]{2}$'::text))),
    CONSTRAINT customers_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 200))),
    CONSTRAINT customers_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 10000))),
    CONSTRAINT customers_status_known CHECK ((status = ANY (ARRAY['active'::text, 'on_hold'::text, 'closed'::text]))),
    CONSTRAINT customers_tags_sane CHECK ((cardinality(tags) <= 50))
);

CREATE TABLE imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    file_name text NOT NULL,
    source text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    succeeded_rows integer DEFAULT 0 NOT NULL,
    failed_rows integer DEFAULT 0 NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT imports_completed_matches_status CHECK (((status = ANY (ARRAY['completed'::text, 'failed'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT imports_counts_sane CHECK (((total_rows >= 0) AND (succeeded_rows >= 0) AND (failed_rows >= 0) AND ((succeeded_rows + failed_rows) <= total_rows))),
    CONSTRAINT imports_errors_shape CHECK ((jsonb_typeof(errors) = 'array'::text)),
    CONSTRAINT imports_kind_known CHECK ((kind = ANY (ARRAY['customers'::text, 'sites'::text, 'work_orders'::text, 'assets'::text]))),
    CONSTRAINT imports_source_size CHECK ((octet_length(source) <= 5242880)),
    CONSTRAINT imports_status_known CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);

CREATE TABLE job_type_qualifications (
    tenant_id uuid NOT NULL,
    job_type_id uuid NOT NULL,
    qualification_type_id uuid NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE job_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    description text,
    expected_duration_minutes integer,
    default_priority text DEFAULT 'normal'::text NOT NULL,
    instructions text,
    checklist jsonb DEFAULT '[]'::jsonb NOT NULL,
    archived_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    before_photos smallint DEFAULT 0 NOT NULL,
    after_photos smallint DEFAULT 0 NOT NULL,
    signature_required boolean DEFAULT false NOT NULL,
    CONSTRAINT job_types_checklist_shape CHECK (((jsonb_typeof(checklist) = 'array'::text) AND (jsonb_array_length(checklist) <= 100))),
    CONSTRAINT job_types_code_shape CHECK ((code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'::text)),
    CONSTRAINT job_types_duration_range CHECK (((expected_duration_minutes IS NULL) OR ((expected_duration_minutes >= 1) AND (expected_duration_minutes <= 10080)))),
    CONSTRAINT job_types_instructions_length CHECK (((instructions IS NULL) OR (char_length(instructions) <= 10000))),
    CONSTRAINT job_types_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 120))),
    CONSTRAINT job_types_photo_counts CHECK ((((before_photos >= 0) AND (before_photos <= 20)) AND ((after_photos >= 0) AND (after_photos <= 20)))),
    CONSTRAINT job_types_priority_known CHECK ((default_priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])))
);

CREATE TABLE member_qualifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    qualification_type_id uuid NOT NULL,
    reference text,
    issued_on date,
    expires_on date,
    notes text,
    expiry_warned_at timestamp with time zone,
    lapse_alerted_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    removed_by uuid,
    CONSTRAINT member_qualifications_dates_ordered CHECK (((issued_on IS NULL) OR (expires_on IS NULL) OR (expires_on >= issued_on))),
    CONSTRAINT member_qualifications_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 1000))),
    CONSTRAINT member_qualifications_reference_length CHECK (((reference IS NULL) OR (char_length(reference) <= 120))),
    CONSTRAINT member_qualifications_removed_complete CHECK (((removed_at IS NULL) = (removed_by IS NULL)))
);

CREATE TABLE qualification_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    description text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT qualification_types_description_length CHECK (((description IS NULL) OR (char_length(description) <= 1000))),
    CONSTRAINT qualification_types_kind_known CHECK ((kind = ANY (ARRAY['skill'::text, 'certificate'::text]))),
    CONSTRAINT qualification_types_name_length CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 120)))
);

CREATE TABLE saved_views (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    resource text NOT NULL,
    name text NOT NULL,
    filters jsonb NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT saved_views_filters_shape CHECK ((jsonb_typeof(filters) = 'object'::text)),
    CONSTRAINT saved_views_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 80))),
    CONSTRAINT saved_views_resource_known CHECK ((resource = 'work_orders'::text))
);

CREATE TABLE shifts (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    start_location jsonb,
    end_location jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shifts_at_most_a_week CHECK (((ended_at IS NULL) OR ((ended_at - started_at) <= '7 days'::interval))),
    CONSTRAINT shifts_end_location_shape CHECK (((end_location IS NULL) OR ((jsonb_typeof(end_location) = 'object'::text) AND ((((end_location ->> 'status'::text) = 'captured'::text) AND (end_location ?& ARRAY['latitude'::text, 'longitude'::text, 'capturedAt'::text])) OR ((end_location ->> 'status'::text) = ANY (ARRAY['denied'::text, 'unavailable'::text])))))),
    CONSTRAINT shifts_end_location_when_ended CHECK (((ended_at IS NOT NULL) OR (end_location IS NULL))),
    CONSTRAINT shifts_ends_after_start CHECK (((ended_at IS NULL) OR (ended_at >= started_at))),
    CONSTRAINT shifts_start_location_shape CHECK (((start_location IS NULL) OR ((jsonb_typeof(start_location) = 'object'::text) AND ((((start_location ->> 'status'::text) = 'captured'::text) AND (start_location ?& ARRAY['latitude'::text, 'longitude'::text, 'capturedAt'::text])) OR ((start_location ->> 'status'::text) = ANY (ARRAY['denied'::text, 'unavailable'::text]))))))
);

CREATE TABLE sites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    name text NOT NULL,
    address_line1 text NOT NULL,
    address_line2 text,
    city text,
    region text,
    postcode text,
    country_code text,
    latitude numeric(9,6),
    longitude numeric(9,6),
    geocode_status text DEFAULT 'pending'::text NOT NULL,
    geocode_accuracy text,
    geocoded_at timestamp with time zone,
    contact_id uuid,
    access_gate_code text,
    access_parking text,
    access_ask_for text,
    access_hazards text,
    access_notes text,
    access_updated_at timestamp with time zone,
    access_updated_by uuid,
    archived_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((((((((COALESCE(name, ''::text) || ' '::text) || COALESCE(address_line1, ''::text)) || ' '::text) || COALESCE(address_line2, ''::text)) || ' '::text) || COALESCE(city, ''::text)) || ' '::text) || COALESCE(postcode, ''::text)))) STORED,
    is_demo boolean DEFAULT false NOT NULL,
    CONSTRAINT sites_access_lengths CHECK (((COALESCE(char_length(access_gate_code), 0) <= 200) AND (COALESCE(char_length(access_parking), 0) <= 2000) AND (COALESCE(char_length(access_ask_for), 0) <= 500) AND (COALESCE(char_length(access_hazards), 0) <= 4000) AND (COALESCE(char_length(access_notes), 0) <= 4000))),
    CONSTRAINT sites_address_present CHECK ((btrim(address_line1) <> ''::text)),
    CONSTRAINT sites_coordinates_pair CHECK (((latitude IS NULL) = (longitude IS NULL))),
    CONSTRAINT sites_country_code_shape CHECK (((country_code IS NULL) OR (country_code ~ '^[A-Z]{2}$'::text))),
    CONSTRAINT sites_geocode_status_known CHECK ((geocode_status = ANY (ARRAY['pending'::text, 'found'::text, 'not_found'::text, 'failed'::text, 'manual'::text]))),
    CONSTRAINT sites_latitude_range CHECK (((latitude IS NULL) OR ((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric)))),
    CONSTRAINT sites_located_has_coordinates CHECK (((geocode_status = ANY (ARRAY['found'::text, 'manual'::text])) = (latitude IS NOT NULL))),
    CONSTRAINT sites_longitude_range CHECK (((longitude IS NULL) OR ((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric)))),
    CONSTRAINT sites_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 200)))
);

CREATE TABLE work_order_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    user_id uuid NOT NULL,
    is_lead boolean DEFAULT false NOT NULL,
    assigned_by uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    unassigned_at timestamp with time zone,
    unassigned_by uuid,
    CONSTRAINT work_order_assignments_lead_is_current CHECK ((NOT (is_lead AND (unassigned_at IS NOT NULL)))),
    CONSTRAINT work_order_assignments_unassigned_complete CHECK (((unassigned_at IS NULL) = (unassigned_by IS NULL)))
);

CREATE TABLE work_order_checklist_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    "position" integer NOT NULL,
    label text NOT NULL,
    done boolean DEFAULT false NOT NULL,
    done_by uuid,
    done_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_order_checklist_items_done_complete CHECK ((done = ((done_by IS NOT NULL) AND (done_at IS NOT NULL)))),
    CONSTRAINT work_order_checklist_items_label_present CHECK (((btrim(label) <> ''::text) AND (char_length(label) <= 300)))
);

CREATE TABLE work_order_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    author_id uuid NOT NULL,
    visibility text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_order_comments_body_present CHECK (((btrim(body) <> ''::text) AND (char_length(body) <= 10000))),
    CONSTRAINT work_order_comments_visibility_known CHECK ((visibility = ANY (ARRAY['internal'::text, 'customer'::text])))
);

CREATE TABLE work_order_counters (
    tenant_id uuid NOT NULL,
    last_reference integer NOT NULL
);

CREATE TABLE work_order_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence bigint NOT NULL,
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    kind text NOT NULL,
    from_state text,
    to_state text,
    user_id uuid,
    actor_id uuid NOT NULL,
    reason text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_order_events_kind_known CHECK ((kind = ANY (ARRAY['created'::text, 'transitioned'::text, 'rescheduled'::text, 'updated'::text, 'assigned'::text, 'unassigned'::text, 'lead_changed'::text, 'signed_off'::text, 'visit_scheduled'::text, 'visit_rescheduled'::text, 'visit_done'::text, 'visit_cancelled'::text, 'visit_assigned'::text, 'visit_unassigned'::text, 'qualification_override'::text, 'maintenance_planned'::text, 'coverage_changed'::text, 'deadline_missed'::text, 'form_submitted_after_close'::text]))),
    CONSTRAINT work_order_events_person_when_assignment CHECK (((kind = ANY (ARRAY['assigned'::text, 'unassigned'::text, 'lead_changed'::text, 'visit_assigned'::text, 'visit_unassigned'::text])) = (user_id IS NOT NULL))),
    CONSTRAINT work_order_events_transition_complete CHECK (((kind = 'transitioned'::text) = ((from_state IS NOT NULL) AND (to_state IS NOT NULL))))
)
PARTITION BY RANGE (occurred_at);

CREATE TABLE work_order_qualification_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    visit_id uuid NOT NULL,
    reason text NOT NULL,
    missing jsonb NOT NULL,
    assignee_ids uuid[] NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_order_qualification_overrides_missing_shape CHECK (((jsonb_typeof(missing) = 'array'::text) AND (jsonb_array_length(missing) > 0))),
    CONSTRAINT work_order_qualification_overrides_reason_length CHECK (((char_length(btrim(reason)) >= 1) AND (char_length(btrim(reason)) <= 500)))
);

CREATE TABLE work_order_qualifications (
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    qualification_type_id uuid NOT NULL,
    added_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE work_order_visit_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    visit_id uuid NOT NULL,
    user_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    planned boolean NOT NULL,
    assigned_by uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    removed_by uuid,
    CONSTRAINT work_order_visit_assignees_removed_complete CHECK (((removed_at IS NULL) = (removed_by IS NULL)))
);

CREATE TABLE work_order_visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    status text DEFAULT 'planned'::text NOT NULL,
    notes text,
    completed_at timestamp with time zone,
    completed_by uuid,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancel_reason text,
    last_actor uuid NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_order_visits_at_most_a_week CHECK (((ends_at - starts_at) <= '7 days'::interval)),
    CONSTRAINT work_order_visits_cancel_reason_length CHECK (((cancel_reason IS NULL) OR (char_length(cancel_reason) <= 500))),
    CONSTRAINT work_order_visits_cancelled_complete CHECK (((status = 'cancelled'::text) = ((cancelled_at IS NOT NULL) AND (cancelled_by IS NOT NULL)))),
    CONSTRAINT work_order_visits_done_complete CHECK (((status = 'done'::text) = ((completed_at IS NOT NULL) AND (completed_by IS NOT NULL)))),
    CONSTRAINT work_order_visits_ends_after_start CHECK ((ends_at > starts_at)),
    CONSTRAINT work_order_visits_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 2000))),
    CONSTRAINT work_order_visits_reason_when_cancelled CHECK (((cancel_reason IS NULL) OR (status = 'cancelled'::text))),
    CONSTRAINT work_order_visits_status_known CHECK ((status = ANY (ARRAY['planned'::text, 'done'::text, 'cancelled'::text])))
);

CREATE TABLE work_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    customer_id uuid NOT NULL,
    site_id uuid NOT NULL,
    job_type_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    instructions text,
    priority text DEFAULT 'normal'::text NOT NULL,
    state text DEFAULT 'scheduled'::text NOT NULL,
    due_from timestamp with time zone,
    due_by timestamp with time zone,
    state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    reviewed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    last_actor uuid NOT NULL,
    last_reason text,
    revision integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))) STORED,
    before_photos smallint DEFAULT 0 NOT NULL,
    after_photos smallint DEFAULT 0 NOT NULL,
    signature_required boolean DEFAULT false NOT NULL,
    signed_off_at timestamp with time zone,
    signed_off_by uuid,
    signoff_file_id uuid,
    signoff_name text,
    signoff_role text,
    signoff_unavailable_reason text,
    is_demo boolean DEFAULT false NOT NULL,
    CONSTRAINT work_orders_cancelled_matches_state CHECK (((state = 'cancelled'::text) = (cancelled_at IS NOT NULL))),
    CONSTRAINT work_orders_completed_matches_state CHECK (((state = ANY (ARRAY['complete'::text, 'reviewed'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT work_orders_due_window CHECK (((due_from IS NULL) OR (due_by IS NULL) OR (due_by >= due_from))),
    CONSTRAINT work_orders_photo_counts CHECK ((((before_photos >= 0) AND (before_photos <= 20)) AND ((after_photos >= 0) AND (after_photos <= 20)))),
    CONSTRAINT work_orders_priority_known CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT work_orders_reason_length CHECK (((last_reason IS NULL) OR (char_length(last_reason) <= 2000))),
    CONSTRAINT work_orders_reviewed_matches_state CHECK (((state = 'reviewed'::text) = (reviewed_at IS NOT NULL))),
    CONSTRAINT work_orders_revision_positive CHECK ((revision >= 1)),
    CONSTRAINT work_orders_signoff_shape CHECK ((((signed_off_at IS NULL) AND (signed_off_by IS NULL) AND (signoff_file_id IS NULL) AND (signoff_name IS NULL) AND (signoff_role IS NULL) AND (signoff_unavailable_reason IS NULL)) OR ((signed_off_at IS NOT NULL) AND (signed_off_by IS NOT NULL) AND (((signoff_file_id IS NOT NULL) AND (btrim(COALESCE(signoff_name, ''::text)) <> ''::text) AND (char_length(signoff_name) <= 200) AND (COALESCE(char_length(signoff_role), 0) <= 100) AND (signoff_unavailable_reason IS NULL)) OR ((signoff_file_id IS NULL) AND (signoff_name IS NULL) AND (signoff_role IS NULL) AND (btrim(COALESCE(signoff_unavailable_reason, ''::text)) <> ''::text) AND (char_length(signoff_unavailable_reason) <= 2000)))))),
    CONSTRAINT work_orders_state_known CHECK ((state = ANY (ARRAY['scheduled'::text, 'dispatched'::text, 'travelling'::text, 'on_site'::text, 'in_progress'::text, 'awaiting_parts'::text, 'complete'::text, 'reviewed'::text, 'cancelled'::text]))),
    CONSTRAINT work_orders_text_lengths CHECK (((COALESCE(char_length(description), 0) <= 10000) AND (COALESCE(char_length(instructions), 0) <= 10000))),
    CONSTRAINT work_orders_title_present CHECK (((btrim(title) <> ''::text) AND (char_length(title) <= 200)))
);

ALTER TABLE work_order_events ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME work_order_events_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY customer_contacts
    ADD CONSTRAINT customer_contacts_customer_id_unique UNIQUE (tenant_id, customer_id, id);

ALTER TABLE ONLY customer_contacts
    ADD CONSTRAINT customer_contacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY customer_contacts
    ADD CONSTRAINT customer_contacts_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY customers
    ADD CONSTRAINT customers_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY imports
    ADD CONSTRAINT imports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY imports
    ADD CONSTRAINT imports_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY job_type_qualifications
    ADD CONSTRAINT job_type_qualifications_pkey PRIMARY KEY (tenant_id, job_type_id, qualification_type_id);

ALTER TABLE ONLY job_types
    ADD CONSTRAINT job_types_pkey PRIMARY KEY (id);

ALTER TABLE ONLY job_types
    ADD CONSTRAINT job_types_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY member_qualifications
    ADD CONSTRAINT member_qualifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY member_qualifications
    ADD CONSTRAINT member_qualifications_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY qualification_types
    ADD CONSTRAINT qualification_types_pkey PRIMARY KEY (id);

ALTER TABLE ONLY qualification_types
    ADD CONSTRAINT qualification_types_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY saved_views
    ADD CONSTRAINT saved_views_pkey PRIMARY KEY (id);

ALTER TABLE ONLY saved_views
    ADD CONSTRAINT saved_views_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY shifts
    ADD CONSTRAINT shifts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY shifts
    ADD CONSTRAINT shifts_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_customer_id_unique UNIQUE (tenant_id, customer_id, id);

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY work_order_assignments
    ADD CONSTRAINT work_order_assignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY work_order_assignments
    ADD CONSTRAINT work_order_assignments_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY work_order_checklist_items
    ADD CONSTRAINT work_order_checklist_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY work_order_checklist_items
    ADD CONSTRAINT work_order_checklist_items_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY work_order_comments
    ADD CONSTRAINT work_order_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY work_order_comments
    ADD CONSTRAINT work_order_comments_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY work_order_counters
    ADD CONSTRAINT work_order_counters_pkey PRIMARY KEY (tenant_id);

ALTER TABLE work_order_events
    ADD CONSTRAINT work_order_events_pkey PRIMARY KEY (tenant_id, id, occurred_at);

ALTER TABLE ONLY work_order_qualification_overrides
    ADD CONSTRAINT work_order_qualification_overrides_pkey PRIMARY KEY (id);

ALTER TABLE ONLY work_order_qualifications
    ADD CONSTRAINT work_order_qualifications_pkey PRIMARY KEY (tenant_id, work_order_id, qualification_type_id);

ALTER TABLE ONLY work_order_visit_assignees
    ADD CONSTRAINT work_order_visit_assignees_no_double_booking EXCLUDE USING gist (tenant_id WITH =, user_id WITH =, work_order_id WITH <>, tstzrange(starts_at, ends_at, '[)'::text) WITH &&) WHERE ((planned AND (removed_at IS NULL)));

ALTER TABLE ONLY work_order_visit_assignees
    ADD CONSTRAINT work_order_visit_assignees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY work_order_visit_assignees
    ADD CONSTRAINT work_order_visit_assignees_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY work_order_visits
    ADD CONSTRAINT work_order_visits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY work_order_visits
    ADD CONSTRAINT work_order_visits_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY work_orders
    ADD CONSTRAINT work_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY work_orders
    ADD CONSTRAINT work_orders_tenant_id_unique UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX attachments_asset_idx ON attachments USING btree (tenant_id, asset_id) WHERE (asset_id IS NOT NULL);

CREATE INDEX attachments_customer_idx ON attachments USING btree (tenant_id, customer_id) WHERE (customer_id IS NOT NULL);

CREATE INDEX attachments_expense_claim_idx ON attachments USING btree (tenant_id, expense_claim_id) WHERE (expense_claim_id IS NOT NULL);

CREATE INDEX attachments_file_idx ON attachments USING btree (tenant_id, file_id) WHERE (removed_at IS NULL);

CREATE INDEX attachments_item_idx ON attachments USING btree (tenant_id, item_id) WHERE (item_id IS NOT NULL);

CREATE UNIQUE INDEX attachments_item_main_unique ON attachments USING btree (tenant_id, item_id) WHERE (is_main AND (removed_at IS NULL));

CREATE INDEX attachments_member_qualification_idx ON attachments USING btree (tenant_id, member_qualification_id) WHERE (member_qualification_id IS NOT NULL);

CREATE INDEX attachments_site_idx ON attachments USING btree (tenant_id, site_id) WHERE (site_id IS NOT NULL);

CREATE INDEX attachments_work_order_idx ON attachments USING btree (tenant_id, work_order_id) WHERE (work_order_id IS NOT NULL);

CREATE INDEX attachments_work_order_purchase_idx ON attachments USING btree (tenant_id, work_order_purchase_id) WHERE (work_order_purchase_id IS NOT NULL);

CREATE INDEX attachments_work_order_stage_idx ON attachments USING btree (tenant_id, work_order_id, stage) WHERE ((stage IS NOT NULL) AND (removed_at IS NULL));

CREATE INDEX customer_contacts_customer_idx ON customer_contacts USING btree (tenant_id, customer_id, name);

CREATE UNIQUE INDEX customer_contacts_one_primary ON customer_contacts USING btree (tenant_id, customer_id) WHERE is_primary;

CREATE UNIQUE INDEX customers_account_number_unique ON customers USING btree (tenant_id, lower(account_number)) WHERE (account_number IS NOT NULL);

CREATE INDEX customers_demo_idx ON customers USING btree (tenant_id) WHERE is_demo;

CREATE INDEX customers_name_idx ON customers USING btree (tenant_id, lower(name), id);

CREATE INDEX customers_search_idx ON customers USING gin (search);

CREATE INDEX customers_tags_idx ON customers USING gin (tags);

CREATE INDEX imports_tenant_idx ON imports USING btree (tenant_id, created_at DESC);

CREATE UNIQUE INDEX job_types_code_unique ON job_types USING btree (tenant_id, code);

CREATE UNIQUE INDEX job_types_name_unique ON job_types USING btree (tenant_id, lower(name));

CREATE INDEX member_qualifications_expiry_idx ON member_qualifications USING btree (tenant_id, expires_on) WHERE ((removed_at IS NULL) AND (expires_on IS NOT NULL));

CREATE INDEX member_qualifications_member_idx ON member_qualifications USING btree (tenant_id, user_id) WHERE (removed_at IS NULL);

CREATE INDEX member_qualifications_type_idx ON member_qualifications USING btree (tenant_id, qualification_type_id) WHERE (removed_at IS NULL);

CREATE UNIQUE INDEX qualification_types_name_unique ON qualification_types USING btree (tenant_id, lower(btrim(name))) WHERE (archived_at IS NULL);

CREATE UNIQUE INDEX saved_views_name_unique ON saved_views USING btree (tenant_id, owner_id, resource, lower(name));

CREATE UNIQUE INDEX shifts_one_open_per_person ON shifts USING btree (tenant_id, user_id) WHERE (ended_at IS NULL);

CREATE INDEX shifts_person_idx ON shifts USING btree (tenant_id, user_id, started_at DESC);

CREATE INDEX sites_customer_idx ON sites USING btree (tenant_id, customer_id, name);

CREATE INDEX sites_demo_idx ON sites USING btree (tenant_id) WHERE is_demo;

CREATE INDEX sites_geocode_pending_idx ON sites USING btree (tenant_id) WHERE (geocode_status = 'pending'::text);

CREATE INDEX sites_search_idx ON sites USING gin (search);

CREATE UNIQUE INDEX work_order_assignments_current_unique ON work_order_assignments USING btree (tenant_id, work_order_id, user_id) WHERE (unassigned_at IS NULL);

CREATE UNIQUE INDEX work_order_assignments_one_lead ON work_order_assignments USING btree (tenant_id, work_order_id) WHERE is_lead;

CREATE INDEX work_order_assignments_user_idx ON work_order_assignments USING btree (tenant_id, user_id, work_order_id) WHERE (unassigned_at IS NULL);

CREATE INDEX work_order_checklist_items_work_order_idx ON work_order_checklist_items USING btree (tenant_id, work_order_id, "position");

CREATE INDEX work_order_comments_work_order_idx ON work_order_comments USING btree (tenant_id, work_order_id, created_at);

CREATE INDEX work_order_events_work_order_idx ON work_order_events USING btree (tenant_id, work_order_id, sequence);

CREATE INDEX work_order_qualification_overrides_work_order_idx ON work_order_qualification_overrides USING btree (tenant_id, work_order_id, created_at);

CREATE INDEX work_order_qualifications_type_idx ON work_order_qualifications USING btree (tenant_id, qualification_type_id);

CREATE UNIQUE INDEX work_order_visit_assignees_current_unique ON work_order_visit_assignees USING btree (tenant_id, visit_id, user_id) WHERE (removed_at IS NULL);

CREATE INDEX work_order_visit_assignees_person_idx ON work_order_visit_assignees USING btree (tenant_id, user_id, starts_at) WHERE (removed_at IS NULL);

CREATE INDEX work_order_visit_assignees_work_order_idx ON work_order_visit_assignees USING btree (tenant_id, work_order_id, user_id) WHERE (removed_at IS NULL);

CREATE INDEX work_order_visits_starts_idx ON work_order_visits USING btree (tenant_id, starts_at);

CREATE INDEX work_order_visits_work_order_idx ON work_order_visits USING btree (tenant_id, work_order_id, starts_at);

CREATE INDEX work_orders_customer_idx ON work_orders USING btree (tenant_id, customer_id, created_at DESC);

CREATE INDEX work_orders_demo_idx ON work_orders USING btree (tenant_id) WHERE is_demo;

CREATE INDEX work_orders_due_idx ON work_orders USING btree (tenant_id, due_by, id);

CREATE INDEX work_orders_job_type_idx ON work_orders USING btree (tenant_id, job_type_id);

CREATE UNIQUE INDEX work_orders_reference_unique ON work_orders USING btree (tenant_id, reference);

CREATE INDEX work_orders_search_idx ON work_orders USING gin (search);

CREATE INDEX work_orders_site_idx ON work_orders USING btree (tenant_id, site_id, created_at DESC);

CREATE INDEX work_orders_state_idx ON work_orders USING btree (tenant_id, state, due_by, id);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_file_fk FOREIGN KEY (tenant_id, file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_member_qualification_fk FOREIGN KEY (tenant_id, member_qualification_id) REFERENCES member_qualifications(tenant_id, id);

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY customer_contacts
    ADD CONSTRAINT customer_contacts_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY customer_contacts
    ADD CONSTRAINT customer_contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY customers
    ADD CONSTRAINT customers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY imports
    ADD CONSTRAINT imports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY job_type_qualifications
    ADD CONSTRAINT job_type_qualifications_job_type_fk FOREIGN KEY (tenant_id, job_type_id) REFERENCES job_types(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY job_type_qualifications
    ADD CONSTRAINT job_type_qualifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY job_type_qualifications
    ADD CONSTRAINT job_type_qualifications_type_fk FOREIGN KEY (tenant_id, qualification_type_id) REFERENCES qualification_types(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY job_types
    ADD CONSTRAINT job_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY member_qualifications
    ADD CONSTRAINT member_qualifications_member_fk FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY member_qualifications
    ADD CONSTRAINT member_qualifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY member_qualifications
    ADD CONSTRAINT member_qualifications_type_fk FOREIGN KEY (tenant_id, qualification_type_id) REFERENCES qualification_types(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY qualification_types
    ADD CONSTRAINT qualification_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY saved_views
    ADD CONSTRAINT saved_views_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY shifts
    ADD CONSTRAINT shifts_member_fk FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY shifts
    ADD CONSTRAINT shifts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_contact_fk FOREIGN KEY (tenant_id, customer_id, contact_id) REFERENCES customer_contacts(tenant_id, customer_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY sites
    ADD CONSTRAINT sites_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_assignments
    ADD CONSTRAINT work_order_assignments_member_fk FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_assignments
    ADD CONSTRAINT work_order_assignments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_assignments
    ADD CONSTRAINT work_order_assignments_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_checklist_items
    ADD CONSTRAINT work_order_checklist_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_checklist_items
    ADD CONSTRAINT work_order_checklist_items_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_comments
    ADD CONSTRAINT work_order_comments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_comments
    ADD CONSTRAINT work_order_comments_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_counters
    ADD CONSTRAINT work_order_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE work_order_events
    ADD CONSTRAINT work_order_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE work_order_events
    ADD CONSTRAINT work_order_events_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_qualification_overrides
    ADD CONSTRAINT work_order_qualification_overrides_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_qualification_overrides
    ADD CONSTRAINT work_order_qualification_overrides_visit_fk FOREIGN KEY (tenant_id, visit_id) REFERENCES work_order_visits(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_qualification_overrides
    ADD CONSTRAINT work_order_qualification_overrides_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_qualifications
    ADD CONSTRAINT work_order_qualifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_qualifications
    ADD CONSTRAINT work_order_qualifications_type_fk FOREIGN KEY (tenant_id, qualification_type_id) REFERENCES qualification_types(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_qualifications
    ADD CONSTRAINT work_order_qualifications_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY work_order_visit_assignees
    ADD CONSTRAINT work_order_visit_assignees_member_fk FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_visit_assignees
    ADD CONSTRAINT work_order_visit_assignees_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_visit_assignees
    ADD CONSTRAINT work_order_visit_assignees_visit_fk FOREIGN KEY (tenant_id, visit_id) REFERENCES work_order_visits(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_visit_assignees
    ADD CONSTRAINT work_order_visit_assignees_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_visits
    ADD CONSTRAINT work_order_visits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_visits
    ADD CONSTRAINT work_order_visits_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_orders
    ADD CONSTRAINT work_orders_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_orders
    ADD CONSTRAINT work_orders_job_type_fk FOREIGN KEY (tenant_id, job_type_id) REFERENCES job_types(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_orders
    ADD CONSTRAINT work_orders_signoff_file_fk FOREIGN KEY (tenant_id, signoff_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_orders
    ADD CONSTRAINT work_orders_site_fk FOREIGN KEY (tenant_id, customer_id, site_id) REFERENCES sites(tenant_id, customer_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_orders
    ADD CONSTRAINT work_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER attachments_touch_customer AFTER INSERT OR UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION touch_sync('customer', 'customer_id');

CREATE TRIGGER attachments_touch_site AFTER INSERT OR UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION touch_sync('site', 'site_id');

CREATE TRIGGER attachments_touch_work_order AFTER INSERT OR UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER customer_contacts_set_updated_at BEFORE UPDATE ON customer_contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER customer_contacts_touch_sync AFTER INSERT OR UPDATE ON customer_contacts FOR EACH ROW EXECUTE FUNCTION touch_sync('customer', 'customer_id');

CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER customers_touch_sync AFTER INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_sync('customer', 'id');

CREATE TRIGGER job_types_set_updated_at BEFORE UPDATE ON job_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER member_qualifications_guard BEFORE INSERT OR UPDATE ON member_qualifications FOR EACH ROW EXECUTE FUNCTION guard_member_qualification();

CREATE TRIGGER member_qualifications_set_updated_at BEFORE UPDATE ON member_qualifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER qualification_types_guard BEFORE UPDATE ON qualification_types FOR EACH ROW EXECUTE FUNCTION guard_qualification_type();

CREATE TRIGGER qualification_types_set_updated_at BEFORE UPDATE ON qualification_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER saved_views_set_updated_at BEFORE UPDATE ON saved_views FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER shifts_protect BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION protect_shift();

CREATE TRIGGER shifts_set_updated_at BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER sites_guard_change BEFORE INSERT OR UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION guard_site_change();

CREATE TRIGGER sites_set_updated_at BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER sites_touch_sync AFTER INSERT OR UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION touch_sync('site', 'id');

CREATE TRIGGER work_order_assignments_guard BEFORE UPDATE ON work_order_assignments FOR EACH ROW EXECUTE FUNCTION guard_work_order_assignment();

CREATE TRIGGER work_order_assignments_leave_visits AFTER UPDATE ON work_order_assignments FOR EACH ROW EXECUTE FUNCTION remove_unassigned_from_visits();

CREATE TRIGGER work_order_assignments_record AFTER INSERT OR UPDATE ON work_order_assignments FOR EACH ROW EXECUTE FUNCTION record_work_order_assignment();

CREATE TRIGGER work_order_assignments_touch_sync AFTER INSERT OR DELETE OR UPDATE ON work_order_assignments FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER work_order_checklist_items_touch_sync AFTER INSERT OR DELETE OR UPDATE ON work_order_checklist_items FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER work_order_comments_touch_sync AFTER INSERT ON work_order_comments FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER work_order_events_no_delete BEFORE DELETE ON work_order_events FOR EACH STATEMENT EXECUTE FUNCTION reject_work_order_events_mutation();

CREATE TRIGGER work_order_events_no_truncate BEFORE TRUNCATE ON work_order_events FOR EACH STATEMENT EXECUTE FUNCTION reject_work_order_events_mutation();

CREATE TRIGGER work_order_events_no_update BEFORE UPDATE ON work_order_events FOR EACH STATEMENT EXECUTE FUNCTION reject_work_order_events_mutation();

CREATE TRIGGER work_order_events_queue_push AFTER INSERT ON work_order_events FOR EACH ROW EXECUTE FUNCTION queue_work_order_push();

CREATE TRIGGER work_order_qualification_overrides_append_only BEFORE DELETE OR UPDATE ON work_order_qualification_overrides FOR EACH ROW EXECUTE FUNCTION reject_qualification_override_mutation();

CREATE TRIGGER work_order_qualification_overrides_record AFTER INSERT ON work_order_qualification_overrides FOR EACH ROW EXECUTE FUNCTION record_qualification_override();

CREATE TRIGGER work_order_qualifications_touch_sync AFTER INSERT OR DELETE OR UPDATE ON work_order_qualifications FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER work_order_visit_assignees_guard BEFORE INSERT OR UPDATE ON work_order_visit_assignees FOR EACH ROW EXECUTE FUNCTION guard_work_order_visit_assignee();

CREATE TRIGGER work_order_visit_assignees_record AFTER INSERT OR UPDATE ON work_order_visit_assignees FOR EACH ROW EXECUTE FUNCTION record_work_order_visit_assignee();

CREATE TRIGGER work_order_visit_assignees_touch_sync AFTER INSERT OR UPDATE ON work_order_visit_assignees FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER work_order_visits_guard BEFORE INSERT OR UPDATE ON work_order_visits FOR EACH ROW EXECUTE FUNCTION guard_work_order_visit();

CREATE TRIGGER work_order_visits_propagate AFTER UPDATE ON work_order_visits FOR EACH ROW EXECUTE FUNCTION propagate_work_order_visit();

CREATE TRIGGER work_order_visits_record AFTER INSERT OR UPDATE ON work_order_visits FOR EACH ROW EXECUTE FUNCTION record_work_order_visit_change();

CREATE TRIGGER work_order_visits_set_updated_at BEFORE UPDATE ON work_order_visits FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER work_order_visits_touch_sync AFTER INSERT OR UPDATE ON work_order_visits FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER work_orders_assign_reference BEFORE INSERT ON work_orders FOR EACH ROW EXECUTE FUNCTION assign_work_order_reference();

CREATE TRIGGER work_orders_close_visits AFTER UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION close_work_order_visits();

CREATE TRIGGER work_orders_enforce_state BEFORE INSERT OR UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION enforce_work_order_state();

CREATE TRIGGER work_orders_enforce_state_signoff BEFORE UPDATE OF state ON work_orders FOR EACH ROW EXECUTE FUNCTION enforce_work_order_form_signoff();

CREATE TRIGGER work_orders_record_change AFTER INSERT OR UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION record_work_order_change();

CREATE TRIGGER work_orders_set_updated_at BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER work_orders_touch_sync AFTER INSERT OR UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'id');

CREATE TRIGGER work_orders_track_deadlines AFTER UPDATE OF state ON work_orders FOR EACH ROW EXECUTE FUNCTION track_work_order_deadlines();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

ALTER TABLE customer_contacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

ALTER TABLE imports ENABLE ROW LEVEL SECURITY;

ALTER TABLE job_type_qualifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE job_types ENABLE ROW LEVEL SECURITY;

ALTER TABLE member_qualifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE qualification_types ENABLE ROW LEVEL SECURITY;

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_assignments ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_checklist_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_comments ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_qualification_overrides ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_qualifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_visit_assignees ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_visits ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY attachments_isolation ON attachments TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY customer_contacts_isolation ON customer_contacts TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY customers_isolation ON customers TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY imports_isolation ON imports TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY job_type_qualifications_isolation ON job_type_qualifications TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY job_types_isolation ON job_types TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY member_qualifications_isolation ON member_qualifications TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY qualification_types_isolation ON qualification_types TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY saved_views_isolation ON saved_views TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY shifts_isolation ON shifts TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY sites_isolation ON sites TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_assignments_isolation ON work_order_assignments TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_checklist_items_isolation ON work_order_checklist_items TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_comments_isolation ON work_order_comments TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_counters_isolation ON work_order_counters FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_events_isolation ON work_order_events FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_qualification_overrides_isolation ON work_order_qualification_overrides TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_qualifications_isolation ON work_order_qualifications TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_visit_assignees_isolation ON work_order_visit_assignees TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_visits_isolation ON work_order_visits TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_orders_isolation ON work_orders TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION assign_work_order_reference() IS 'Gives a new work order the next reference for its company. Security definer: the runtime role cannot write work_order_counters.';

COMMENT ON FUNCTION close_work_order_visits() IS 'When a job is completed, marks its started planned visits done and cancels the rest; when it is cancelled, cancels them all.';

COMMENT ON FUNCTION enforce_work_order_form_signoff() IS 'Refuses completing a job without a sign-off when any submission on it is of a form whose signature_required is set (0060). The job type''s own requirement is checked by enforce_work_order_state.';

COMMENT ON FUNCTION enforce_work_order_state() IS 'Refuses a work order change the state machine does not allow: a transition that is not in the table, cancelling or reopening without a reason, dispatching with nobody assigned, completing with required forms unsubmitted, or editing a closed job.';

COMMENT ON FUNCTION guard_member_qualification() IS 'Keeps a qualification record''s person and type, refuses changing a removed one or adding one of an archived type, refuses an expiry on a skill, and resets the expiry alerts when the dates change.';

COMMENT ON FUNCTION guard_qualification_type() IS 'Keeps a qualification type''s kind, since records already held were checked against it. Counts versions.';

COMMENT ON FUNCTION guard_work_order_visit() IS 'Refuses moving a visit to another job, changing a visit that is done or cancelled, and planning a visit on a closed job. Counts revisions.';

COMMENT ON FUNCTION guard_work_order_visit_assignee() IS 'Keeps a visit assignment''s copy of the visit''s job, times and status true, refuses moving it, and admits only the job''s current crew to a planned visit.';

COMMENT ON FUNCTION propagate_work_order_visit() IS 'Refreshes a visit''s assignments after its times or status change; their guard copies the new values in.';

COMMENT ON FUNCTION protect_shift() IS 'Refuses changing who worked a shift or when it started, and changing a shift once it has ended.';

COMMENT ON FUNCTION queue_work_order_push() IS 'Queues push.work_order_event for an assignment, a reschedule, a dispatch or cancellation, a priority change, and a visit moved, cancelled, or given to or taken from someone.';

COMMENT ON FUNCTION record_qualification_override() IS 'Writes the job''s history when a visit goes ahead without a required qualification. Security definer: the runtime role cannot write the history.';

COMMENT ON FUNCTION record_work_order_assignment() IS 'Writes work_order_events when someone is assigned, unassigned, or made or unmade lead. Security definer, like record_work_order_change.';

COMMENT ON FUNCTION record_work_order_change() IS 'Writes work_order_events for creation, transitions, reschedules and edits. Security definer: the runtime role cannot write the history.';

COMMENT ON FUNCTION record_work_order_visit_assignee() IS 'Writes work_order_events when someone is added to or taken off a visit. Security definer, like record_work_order_assignment.';

COMMENT ON FUNCTION record_work_order_visit_change() IS 'Writes work_order_events when a visit is scheduled, moved, done or cancelled. Security definer: the runtime role cannot write the history.';

COMMENT ON FUNCTION reject_qualification_override_mutation() IS 'Refuses changing or deleting an override, except deleting while its company is purged.';

COMMENT ON FUNCTION remove_unassigned_from_visits() IS 'Takes a person off a job''s planned visits when they are taken off its crew.';

COMMENT ON FUNCTION touch_sync() IS 'Records that a row touched a synced record: tg_argv[0] is the record kind, tg_argv[1] the column naming it. Security definer: the runtime role cannot write sync_touches.';

COMMENT ON FUNCTION track_work_order_deadlines() IS 'Records when a job was first dispatched (response) and first completed, and closes its deadlines while it is cancelled.';

COMMENT ON FUNCTION work_order_happened_at(previous timestamp with time zone) IS 'The time a state change happened: integr8.happened_at when the API set it for a change recorded offline, kept between the previous state change and now; otherwise now().';

COMMENT ON FUNCTION work_order_transition_allowed(from_state text, to_state text) IS 'The work order state machine. Mirrored by WORK_ORDER_TRANSITIONS in @integr8/core, and checked against it by the schema-invariant suite.';

COMMENT ON TABLE attachments IS 'A file from the ledger shown on a customer, a site or a work order: site plans, manuals, previous reports. Removed rather than deleted.';

COMMENT ON COLUMN attachments.stage IS 'For a job photo: taken before the work started, or after it was done.';

COMMENT ON TABLE customers IS 'A company this company does work for. Closed rather than deleted: work orders and submissions keep pointing at it.';

COMMENT ON COLUMN customers.status IS 'active, on_hold (no new work without a word with accounts), closed (no new work).';

COMMENT ON COLUMN customers.is_demo IS 'Sample data loaded during onboarding (0018). Removable in one action, and the flag is cleared if somebody edits the row into something real.';

COMMENT ON TABLE imports IS 'A CSV import and its outcome, row by row. Each row is written or refused on its own, so one bad row never aborts the file.';

COMMENT ON TABLE job_type_qualifications IS 'The qualifications a job type''s jobs need. Copied to each new job, which can then change its own list.';

COMMENT ON TABLE job_types IS 'The kinds of job a company does, each carrying its forms, checklist, instructions and expected duration.';

COMMENT ON COLUMN job_types.before_photos IS 'Photos an engineer takes before starting work. Copied to each new job.';

COMMENT ON COLUMN job_types.after_photos IS 'Photos an engineer takes when the work is done. Copied to each new job.';

COMMENT ON COLUMN job_types.signature_required IS 'Whether a job of this type needs the customer to sign off before completing.';

COMMENT ON TABLE member_qualifications IS 'A skill or certificate a member holds. Renewal adds a record; the old one stays, expired. Removed rather than deleted.';

COMMENT ON TABLE qualification_types IS 'The skills and certificates a company tracks. A skill never expires; a certificate has dates. Archived rather than deleted.';

COMMENT ON TABLE shifts IS 'An engineer''s working day: clocked in and out on the phone, at the times the phone recorded. One open shift per person.';

COMMENT ON TABLE sites IS 'Where work happens. Belongs to one customer for good; archived rather than deleted.';

COMMENT ON COLUMN sites.access_hazards IS 'Safety hazards on arrival. With the other access_ columns, the first thing an engineer sees on a job.';

COMMENT ON TABLE work_order_comments IS 'Notes on a job. Internal notes and customer-visible notes are kept apart by visibility; neither is edited or deleted.';

COMMENT ON TABLE work_order_counters IS 'The last work order reference handed out per company. Written only by assign_work_order_reference.';

COMMENT ON TABLE work_order_events IS 'Append-only history of a work order: creation, every transition, reschedule, edit and assignment change. Written only by trigger.';

COMMENT ON COLUMN work_order_events.occurred_at IS 'When it happened. For a change a phone made offline, when the phone recorded it; otherwise when it was written.';

COMMENT ON COLUMN work_order_events.recorded_at IS 'When the server wrote it.';

COMMENT ON TABLE work_order_qualification_overrides IS 'A dispatcher planned a visit where nobody held a required qualification, and said why. Append-only.';

COMMENT ON TABLE work_order_qualifications IS 'The qualifications one job needs: at least one person on each of its visits holds each of them.';

COMMENT ON TABLE work_order_visit_assignees IS 'Who goes on a visit. Carries a copy of the visit''s times so that nobody can be on two overlapping planned visits of different jobs.';

COMMENT ON TABLE work_order_visits IS 'One trip to do a job: when, and (in work_order_visit_assignees) who. A job may have several. Planned, done or cancelled; done and cancelled are final.';

COMMENT ON TABLE work_orders IS 'A job: for a customer, at one of its sites, of a type. Its state moves only along the transitions enforce_work_order_state allows.';

COMMENT ON COLUMN work_orders.last_actor IS 'Who made the change being written. work_order_events records it.';

COMMENT ON COLUMN work_orders.signed_off_at IS 'When the customer signed off, by the phone that recorded it; or when the engineer recorded why nobody could.';

COMMENT ON CONSTRAINT work_order_visit_assignees_no_double_booking ON work_order_visit_assignees IS 'The same person on two overlapping planned visits of different jobs. Visits of the same job may overlap.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,UPDATE ON TABLE attachments TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE attachments TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE customer_contacts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE customer_contacts TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE customers TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE customers TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE imports TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE imports TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE job_type_qualifications TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE job_type_qualifications TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE job_types TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE job_types TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE member_qualifications TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE member_qualifications TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE qualification_types TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE qualification_types TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE saved_views TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE saved_views TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE shifts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE shifts TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE sites TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sites TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE work_order_assignments TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_assignments TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE work_order_checklist_items TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_checklist_items TO integr8_platform;

GRANT SELECT,INSERT ON TABLE work_order_comments TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_comments TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_counters TO integr8_platform;

GRANT SELECT ON TABLE work_order_events TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_events TO integr8_platform;

GRANT ALL ON SEQUENCE work_order_events_sequence_seq TO integr8_platform;

GRANT SELECT,INSERT ON TABLE work_order_qualification_overrides TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_qualification_overrides TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE work_order_qualifications TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_qualifications TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE work_order_visit_assignees TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_visit_assignees TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE work_order_visits TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_visits TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE work_orders TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_orders TO integr8_platform;

-- ---------------------------------------------------------------------------
-- Year partitions for the tables above (see 0001)
-- ---------------------------------------------------------------------------

SELECT ensure_year_partitions();
