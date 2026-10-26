-- Reverses 0052.

alter table tenant_settings
  drop constraint tenant_settings_qualification_warning_days_bounds,
  drop column qualification_warning_days;

delete from attachments where member_qualification_id is not null;
drop index attachments_member_qualification_idx;
alter table attachments
  drop constraint attachments_one_owner,
  add constraint attachments_one_owner check (num_nonnulls(
    customer_id, site_id, work_order_id, asset_id, expense_claim_id, item_id, work_order_purchase_id) = 1),
  drop constraint attachments_member_qualification_fk,
  drop column member_qualification_id;

drop table if exists work_order_qualification_overrides;
drop function if exists record_qualification_override();
drop function if exists reject_qualification_override_mutation();

-- The history is append-only; rolling this migration back is the one time
-- override events are removed, so the older check can hold again.
alter table work_order_events disable trigger work_order_events_no_delete;
delete from work_order_events where kind = 'qualification_override';
alter table work_order_events enable trigger work_order_events_no_delete;
alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off',
    'visit_scheduled', 'visit_rescheduled', 'visit_done', 'visit_cancelled', 'visit_assigned', 'visit_unassigned'
  ));

drop table if exists work_order_qualifications;
drop table if exists job_type_qualifications;
drop table if exists member_qualifications;
drop function if exists guard_member_qualification();
drop table if exists qualification_types;
drop function if exists guard_qualification_type();
