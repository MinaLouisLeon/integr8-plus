-- The subscription-controlled AI assistant (docs/ai; ADR-0001).
--
-- Platform-owned:
--   ai_plan_policies            what each plan allows, off until an admin says otherwise
--   ai_help_articles            the curated bilingual help the assistant answers from
--   ai_platform_cost_periods    the deployment's own monthly provider budget
--
-- Company-scoped (RLS, composite foreign keys, exported and purged with the company):
--   ai_tenant_policies          a company's override of its plan's policy, platform-written
--   ai_usage_periods            message counters per subject (company or member) and UTC period
--   ai_message_reservations     one row per admitted chat request: the idempotent charge record
--   ai_provider_calls           every call to a model, with tokens and cost in USD micros
--   ai_cost_periods             a company's monthly provider spend, reserved and settled
--   ai_conversations            a member's private chats
--   ai_messages                 what was said, user and assistant, with validated citations
--   ai_action_proposals         a prepared action waiting for the member's confirmation
--   ai_action_events            what happened to each proposal, append-only
--
-- Money is integer USD micros (1 USD = 1,000,000), never a float. Periods are
-- UTC calendar days and months keyed by their first instant as a date.

-- ---------------------------------------------------------------------------
-- Plan policies
-- ---------------------------------------------------------------------------

create table ai_plan_policies (
  plan                        text        primary key,
  level                       text        not null default 'off',
  quota_mode                  text,
  daily_limit                 integer,
  monthly_limit               integer,
  per_user_daily_limit        integer,
  per_user_monthly_limit      integer,
  -- A deliberate, audited choice: no message cap, only the cost ceiling.
  unlimited_messages          boolean     not null default false,
  monthly_cost_cap_microusd   bigint,
  max_input_tokens            integer     not null default 4000,
  max_output_tokens           integer     not null default 600,
  max_tool_steps              integer     not null default 1,
  max_provider_calls          integer     not null default 1,
  allow_history               boolean     not null default true,
  retention_days              integer     not null default 30,
  version                     integer     not null default 1,
  updated_at                  timestamptz not null default now(),
  -- Who last changed it: a platform user's id, kept as a plain value so a
  -- truncate of platform_users in a test never takes the policies with it.
  updated_by                  uuid,
  constraint ai_plan_policies_plan_known
    check (plan in ('trial', 'starter', 'standard', 'enterprise')),
  constraint ai_plan_policies_level_known
    check (level in ('off', 'help', 'insights', 'agent')),
  constraint ai_plan_policies_quota_mode_known
    check (quota_mode is null or quota_mode in ('daily', 'monthly', 'daily_and_monthly')),
  constraint ai_plan_policies_limits_positive check (
    (daily_limit is null or daily_limit > 0)
    and (monthly_limit is null or monthly_limit > 0)
    and (per_user_daily_limit is null or per_user_daily_limit > 0)
    and (per_user_monthly_limit is null or per_user_monthly_limit > 0)
    and (monthly_cost_cap_microusd is null or monthly_cost_cap_microusd > 0)
    and max_input_tokens > 0 and max_output_tokens > 0
    and max_tool_steps > 0 and max_provider_calls > 0
    and retention_days > 0 and version > 0
  ),
  -- A mode that names a period has a limit for it; an enabled level has a mode
  -- or is explicitly unlimited; off has neither.
  constraint ai_plan_policies_mode_consistent check (
    (level = 'off')
    or (unlimited_messages and quota_mode is null and monthly_cost_cap_microusd is not null)
    or (quota_mode = 'daily' and daily_limit is not null)
    or (quota_mode = 'monthly' and monthly_limit is not null)
    or (quota_mode = 'daily_and_monthly' and daily_limit is not null and monthly_limit is not null)
  )
);
comment on table ai_plan_policies is
  'What each subscription plan allows the assistant to do, by default off (ADR-0001). Platform-written; the runtime role holds nothing on it.';

insert into ai_plan_policies (plan) values ('trial'), ('starter'), ('standard'), ('enterprise');

alter table ai_plan_policies enable row level security;

-- ---------------------------------------------------------------------------
-- Company overrides
-- ---------------------------------------------------------------------------

