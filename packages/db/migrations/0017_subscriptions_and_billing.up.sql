-- P17 — Subscriptions and billing.
--
-- A company can pay, and what they pay for is enforced by the API rather than
-- by the screens. Three things arrive here:
--
--   plan_allowances gains the rest of the plan   seats and submissions, beside
--                                                the storage half P16 built
--   subscriptions                                what one company is paying for,
--                                                and where it stands
--   billing_events                               every webhook the provider
--                                                sent, once
--
-- The provider is deliberately not named in any column type. Stripe is what we
-- will use, but a market that needs a regional provider must not require a
-- migration — so the provider is a string beside its own identifiers, and the
-- entitlement layer above never learns which one it is.
--
-- Read-only is the other half of this phase and it lives on `tenants`, beside
-- suspension, because it is the same kind of fact about the same row and the
-- request pipeline already reads it.

-- ---------------------------------------------------------------------------
-- The rest of what a plan allows
-- ---------------------------------------------------------------------------

alter table plan_allowances
  -- Null is uncapped, consistent with storage_bytes.
  add column seats                 integer,
  add column submissions_per_month integer,
  -- What a plan costs, for a screen to show. The provider holds the real
  -- prices and does the arithmetic; this is a label, and it is nullable so a
  -- deployment that has not set prices up shows nothing rather than zero.
  add column price_cents           integer,
  add column currency              text,
  -- What the provider calls this plan, so a checkout can be started for it.
  -- Two, because annual pricing is a different price at the provider and the
  -- same plan here.
  add column provider_price_monthly text,
  add column provider_price_yearly  text;

alter table plan_allowances
  add constraint plan_allowances_seats_sane
    check (seats is null or seats > 0),
  add constraint plan_allowances_submissions_sane
    check (submissions_per_month is null or submissions_per_month > 0),
  add constraint plan_allowances_price_sane
    check (price_cents is null or price_cents >= 0),
  -- A price without a currency is a number nobody can render.
  add constraint plan_allowances_currency_pair
    check ((price_cents is null) = (currency is null)),
  add constraint plan_allowances_currency_shape
    check (currency is null or currency ~ '^[A-Z]{3}$');

-- The starting point, and like P16's storage numbers these are editable from
-- the dashboard rather than fixed here. Trial has one seat because a trial is
-- one person deciding whether this is worth buying.
update plan_allowances set seats = 3,    submissions_per_month = 100   where plan = 'trial';
update plan_allowances set seats = 10,   submissions_per_month = 2000  where plan = 'starter';
update plan_allowances set seats = 50,   submissions_per_month = 20000 where plan = 'standard';
update plan_allowances set seats = null, submissions_per_month = null  where plan = 'enterprise';

-- ---------------------------------------------------------------------------
-- Read-only, which is not suspension
-- ---------------------------------------------------------------------------

alter table tenants
  -- Set when a trial lapses or dunning runs out of patience. Reads keep
  -- working; writes are refused. A company that pays late is still a customer,
  -- and one whose data you deleted is a lawsuit.
  add column read_only_since  timestamptz,
  add column read_only_reason text;

alter table tenants
  add constraint tenants_read_only_pair
    check ((read_only_since is null) = (read_only_reason is null));

comment on column tenants.read_only_since is
  'Non-payment or a lapsed trial (0017). Distinct from suspended: a suspended company is refused everything, a read-only one can still sign in, read, export and pay.';

-- ---------------------------------------------------------------------------
-- What a company is paying for
-- ---------------------------------------------------------------------------

create table subscriptions (
  tenant_id                uuid        primary key references tenants (id) on delete restrict,
  provider                 text        not null,
  -- What the provider calls this customer and this subscription. Null until a
  -- checkout completes: a company on a trial has no subscription yet.
  provider_customer_id     text,
  provider_subscription_id text,
  status                   text        not null default 'trialing',
  plan                     text        not null default 'trial',
  billing_interval         text,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean     not null default false,
  trial_ends_at            timestamptz,
  -- Dunning. `past_due_since` starts the clock; `grace_ends_at` is when
  -- read-only arrives if nothing has been paid.
  past_due_since           timestamptz,
  grace_ends_at            timestamptz,
  -- How many reminders this company has been shown, so the dunning job does
  -- not post the same banner every night.
  reminders_sent           integer     not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint subscriptions_status_known
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'incomplete')),
  constraint subscriptions_plan_known
    check (plan in ('trial', 'starter', 'standard', 'enterprise')),
  constraint subscriptions_interval_known
    check (billing_interval is null or billing_interval in ('month', 'year')),
  constraint subscriptions_period_order
    check (
      current_period_start is null
      or current_period_end is null
      or current_period_end > current_period_start
    ),
  constraint subscriptions_dunning_pair
    check ((past_due_since is null) = (grace_ends_at is null)),
  constraint subscriptions_reminders_sane check (reminders_sent >= 0),
  -- One subscription per company at the provider, so a duplicated webhook
  -- cannot quietly attach a second.
  constraint subscriptions_provider_subscription_unique
    unique (provider, provider_subscription_id)
);

comment on table subscriptions is
  'What one company is paying for and where it stands (0017). The provider is a string rather than a type, because a market needing a regional provider must not need a migration; nothing above this table learns which one it is.';

create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

create index subscriptions_dunning_idx
  on subscriptions (grace_ends_at) where grace_ends_at is not null;

create index subscriptions_trial_idx
  on subscriptions (trial_ends_at) where status = 'trialing';

-- ---------------------------------------------------------------------------
-- Every webhook, once
-- ---------------------------------------------------------------------------

create table billing_events (
  id                 uuid        primary key default gen_random_uuid(),
  provider           text        not null,
  -- The provider's own id for the delivery. The unique index is the whole
  -- idempotency mechanism: a duplicate delivery loses the insert and does
  -- nothing. The request-level `idempotency_keys` table cannot serve here —
  -- it is scoped to a company, and a webhook arrives before we know which.
  provider_event_id  text        not null,
  type               text        not null,
  -- Null when the event names a customer we do not recognise, which is worth
  -- keeping rather than discarding: it is usually a test delivery, or a
  -- customer created in a different environment against the same account.
  tenant_id          uuid        references tenants (id) on delete set null,
  payload            jsonb       not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  error              text,

  constraint billing_events_provider_event_unique unique (provider, provider_event_id)
);

comment on table billing_events is
  'Every webhook the billing provider delivered, kept whether or not it was understood (0017). The unique constraint on the provider event id is what makes a duplicate delivery a no-op.';

create index billing_events_recent_idx on billing_events (received_at desc);
create index billing_events_unprocessed_idx
  on billing_events (received_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- A company reads its own subscription, to see what it is paying for and when
-- the card last failed. It writes nothing: every change comes from the
-- provider's webhook or from the platform.
grant select on subscriptions to integr8_app;

alter table subscriptions  enable row level security;
alter table billing_events enable row level security;

create policy subscriptions_isolation on subscriptions
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- `billing_events` carries a nullable tenant_id, so it cannot be isolated the
-- usual way and holds no grant for the runtime role at all. It is the
-- platform's record of what the provider said.
create policy billing_events_platform_only on billing_events using (false);

-- The dunning job needs a turn of its own; see 0016 for why this table exists.
insert into scheduled_task_runs (task) values ('billing.dunning');
