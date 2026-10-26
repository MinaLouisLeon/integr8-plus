-- Reverses 0051. btree_gist and the extensions schema stay: see the up file.

drop trigger if exists work_orders_close_visits on work_orders;
drop function if exists close_work_order_visits();

drop trigger if exists work_order_assignments_leave_visits on work_order_assignments;
drop function if exists remove_unassigned_from_visits();

drop table if exists work_order_visit_assignees;
drop table if exists work_order_visits;

drop function if exists record_work_order_visit_assignee();
drop function if exists record_work_order_visit_change();
drop function if exists propagate_work_order_visit();
drop function if exists guard_work_order_visit_assignee();
drop function if exists guard_work_order_visit();

-- As in 0013.
create or replace function queue_work_order_push() returns trigger
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

-- The history is append-only; rolling this migration back is the one time visit
-- events are removed, so the older checks can hold again.
alter table work_order_events disable trigger work_order_events_no_delete;
delete from work_order_events where kind like 'visit\_%';
alter table work_order_events enable trigger work_order_events_no_delete;
alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off'
  )),
  drop constraint work_order_events_person_when_assignment,
  add constraint work_order_events_person_when_assignment
    check ((kind in ('assigned', 'unassigned', 'lead_changed')) = (user_id is not null));
