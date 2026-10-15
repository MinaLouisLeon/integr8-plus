-- Reverses 0044.

alter table tenant_users drop column ai_enabled;
alter table tenant_settings
  drop column ai_web_enabled,
  drop column ai_desktop_enabled,
  drop column ai_mobile_enabled;

drop table ai_help_articles;
drop table ai_action_events;
alter table ai_messages drop constraint ai_messages_proposal_fk;
drop table ai_action_proposals;
drop table ai_platform_cost_periods;
drop table ai_cost_periods;
drop table ai_provider_calls;
drop table ai_messages;
drop table ai_message_reservations;
drop table ai_conversations;
drop table ai_usage_periods;
drop table ai_tenant_policies;
drop table ai_plan_policies;
