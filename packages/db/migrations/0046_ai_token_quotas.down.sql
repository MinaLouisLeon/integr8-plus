-- Reverses 0046. In production, prefer leaving it applied: rolling back
-- loses the token accounting and every member's share (ADR-0002, RUNBOOK).

alter table ai_message_reservations
  drop constraint ai_message_reservations_tokens_non_negative,
  drop column used_tokens,
  drop column reserved_tokens;

drop table ai_member_cost_periods;
drop table ai_token_periods;
drop table ai_member_limits;

alter table ai_tenant_policies
  drop constraint ai_tenant_policies_token_limits_positive,
  drop column monthly_token_limit,
  drop column daily_token_limit;

alter table ai_plan_policies
  drop constraint ai_plan_policies_token_limits_positive,
  drop column monthly_token_limit,
  drop column daily_token_limit;
