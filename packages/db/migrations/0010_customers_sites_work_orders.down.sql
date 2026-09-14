-- 0010 - down. Drops customers, sites, job types, work orders and everything
-- attached to them, and unlinks submissions from jobs.

drop table if exists imports;
drop table if exists saved_views;
drop table if exists attachments;

drop trigger if exists submissions_work_order_guard on submissions;
drop function if exists guard_submission_work_order();
drop index if exists submissions_work_order_idx;
alter table submissions drop constraint if exists submissions_work_order_fk;
alter table submissions drop column if exists work_order_id;

drop trigger if exists work_order_events_no_truncate on work_order_events;
drop table if exists work_order_events;
drop function if exists reject_work_order_events_mutation();

drop table if exists work_order_comments;
drop table if exists work_order_assignments;
drop function if exists record_work_order_assignment();
drop function if exists guard_work_order_assignment();
drop table if exists work_order_checklist_items;
drop table if exists work_order_forms;
drop table if exists work_orders;
drop function if exists record_work_order_change();
drop function if exists enforce_work_order_state();
drop function if exists work_order_transition_allowed(text, text);
drop function if exists assign_work_order_reference();
drop table if exists work_order_counters;

drop table if exists job_type_forms;
drop table if exists job_types;

drop table if exists sites;
drop function if exists guard_site_change();
drop table if exists customer_contacts;
drop table if exists customers;
