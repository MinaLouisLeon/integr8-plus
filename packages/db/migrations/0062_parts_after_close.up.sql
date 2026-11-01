-- 0062 - parts on closed, cancelled and invoiced jobs (CRM/ERP plan, phase E2; ADR-0005).
--
-- Recording a part ignored the job's state. A job is invoiced once
-- (`job_already_invoiced`), so a part recorded after that was never billed,
-- and a part on a cancelled job was stock gone for a job that never happened.
--
-- The API now refuses the office's screens on a completed, reviewed,
-- cancelled or invoiced job (returns of unused parts stay allowed). A phone
-- that recorded the part on site before the job closed, and synced later, did
-- the work in time: its part is accepted, posted to stock and the job's cost as
-- any other, and marked here. When it lands on a job already invoiced, the job
-- shows "parts not yet billed" and the office raises a follow-up invoice for it.
--
-- A cancelled job takes no parts at all, from any client: refused below.

alter table erp_work_order_materials
  add column recorded_after_close boolean not null default false;

comment on column erp_work_order_materials.recorded_after_close is
  'Recorded on a phone before its job closed and synced after (0062). Set when the row is written; never changes.';

create function guard_work_order_material_job() returns trigger
language plpgsql
as $$
declare
  job_state text;
begin
  if tg_op = 'INSERT' then
    select w.state into job_state
      from work_orders w
     where w.tenant_id = new.tenant_id and w.id = new.work_order_id;
    if job_state = 'cancelled' then
      raise exception 'work order % is cancelled; no parts can be recorded on it', new.work_order_id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    return new;
  end if;
  if new.recorded_after_close is distinct from old.recorded_after_close then
    raise exception 'part % keeps whether it was recorded after its job closed', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

comment on function guard_work_order_material_job() is
  'Refuses a part recorded on a cancelled job, and keeps recorded_after_close as written (0062).';

create trigger erp_work_order_materials_job_guard
  before insert or update on erp_work_order_materials
  for each row execute function guard_work_order_material_job();
