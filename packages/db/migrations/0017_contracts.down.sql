-- Removes the contracts module (see the up file).

drop table if exists
  work_order_deadlines,
  deadline_rules,
  work_order_coverage,
  maintenance_occurrences,
  maintenance_plans,
  service_contract_job_types,
  service_contract_assets,
  service_contract_sites,
  service_contracts,
  service_contract_counters
cascade;
drop function if exists assign_service_contract_reference();
drop function if exists guard_maintenance_plan();
drop function if exists guard_service_contract();
drop function if exists guard_work_order_deadlines();
drop function if exists record_coverage_change();
drop function if exists record_deadline_miss();
drop function if exists record_maintenance_occurrence();
drop function if exists reject_maintenance_occurrence_mutation();
