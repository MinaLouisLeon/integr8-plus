-- Reverses 0025.
--
-- Drops every opportunity, its history, every activity and each company's
-- pipeline. Fine on a fresh or test database; on a live one, take a backup or a
-- company export first, because this is not recoverable from the database alone.

drop table crm_activity_opportunities;
drop table crm_activity_customers;
drop table crm_activity_leads;
drop table crm_activities;
drop table crm_opportunity_events;
drop table crm_opportunities;
drop function crm_opportunities_check_stage();
drop table crm_pipeline_stages;
drop table crm_pipelines;
