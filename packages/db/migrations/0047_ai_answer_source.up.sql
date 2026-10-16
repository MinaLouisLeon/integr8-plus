-- Where a policy's answers come from (docs/ai/ADR-0002 D9–D12). Additive:
-- every existing plan and company policy keeps answering with a model.
--
--   model    a provider phrases the answer, as before
--   library  the help library answers by itself: no provider, no tokens, no
--            money, Help only
--
-- Library answers spend nothing, so the consistency check stops asking an
-- unlimited library policy for a cost ceiling. A model policy still needs one.

alter table ai_plan_policies
  add column answer_source text not null default 'model',
  add constraint ai_plan_policies_answer_source_known
    check (answer_source in ('model', 'library'));
comment on column ai_plan_policies.answer_source is
  'Where answers come from: a model, or the help library with no provider (ADR-0002 D9, D10).';

alter table ai_plan_policies
  drop constraint ai_plan_policies_mode_consistent,
  add constraint ai_plan_policies_mode_consistent check (
    (level = 'off')
    or (unlimited_messages and quota_mode is null
        and (monthly_cost_cap_microusd is not null or answer_source = 'library'))
    or (quota_mode = 'daily' and daily_limit is not null)
    or (quota_mode = 'monthly' and monthly_limit is not null)
    or (quota_mode = 'daily_and_monthly' and daily_limit is not null and monthly_limit is not null)
  );

alter table ai_tenant_policies
  add column answer_source text not null default 'model',
  add constraint ai_tenant_policies_answer_source_known
    check (answer_source in ('model', 'library'));
comment on column ai_tenant_policies.answer_source is
  'Where answers come from for this company when its policy is custom (ADR-0002 D9, D10).';

alter table ai_tenant_policies
  drop constraint ai_tenant_policies_mode_consistent,
  add constraint ai_tenant_policies_mode_consistent check (
    (mode = 'inherit')
    or (level = 'off')
    or (unlimited_messages and quota_mode is null
        and (monthly_cost_cap_microusd is not null or answer_source = 'library'))
    or (quota_mode = 'daily' and daily_limit is not null)
    or (quota_mode = 'monthly' and monthly_limit is not null)
    or (quota_mode = 'daily_and_monthly' and daily_limit is not null and monthly_limit is not null)
  );
