drop trigger if exists work_order_events_queue_push on work_order_events;
drop function if exists queue_work_order_push();
drop table if exists push_devices;

drop trigger if exists shifts_protect on shifts;
drop function if exists protect_shift();
drop table if exists shifts;

-- The history and the state machine as 0010 wrote them.
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

create or replace function enforce_work_order_state() returns trigger
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

-- The history is append-only; rolling this migration back is the one time sign-off
-- events are removed, so the older kind check can hold again.
alter table work_order_events disable trigger work_order_events_no_delete;
delete from work_order_events where kind = 'signed_off';
alter table work_order_events enable trigger work_order_events_no_delete;
alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed'
  ));

drop index if exists attachments_work_order_stage_idx;
alter table attachments
  drop constraint if exists attachments_stage_is_job_photo,
  drop constraint if exists attachments_stage_known,
  drop column if exists stage;

alter table work_orders
  drop constraint if exists work_orders_signoff_shape,
  drop constraint if exists work_orders_signoff_file_fk,
  drop constraint if exists work_orders_photo_counts,
  drop column if exists signoff_unavailable_reason,
  drop column if exists signoff_role,
  drop column if exists signoff_name,
  drop column if exists signoff_file_id,
  drop column if exists signed_off_by,
  drop column if exists signed_off_at,
  drop column if exists signature_required,
  drop column if exists after_photos,
  drop column if exists before_photos;

alter table job_types
  drop constraint if exists job_types_photo_counts,
  drop column if exists signature_required,
  drop column if exists after_photos,
  drop column if exists before_photos;

drop function if exists work_order_happened_at(timestamptz);

alter table work_order_events
  drop column if exists recorded_at;
