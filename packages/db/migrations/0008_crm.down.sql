-- Removes the crm module (see the up file).

drop table if exists
  crm_activity_opportunities,
  crm_activity_customers,
  crm_activity_leads,
  crm_activities,
  crm_opportunity_amounts,
  crm_opportunity_events,
  crm_opportunities,
  crm_pipeline_stages,
  crm_pipelines,
  crm_leads
cascade;
drop function if exists crm_leads_guard_conversion();
drop function if exists crm_opportunities_check_stage();
drop function if exists crm_opportunity_record_amount();
