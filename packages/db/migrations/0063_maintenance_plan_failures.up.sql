-- 0063 - a maintenance plan that fails is recorded on the plan, alone (P27).
--
-- The worker made every company's due jobs in one transaction, its turn
-- claimed for 20 hours. One plan that could not make its job — a customer
-- since closed, a job type a trigger refuses, anything — rolled back every
-- other plan of the company with it, and nobody heard until the next day's run
-- failed the same way.
--
-- Each plan now runs in its own savepoint. A failing plan is rolled back alone
-- and its failure kept here: what went wrong, when, and how many times in a
-- row. The plan's Maintenance screen shows it as a warning, the staff
-- dashboard's Health page lists it, and the worker retries that plan alone on
-- its next cycle, about every fifteen minutes, rather than the next day. After
-- five failures in a row it stops retrying, and keeps the warning, until
-- someone edits the plan; any edit (or pause, resume) starts the count again.
-- A successful run clears it.
--
-- The failure columns are the worker's bookkeeping, not an edit: like the next
-- due date they do not count a version, so whoever has the plan open can still
-- save it.

alter table maintenance_plans
  add column last_error      text,
  add column last_error_at   timestamptz,
  add column failure_count   integer not null default 0,
  add constraint maintenance_plans_failure_count_range check (failure_count >= 0),
  add constraint maintenance_plans_last_error_length
    check (last_error is null or char_length(last_error) <= 2000),
  add constraint maintenance_plans_last_error_pairing
    check ((last_error is null) = (last_error_at is null));

comment on column maintenance_plans.last_error is
  'Why the worker last failed to make this plan''s jobs; null once it succeeds or the plan is edited (0063).';
comment on column maintenance_plans.failure_count is
  'Failures in a row. The worker retries the plan alone each cycle until this reaches 5, then waits for an edit (0063).';

create index maintenance_plans_failing on maintenance_plans (tenant_id, last_error_at)
  where last_error is not null;

-- Otherwise as in 0053: the worker's columns do not count a version, and an
-- edit (anything that does) clears the failure so the worker tries again.
create or replace function guard_maintenance_plan() returns trigger
language plpgsql
as $$
declare
  bookkeeping text[] := array['next_due_on', 'next_sequence', 'updated_at', 'version',
                              'last_error', 'last_error_at', 'failure_count'];
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
  -- The worker moving the next due date along, or noting a failure, is not an
  -- edit: whoever has the plan open can still save it.
  if (to_jsonb(new) - bookkeeping) is distinct from (to_jsonb(old) - bookkeeping) then
    new.version := old.version + 1;
    new.last_error := null;
    new.last_error_at := null;
    new.failure_count := 0;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

comment on function guard_maintenance_plan() is
  'Keeps a plan''s asset, refuses changing an ended plan, counts versions, and clears a failure on an edit (0063).';

-- The retries' own turn, claimed every few minutes like the deadline alerts.
insert into scheduled_task_runs (task) values ('maintenance.retries')
on conflict (task) do nothing;
