-- Token allowances, members' shares of them, and members' dollar caps
-- (docs/ai/ADR-0002 D5–D7). Additive only: 0044 and 0045 are untouched, and
-- every existing policy keeps its meaning with its token limits null.
--
--   ai_plan_policies, ai_tenant_policies   + daily/monthly pooled token limits
--   ai_member_limits                       a member's percentage of the company's
--                                          allowance, and a platform-set dollar cap
--   ai_token_periods                       tokens used and held per company or
--                                          member, per UTC day and month
--   ai_member_cost_periods                 a member's provider spend per UTC month
--   ai_message_reservations                + the tokens a request holds and has used
--
-- Tokens are input plus output as the provider reported them. Cached input
-- and reasoning output are subsets of those and are never added again.

-- ---------------------------------------------------------------------------
-- Pooled token limits on the plan and the company override
-- ---------------------------------------------------------------------------

alter table ai_plan_policies
  add column daily_token_limit   bigint,
  add column monthly_token_limit bigint,
  add constraint ai_plan_policies_token_limits_positive check (
    (daily_token_limit is null or daily_token_limit > 0)
    and (monthly_token_limit is null or monthly_token_limit > 0)
  );
comment on column ai_plan_policies.daily_token_limit is
  'Input plus output tokens the whole company may use per UTC day. Null: no token limit on that axis (ADR-0002 D5).';
comment on column ai_plan_policies.monthly_token_limit is
  'Input plus output tokens the whole company may use per UTC month. Null: no token limit on that axis (ADR-0002 D5).';

alter table ai_tenant_policies
  add column daily_token_limit   bigint,
  add column monthly_token_limit bigint,
  add constraint ai_tenant_policies_token_limits_positive check (
    (daily_token_limit is null or daily_token_limit > 0)
    and (monthly_token_limit is null or monthly_token_limit > 0)
  );

-- ---------------------------------------------------------------------------
-- A member's share of the company's allowance
-- ---------------------------------------------------------------------------

create table ai_member_limits (
  tenant_id                   uuid        not null references tenants (id) on delete cascade,
  user_id                     uuid        not null,
  -- The member's reserved slice of every company allowance, in whole
  -- percent. Null: no share, so no assistant (ADR-0002 D6). A company's
  -- shares total 100 or less, checked by the repository under a lock.
  share_percent               integer,
  -- Set by the platform admin only, and never shown to the company (D7).
  monthly_cost_cap_microusd   bigint,
  version                     integer     not null default 1,
  updated_at                  timestamptz not null default now(),
  -- A company member's or a platform user's id, kept as a plain value.
  updated_by                  uuid,
  primary key (tenant_id, user_id),
  constraint ai_member_limits_member_fk
    foreign key (tenant_id, user_id) references tenant_users (tenant_id, user_id) on delete cascade,
  constraint ai_member_limits_share_range
    check (share_percent is null or share_percent between 1 and 100),
  constraint ai_member_limits_cost_cap_positive
    check (monthly_cost_cap_microusd is null or monthly_cost_cap_microusd > 0),
  constraint ai_member_limits_version_positive check (version > 0)
);
comment on table ai_member_limits is
  'Each member''s percentage of the company''s assistant allowance, and an optional platform-set monthly dollar cap (ADR-0002 D6, D7).';

grant select, insert, update, delete on ai_member_limits to integr8_app;
alter table ai_member_limits enable row level security;
create policy ai_member_limits_isolation on ai_member_limits
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- Token counters
-- ---------------------------------------------------------------------------

create table ai_token_periods (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  subject_type       text        not null,
  subject_id         uuid        not null,
  period_type        text        not null,
  period_start_utc   date        not null,
  used_tokens        bigint      not null default 0,
  reserved_tokens    bigint      not null default 0,
  updated_at         timestamptz not null default now(),
  constraint ai_token_periods_subject_known check (subject_type in ('tenant', 'user')),
  constraint ai_token_periods_period_known check (period_type in ('day', 'month')),
  constraint ai_token_periods_non_negative check (used_tokens >= 0 and reserved_tokens >= 0),
  constraint ai_token_periods_one_per_period
    unique (tenant_id, subject_type, subject_id, period_type, period_start_utc)
);
comment on table ai_token_periods is
  'Tokens used and held per company or member, per UTC day and month (ADR-0002 D5). Held before each model call, settled to the reported total after it, locked in the same order as the message counters.';

grant select, insert, update on ai_token_periods to integr8_app;
alter table ai_token_periods enable row level security;
create policy ai_token_periods_isolation on ai_token_periods
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- A member's spend
-- ---------------------------------------------------------------------------

create table ai_member_cost_periods (
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  user_id            uuid        not null,
  period_start_utc   date        not null,
  reserved_microusd  bigint      not null default 0,
  spent_microusd     bigint      not null default 0,
  unknown_microusd   bigint      not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, user_id, period_start_utc),
  constraint ai_member_cost_periods_non_negative
    check (reserved_microusd >= 0 and spent_microusd >= 0 and unknown_microusd >= 0)
);
comment on table ai_member_cost_periods is
  'One member''s share of the company''s provider spend per UTC month (ADR-0002 D7). The same calls as ai_cost_periods, attributed: never a second charge.';

grant select, insert, update on ai_member_cost_periods to integr8_app;
alter table ai_member_cost_periods enable row level security;
create policy ai_member_cost_periods_isolation on ai_member_cost_periods
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- What a request holds and has used, in tokens
-- ---------------------------------------------------------------------------

alter table ai_message_reservations
  -- Tokens held for the call in flight, given back or charged when it ends.
  add column reserved_tokens bigint not null default 0,
  -- Tokens the request's calls have used so far, as reported or held.
  add column used_tokens     bigint not null default 0,
  add constraint ai_message_reservations_tokens_non_negative
    check (reserved_tokens >= 0 and used_tokens >= 0);
