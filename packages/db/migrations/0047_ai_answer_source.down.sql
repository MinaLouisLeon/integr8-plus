-- Reverses 0047. Fails, on purpose, while any policy is unlimited under the
-- library with no cost ceiling: give it a ceiling or a quota first.

alter table ai_tenant_policies
  drop constraint ai_tenant_policies_mode_consistent,
  add constraint ai_tenant_policies_mode_consistent check (
    (mode = 'inherit')
    or (level = 'off')
    or (unlimited_messages and quota_mode is null and monthly_cost_cap_microusd is not null)
    or (quota_mode = 'daily' and daily_limit is not null)
    or (quota_mode = 'monthly' and monthly_limit is not null)
    or (quota_mode = 'daily_and_monthly' and daily_limit is not null and monthly_limit is not null)
  );
alter table ai_tenant_policies
  drop constraint ai_tenant_policies_answer_source_known,
  drop column answer_source;

alter table ai_plan_policies
  drop constraint ai_plan_policies_mode_consistent,
  add constraint ai_plan_policies_mode_consistent check (
    (level = 'off')
    or (unlimited_messages and quota_mode is null and monthly_cost_cap_microusd is not null)
    or (quota_mode = 'daily' and daily_limit is not null)
    or (quota_mode = 'monthly' and monthly_limit is not null)
    or (quota_mode = 'daily_and_monthly' and daily_limit is not null and monthly_limit is not null)
  );
alter table ai_plan_policies
  drop constraint ai_plan_policies_answer_source_known,
  drop column answer_source;
