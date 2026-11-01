-- The history is append-only; rolling this migration back is the one time
-- these events are removed, so the older check can hold again.
alter table work_order_events disable trigger work_order_events_no_delete;
delete from work_order_events where kind = 'form_submitted_after_close';
alter table work_order_events enable trigger work_order_events_no_delete;
alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off',
    'visit_scheduled', 'visit_rescheduled', 'visit_done', 'visit_cancelled', 'visit_assigned', 'visit_unassigned',
    'qualification_override',
    'maintenance_planned', 'coverage_changed', 'deadline_missed'
  ));

drop trigger submissions_after_close_history on submissions;
drop function record_submitted_after_close();
drop trigger submissions_after_close_guard on submissions;
drop function guard_submitted_after_close();
alter table submissions drop column submitted_after_close;
