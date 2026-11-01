delete from scheduled_task_runs where task = 'maintenance.retries';

create or replace function guard_maintenance_plan() returns trigger
language plpgsql
as $$
begin
  if new.asset_id is distinct from old.asset_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'maintenance plan % keeps its asset and creator', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.status = 'ended' then
    raise exception 'maintenance plan % has ended; add a new one instead', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The worker moving the next due date along is not an edit: whoever has the
  -- plan open can still save it.
  if (to_jsonb(new) - 'next_due_on' - 'next_sequence' - 'updated_at' - 'version')
     is distinct from (to_jsonb(old) - 'next_due_on' - 'next_sequence' - 'updated_at' - 'version') then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

comment on function guard_maintenance_plan() is
  'Keeps a plan''s asset, refuses changing an ended plan, and counts versions.';

drop index maintenance_plans_failing;
alter table maintenance_plans
  drop column failure_count,
  drop column last_error_at,
  drop column last_error;
