-- Removes the field work module (see the up file).

drop table if exists
  work_order_qualification_overrides,
  work_order_qualifications,
  job_type_qualifications,
  member_qualifications,
  qualification_types,
  work_order_visit_assignees,
  work_order_visits,
  shifts,
  imports,
  saved_views,
  attachments,
  work_order_events,
  work_order_comments,
  work_order_assignments,
  work_order_checklist_items,
  work_orders,
  work_order_counters,
  job_types,
  sites,
  customer_contacts,
  customers
cascade;
drop function if exists assign_work_order_reference();
drop function if exists close_work_order_visits();
drop function if exists enforce_work_order_form_signoff();
drop function if exists enforce_work_order_state();
drop function if exists guard_member_qualification();
drop function if exists guard_qualification_type();
drop function if exists guard_site_change();
drop function if exists guard_work_order_assignment();
drop function if exists guard_work_order_visit();
drop function if exists guard_work_order_visit_assignee();
drop function if exists propagate_work_order_visit();
drop function if exists protect_shift();
drop function if exists queue_work_order_push();
drop function if exists record_qualification_override();
drop function if exists record_work_order_assignment();
drop function if exists record_work_order_change();
drop function if exists record_work_order_visit_assignee();
drop function if exists record_work_order_visit_change();
drop function if exists reject_qualification_override_mutation();
drop function if exists reject_work_order_events_mutation();
drop function if exists remove_unassigned_from_visits();
drop function if exists touch_sync();
drop function if exists track_work_order_deadlines();
drop function if exists work_order_happened_at(timestamp with time zone);
drop function if exists work_order_transition_allowed(text, text);
drop sequence if exists work_order_events_sequence_seq;
