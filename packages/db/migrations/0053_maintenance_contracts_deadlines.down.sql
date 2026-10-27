-- Reverses 0053. Deletes every plan, contract and deadline record: for
-- development databases only.

-- qualifications.expiry stays: it belongs to 0052, which stays applied.
delete from scheduled_task_runs where task in ('maintenance.plans', 'deadlines.alerts');

drop trigger if exists work_orders_track_deadlines on work_orders;
drop function if exists track_work_order_deadlines();

drop table if exists work_order_deadlines;
drop function if exists guard_work_order_deadlines();
drop function if exists record_deadline_miss();
drop table if exists deadline_rules;

drop table if exists work_order_coverage;
drop function if exists record_coverage_change();

drop table if exists maintenance_occurrences;
drop function if exists record_maintenance_occurrence();
drop function if exists reject_maintenance_occurrence_mutation();
drop table if exists maintenance_plans;
drop function if exists guard_maintenance_plan();

drop table if exists service_contract_job_types;
drop table if exists service_contract_assets;
drop table if exists service_contract_sites;
drop table if exists service_contracts;
drop function if exists guard_service_contract();
drop function if exists assign_service_contract_reference();
drop table if exists service_contract_counters;

-- The history is append-only; rolling this migration back is the one time
-- these events are removed, so the older check can hold again.
alter table work_order_events disable trigger work_order_events_no_delete;
delete from work_order_events where kind in ('maintenance_planned', 'coverage_changed', 'deadline_missed');
alter table work_order_events enable trigger work_order_events_no_delete;
alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off',
    'visit_scheduled', 'visit_rescheduled', 'visit_done', 'visit_cancelled', 'visit_assigned', 'visit_unassigned',
    'qualification_override'
  ));