create table ai_tenant_policies (
  tenant_id                   uuid        primary key references tenants (id) on delete cascade,
  mode                        text        not null default 'inherit',
  level                       text        not null default 'off',
  quota_mode                  text,
  daily_limit                 integer,
  monthly_limit               integer,
  per_user_daily_limit        integer,
  per_user_monthly_limit      integer,
  unlimited_messages          boolean     not null default false,
  monthly_cost_cap_microusd   bigint,
  max_input_tokens            integer     not null default 4000,
  max_output_tokens           integer     not null default 600,
  max_tool_steps              integer     not null default 1,
  max_provider_calls          integer     not null default 1,
  allow_history               boolean     not null default true,
  retention_days              integer     not null default 30,
  -- Whether this company's own records may be sent to the configured provider
  -- for L2 and L3. Independent of mode; off until the platform says otherwise.
  company_data_to_provider    boolean     not null default false,
  version                     integer     not null default 1,
  reason                      text,
  updated_at                  timestamptz not null default now(),
  -- Who last changed it: a platform user's id, kept as a plain value so a
  -- truncate of platform_users in a test never takes the policies with it.
  updated_by                  uuid,
  constraint ai_tenant_policies_mode_known check (mode in ('inherit', 'custom')),
  constraint ai_tenant_policies_level_known
    check (level in ('off', 'help', 'insights', 'agent')),
  constraint ai_tenant_policies_quota_mode_known
    check (quota_mode is null or quota_mode in ('daily', 'monthly', 'daily_and_monthly')),
  constraint ai_tenant_policies_limits_positive check (
    (daily_limit is null or daily_limit > 0)
    and (monthly_limit is null or monthly_limit > 0)
    and (per_user_daily_limit is null or per_user_daily_limit > 0)
    and (per_user_monthly_limit is null or per_user_monthly_limit > 0)
    and (monthly_cost_cap_microusd is null or monthly_cost_cap_microusd > 0)
    and max_input_tokens > 0 and max_output_tokens > 0
    and max_tool_steps > 0 and max_provider_calls > 0
    and retention_days > 0 and version > 0
  ),
  -- The custom fields only have to be consistent when they are the policy.
  constraint ai_tenant_policies_mode_consistent check (
    (mode = 'inherit')
    or (level = 'off')
    or (unlimited_messages and quota_mode is null and monthly_cost_cap_microusd is not null)
    or (quota_mode = 'daily' and daily_limit is not null)
    or (quota_mode = 'monthly' and monthly_limit is not null)
    or (quota_mode = 'daily_and_monthly' and daily_limit is not null and monthly_limit is not null)
  )
);
comment on table ai_tenant_policies is
  'A company''s assistant policy when it does not simply inherit its plan''s (ADR-0001). Written only by the platform; readable by the company about itself.';

grant select on ai_tenant_policies to integr8_app;
alter table ai_tenant_policies enable row level security;
create policy ai_tenant_policies_isolation on ai_tenant_policies
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- Message counters
-- ---------------------------------------------------------------------------

create table ai_usage_periods (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  subject_type       text        not null,
  subject_id         uuid        not null,
  period_type        text        not null,
  period_start_utc   date        not null,
  used_messages      integer     not null default 0,
  reserved_messages  integer     not null default 0,
  version            integer     not null default 1,
  updated_at         timestamptz not null default now(),
  constraint ai_usage_periods_subject_known check (subject_type in ('tenant', 'user')),
  constraint ai_usage_periods_period_known check (period_type in ('day', 'month')),
  constraint ai_usage_periods_non_negative check (used_messages >= 0 and reserved_messages >= 0),
  constraint ai_usage_periods_one_per_period
    unique (tenant_id, subject_type, subject_id, period_type, period_start_utc)
);
comment on table ai_usage_periods is
  'Messages used and reserved per company or member, per UTC day and month (ADR-0001). Locked in a fixed order when a request is admitted.';

grant select, insert, update on ai_usage_periods to integr8_app;
alter table ai_usage_periods enable row level security;
create policy ai_usage_periods_isolation on ai_usage_periods
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- Conversations and messages
-- ---------------------------------------------------------------------------

