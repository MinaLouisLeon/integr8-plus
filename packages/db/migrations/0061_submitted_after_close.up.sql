-- 0061 - a form submitted after its job closed is accepted from a phone, and marked (P13, P14).
--
-- Until now only starting a form refused a closed job. Submitting a draft was
-- accepted whenever it arrived, from a screen or from a phone's outbox, so a
-- completed or cancelled job could quietly gain a report the office never
-- expected. The API now refuses the screens outright. A phone is different: an
-- engineer who filled the form on site, before the office closed the job, but
-- had no signal until later, did the work in time. Their submission is
-- accepted and marked here, the job's history says so, and the job screen shows
-- the office a badge. A form started after the job closed is refused, as before.
--
-- The mark is written only by the submit that sets it, and never changes after.

alter table submissions
  add column submitted_after_close boolean not null default false;

comment on column submissions.submitted_after_close is
  'Submitted from a phone after its job was completed, reviewed or cancelled, from a draft started before (0061). Written only by that submit.';

create function guard_submitted_after_close() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.submitted_after_close then
      raise exception 'submission % cannot start as submitted after close', new.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.submitted_after_close is distinct from old.submitted_after_close
     and not (not old.submitted_after_close and old.status = 'draft' and new.status = 'submitted') then
    raise exception 'submission % is marked submitted after close only by submitting its draft', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

create trigger submissions_after_close_guard
  before insert or update on submissions
  for each row execute function guard_submitted_after_close();

-- The job's history says so, like every other change to a job. Security definer
-- for the same reason as record_work_order_change: the history is written by
-- the database alone.
create function record_submitted_after_close() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.submitted_after_close and not old.submitted_after_close and new.work_order_id is not null then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
    select new.tenant_id, new.work_order_id, 'form_submitted_after_close', new.last_actor,
           jsonb_build_object('submissionId', new.id, 'formId', new.form_id, 'title', f.title)
      from public.forms f
     where f.tenant_id = new.tenant_id and f.id = new.form_id;
  end if;
  return null;
end;
$$;

create trigger submissions_after_close_history
  after update on submissions
  for each row execute function record_submitted_after_close();

alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off',
    'visit_scheduled', 'visit_rescheduled', 'visit_done', 'visit_cancelled', 'visit_assigned', 'visit_unassigned',
    'qualification_override',
    'maintenance_planned', 'coverage_changed', 'deadline_missed',
    'form_submitted_after_close'
  ));
