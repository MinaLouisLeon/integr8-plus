-- Removes the assistant module (see the up file).

drop table if exists
  ai_member_cost_periods,
  ai_token_periods,
  ai_member_limits,
  ai_help_articles,
  ai_action_events,
  ai_action_proposals,
  ai_platform_cost_periods,
  ai_cost_periods,
  ai_provider_calls,
  ai_messages,
  ai_message_reservations,
  ai_conversations,
  ai_usage_periods,
  ai_tenant_policies,
  ai_plan_policies
cascade;