create table ai_conversations (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null references tenants (id) on delete cascade,
  created_by_user_id   uuid        not null,
  title                text,
  locale               text        not null default 'en',
  level_at_creation    text        not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint ai_conversations_tenant_id_unique unique (tenant_id, id),
  constraint ai_conversations_locale_known check (locale in ('en', 'ar')),
  constraint ai_conversations_level_known
    check (level_at_creation in ('help', 'insights', 'agent')),
  constraint ai_conversations_title_length check (title is null or length(title) <= 200)
);
create index ai_conversations_by_owner
  on ai_conversations (tenant_id, created_by_user_id, updated_at desc)
  where deleted_at is null;
comment on table ai_conversations is
  'A member''s private chats with the assistant (ADR-0001). Private to the member who started each; soft-deleted by them, swept by retention.';

grant select, insert, update on ai_conversations to integr8_app;
alter table ai_conversations enable row level security;
create policy ai_conversations_isolation on ai_conversations
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

create table ai_message_reservations (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references tenants (id) on delete cascade,
  user_id                  uuid        not null,
  conversation_id          uuid        not null,
  client_request_id        text        not null,
  request_fingerprint      text        not null,
  -- The UTC periods whose counters this reservation holds, fixed at admission
  -- so a settlement after midnight gives the slot back to the right day.
  period_day               date        not null,
  period_month             date        not null,
  state                    text        not null default 'reserved',
  reserved_message_units   integer     not null default 1,
  reserved_cost_microusd   bigint      not null default 0,
  settled_cost_microusd    bigint,
  provider_attempts        integer     not null default 0,
  last_error_code          text,
  response_message_id      uuid,
  created_at               timestamptz not null default now(),
  expires_at               timestamptz not null,
  settled_at               timestamptz,
  constraint ai_message_reservations_tenant_id_unique unique (tenant_id, id),
  constraint ai_message_reservations_one_per_request
    unique (tenant_id, user_id, client_request_id),
  constraint ai_message_reservations_conversation_fk
    foreign key (tenant_id, conversation_id) references ai_conversations (tenant_id, id) on delete cascade,
  constraint ai_message_reservations_state_known
    check (state in ('reserved', 'completed', 'released', 'expired', 'uncertain')),
  constraint ai_message_reservations_units_one check (reserved_message_units = 1),
  constraint ai_message_reservations_cost_non_negative
    check (reserved_cost_microusd >= 0 and (settled_cost_microusd is null or settled_cost_microusd >= 0)),
  constraint ai_message_reservations_request_id_length check (length(client_request_id) between 1 and 200)
);
create index ai_message_reservations_open
  on ai_message_reservations (tenant_id, expires_at)
  where state in ('reserved', 'uncertain');
comment on table ai_message_reservations is
  'One row per admitted chat request (ADR-0001): the idempotent record of whether it was charged. A completed one replays its stored answer.';

grant select, insert, update on ai_message_reservations to integr8_app;
alter table ai_message_reservations enable row level security;
create policy ai_message_reservations_isolation on ai_message_reservations
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

create table ai_messages (
  id                      uuid        primary key default gen_random_uuid(),
  tenant_id               uuid        not null references tenants (id) on delete cascade,
  conversation_id         uuid        not null,
  user_id                 uuid,
  role                    text        not null,
  content                 text        not null,
  source_refs             jsonb       not null default '[]'::jsonb,
  tool_summaries          jsonb       not null default '[]'::jsonb,
  action_proposal_id      uuid,
  usage_reservation_id    uuid,
  redacted                boolean     not null default false,
  created_at              timestamptz not null default now(),
  constraint ai_messages_tenant_id_unique unique (tenant_id, id),
  constraint ai_messages_conversation_fk
    foreign key (tenant_id, conversation_id) references ai_conversations (tenant_id, id) on delete cascade,
  constraint ai_messages_reservation_fk
    foreign key (tenant_id, usage_reservation_id) references ai_message_reservations (tenant_id, id) on delete set null,
  constraint ai_messages_role_known check (role in ('user', 'assistant', 'tool_summary')),
  constraint ai_messages_content_length check (length(content) <= 20000)
);
create index ai_messages_by_conversation
  on ai_messages (tenant_id, conversation_id, created_at, id);
comment on table ai_messages is
  'What was said in a conversation (ADR-0001). Never a provider secret, a raw provider trace or a record the member could not see themselves.';

grant select, insert, update on ai_messages to integr8_app;
alter table ai_messages enable row level security;
create policy ai_messages_isolation on ai_messages
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- Provider calls and cost
-- ---------------------------------------------------------------------------

create table ai_provider_calls (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  reservation_id     uuid        not null,
  provider           text        not null,
  model              text        not null,
  attempt_number     integer     not null default 1,
  purpose            text        not null,
  input_tokens       integer,
  output_tokens      integer,
  cached_tokens      integer,
  reasoning_tokens   integer,
  tokens_estimated   boolean     not null default true,
  cost_microusd      bigint      not null default 0,
  price_version      text        not null,
  status             text        not null,
  error_code         text,
  started_at         timestamptz not null,
  ended_at           timestamptz,
  constraint ai_provider_calls_tenant_id_unique unique (tenant_id, id),
  constraint ai_provider_calls_reservation_fk
    foreign key (tenant_id, reservation_id) references ai_message_reservations (tenant_id, id) on delete cascade,
  constraint ai_provider_calls_purpose_known check (purpose in ('help', 'insights', 'agent', 'other')),
  constraint ai_provider_calls_status_known check (status in ('success', 'failed', 'timeout', 'unknown')),
  constraint ai_provider_calls_non_negative check (
    attempt_number > 0 and cost_microusd >= 0
    and (input_tokens is null or input_tokens >= 0)
    and (output_tokens is null or output_tokens >= 0)
    and (cached_tokens is null or cached_tokens >= 0)
    and (reasoning_tokens is null or reasoning_tokens >= 0)
  )
);
create index ai_provider_calls_by_reservation on ai_provider_calls (tenant_id, reservation_id);
create index ai_provider_calls_by_time on ai_provider_calls (tenant_id, started_at desc);
comment on table ai_provider_calls is
  'Every call to a model (ADR-0001): tokens as reported or conservatively estimated, cost in USD micros at a versioned price. Calls can outnumber charged messages.';

grant select, insert, update on ai_provider_calls to integr8_app;
alter table ai_provider_calls enable row level security;
create policy ai_provider_calls_isolation on ai_provider_calls
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

create table ai_cost_periods (
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  period_start_utc   date        not null,
  reserved_microusd  bigint      not null default 0,
  spent_microusd     bigint      not null default 0,
  unknown_microusd   bigint      not null default 0,
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, period_start_utc),
  constraint ai_cost_periods_non_negative
    check (reserved_microusd >= 0 and spent_microusd >= 0 and unknown_microusd >= 0)
);
comment on table ai_cost_periods is
  'A company''s provider spend per UTC month (ADR-0001): reserved before a call, settled after, unknown when the provider never said.';

grant select, insert, update on ai_cost_periods to integr8_app;
alter table ai_cost_periods enable row level security;
create policy ai_cost_periods_isolation on ai_cost_periods
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- The deployment's own budget, acquired before any company's. Platform-only.
create table ai_platform_cost_periods (
  period_start_utc   date        primary key,
  reserved_microusd  bigint      not null default 0,
  spent_microusd     bigint      not null default 0,
  unknown_microusd   bigint      not null default 0,
  updated_at         timestamptz not null default now(),
  constraint ai_platform_cost_periods_non_negative
    check (reserved_microusd >= 0 and spent_microusd >= 0 and unknown_microusd >= 0)
);
comment on table ai_platform_cost_periods is
  'The whole deployment''s provider spend per UTC month (ADR-0001), reserved before a company''s share is. The runtime role holds nothing on it.';
alter table ai_platform_cost_periods enable row level security;

-- ---------------------------------------------------------------------------
-- Action proposals (L3)
-- ---------------------------------------------------------------------------

create table ai_action_proposals (
  id                          uuid        primary key default gen_random_uuid(),
  tenant_id                   uuid        not null references tenants (id) on delete cascade,
  user_id                     uuid        not null,
  conversation_id             uuid        not null,
  tool_key                    text        not null,
  typed_payload               jsonb       not null,
  payload_schema_version      integer     not null default 1,
  display_summary             jsonb       not null,
  request_digest              text        not null,
  resource_versions           jsonb       not null default '{}'::jsonb,
  state                       text        not null default 'pending',
  expires_at                  timestamptz not null,
  confirmed_at                timestamptz,
  result_resource_type        text,
  result_resource_id          uuid,
  result_summary              jsonb,
  execution_idempotency_key   text,
  error_code                  text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint ai_action_proposals_tenant_id_unique unique (tenant_id, id),
  constraint ai_action_proposals_conversation_fk
    foreign key (tenant_id, conversation_id) references ai_conversations (tenant_id, id) on delete cascade,
  constraint ai_action_proposals_state_known check (
    state in ('pending', 'confirmed', 'executing', 'completed', 'rejected', 'expired', 'failed')
  ),
  constraint ai_action_proposals_tool_key_shape check (tool_key ~ '^[a-z][a-z0-9_]{0,63}$')
);
create index ai_action_proposals_by_user
  on ai_action_proposals (tenant_id, user_id, created_at desc);
comment on table ai_action_proposals is
  'An action the assistant prepared and the member has not yet confirmed (ADR-0001). The payload is frozen; a change is a new proposal.';

grant select, insert, update on ai_action_proposals to integr8_app;
alter table ai_action_proposals enable row level security;
create policy ai_action_proposals_isolation on ai_action_proposals
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table ai_messages
  add constraint ai_messages_proposal_fk
    foreign key (tenant_id, action_proposal_id) references ai_action_proposals (tenant_id, id) on delete set null;

create table ai_action_events (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete cascade,
  proposal_id     uuid        not null,
  actor_user_id   uuid,
  action          text        not null,
  code            text,
  request_id      text,
  details         jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  constraint ai_action_events_proposal_fk
    foreign key (tenant_id, proposal_id) references ai_action_proposals (tenant_id, id) on delete cascade
);
create index ai_action_events_by_proposal on ai_action_events (tenant_id, proposal_id, created_at);
comment on table ai_action_events is
  'What happened to each proposal, append-only (ADR-0001): the runtime role may insert and read, never change.';

grant select, insert on ai_action_events to integr8_app;
alter table ai_action_events enable row level security;
create policy ai_action_events_isolation on ai_action_events
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- Help articles
-- ---------------------------------------------------------------------------

create table ai_help_articles (
  article_key      text        not null,
  locale           text        not null,
  module           text        not null,
  title            text        not null,
  summary          text        not null,
  body             text        not null,
  keywords         text[]      not null default '{}',
  app_route        text,
  help_url         text,
  feature          text,
  min_permission   text,
  source_commit    text,
  content_hash     text        not null,
  status           text        not null default 'published',
  published_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (article_key, locale),
  constraint ai_help_articles_key_shape check (article_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint ai_help_articles_locale_known check (locale in ('en', 'ar')),
  constraint ai_help_articles_status_known check (status in ('published', 'disabled')),
  constraint ai_help_articles_body_length check (length(body) <= 20000)
);
comment on table ai_help_articles is
  'The curated help the assistant cites (ADR-0001), in both languages, seeded from the checked-in manifest by content hash. Platform-only.';
alter table ai_help_articles enable row level security;

-- The retention sweep claims its daily turn here, like metering and dunning.
insert into scheduled_task_runs (task) values ('ai.retention');

-- ---------------------------------------------------------------------------
-- The company's own switches
-- ---------------------------------------------------------------------------

-- Which of its apps a company lets the assistant appear in, chosen at
-- onboarding and changed from company settings. They can only narrow what the
-- platform granted.
alter table tenant_settings
  add column ai_web_enabled     boolean not null default false,
  add column ai_desktop_enabled boolean not null default false,
  add column ai_mobile_enabled  boolean not null default false;

comment on column tenant_settings.ai_web_enabled is
  'Whether members see the assistant in the web app (ADR-0001). Narrows the platform grant; never widens it.';

-- Which members the company's admins let use the assistant. On by default so
-- that enabling a company is not also a visit to every member.
alter table tenant_users
  add column ai_enabled boolean not null default true;

comment on column tenant_users.ai_enabled is
  'Whether this member may use the assistant when the company has it (ADR-0001). Set by owners and admins.';
