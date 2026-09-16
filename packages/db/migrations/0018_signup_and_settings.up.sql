-- P18 — Self-serve onboarding.
--
-- Until now a company existed only because a super admin made one. Three
-- tables let a stranger make their own, let you see where strangers give up,
-- and let a company say how it works:
--
--   signup_requests   somebody asking for a company, before there is one
--   signup_events     the funnel, including the steps that happen before any
--                     company exists to attribute them to
--   tenant_settings   branding, hours, timezone, currency and locale
--
-- The first two belong to no company by construction: they record what happens
-- *before* a tenant exists, which is exactly why `audit_log` cannot hold them —
-- it is tenant-scoped, and a signup that is abandoned never gets a tenant.

-- ---------------------------------------------------------------------------
-- Somebody asking for a company
-- ---------------------------------------------------------------------------

create table signup_requests (
  id              uuid        primary key default gen_random_uuid(),
  email           text        not null,
  company_name    text        not null,
  -- Only the hash. The token goes to one place — the verification email — and
  -- holding it grants a company, so it is treated exactly as an invitation
  -- token is: 256 random bits, stored hashed, expiring.
  token_hash      text        not null,
  status          text        not null default 'pending',
  expires_at      timestamptz not null,
  verified_at     timestamptz,
  -- Set once verification has actually created the company. Null while
  -- pending, and null for ever on one that was abandoned.
  tenant_id       uuid        references tenants (id) on delete set null,
  -- Kept for abuse investigation, not for analytics.
  ip_address      inet,
  user_agent      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint signup_requests_status_known
    check (status in ('pending', 'verified', 'expired', 'abandoned')),
  constraint signup_requests_token_unique unique (token_hash),
  -- A verified request names the company it made, and a pending one cannot.
  constraint signup_requests_verified_pair
    check ((status = 'verified') = (verified_at is not null)),
  constraint signup_requests_email_shape check (position('@' in email) > 1)
);

comment on table signup_requests is
  'Somebody asking for a company, before one exists (0018). Nothing is provisioned until the emailed token comes back: no tenant, no bucket, no trial. A request nobody verifies simply expires.';

create index signup_requests_email_idx on signup_requests (lower(email), created_at desc);
create index signup_requests_pending_idx
  on signup_requests (expires_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- The funnel
-- ---------------------------------------------------------------------------

create table signup_events (
  id          uuid        primary key default gen_random_uuid(),
  -- Which step. Deliberately a free string rather than a check constraint:
  -- the steps will change as the funnel does, and a migration to add a step
  -- is a migration nobody writes, so the funnel would stop being instrumented
  -- instead.
  step        text        not null,
  -- Ties the steps of one attempt together. Present even for a visitor who
  -- never submits anything, which is the whole point of measuring drop-off.
  signup_id   uuid        references signup_requests (id) on delete set null,
  tenant_id   uuid        references tenants (id) on delete set null,
  -- Anything worth knowing about the step: the plan chosen, the error shown.
  -- Never an address, and never anything that identifies a person: this table
  -- answers "how many gave up here", not "who".
  metadata    jsonb       not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

comment on table signup_events is
  'The signup funnel (0018). Deliberately not the audit log: audit_log is tenant-scoped and every interesting step here happens before a tenant exists. Carries no personal data — it answers how many gave up at a step, never who.';

create index signup_events_step_idx on signup_events (step, occurred_at desc);
create index signup_events_signup_idx on signup_events (signup_id) where signup_id is not null;

-- ---------------------------------------------------------------------------
-- How a company works
-- ---------------------------------------------------------------------------

create table tenant_settings (
  tenant_id        uuid        primary key references tenants (id) on delete cascade,
  -- Branding. The logo is a media id rather than a URL, so it lives in the
  -- company's own bucket and is metered and purged with everything else. The
  -- foreign key carries the tenant, so a company cannot point its logo at
  -- another company's file — the schema invariants suite enforces this for
  -- every key between two tenant-scoped tables, and it caught this one.
  logo_media_id    uuid,
  brand_colour     text,
  -- Where the company is, in its own terms. `timezone` is an IANA name and is
  -- what a working day means for this company; the per-user locale stays a
  -- browser preference, and this is the default for anything the company
  -- sends out rather than something it shows one person.
  timezone         text        not null default 'UTC',
  currency         text        not null default 'GBP',
  locale           text        not null default 'en',
  -- Working hours, as minutes from midnight in the company's own timezone, and
  -- the days they apply to. Minutes rather than a time, because arithmetic on
  -- a time across a daylight change is where this goes wrong.
  work_day_starts  integer     not null default 480,
  work_day_ends    integer     not null default 1020,
  -- ISO weekday numbers: 1 is Monday. An empty array means nobody works, which
  -- is allowed — a company that is closed has no working days.
  working_days     integer[]   not null default '{1,2,3,4,5}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint tenant_settings_colour_shape
    check (brand_colour is null or brand_colour ~ '^#[0-9A-Fa-f]{6}$'),
  constraint tenant_settings_currency_shape check (currency ~ '^[A-Z]{3}$'),
  constraint tenant_settings_day_bounds
    check (work_day_starts >= 0 and work_day_ends <= 1440 and work_day_ends > work_day_starts),
  constraint tenant_settings_days_sane
    check (working_days <@ array[1,2,3,4,5,6,7]),
  constraint tenant_settings_logo_fk
    foreign key (tenant_id, logo_media_id) references files (tenant_id, id) on delete set null
);

comment on table tenant_settings is
  'How one company works: branding, timezone, currency, locale and working hours (0018). One row per company, created on onboarding so nothing has to cope with its absence.';

create trigger tenant_settings_set_updated_at
  before update on tenant_settings
  for each row execute function set_updated_at();

-- Every company that already exists gets the defaults, so no reader has to
-- handle a missing row.
insert into tenant_settings (tenant_id)
select id from tenants
on conflict (tenant_id) do nothing;

-- ---------------------------------------------------------------------------
-- Demo data, labelled so it can be taken away again
-- ---------------------------------------------------------------------------

-- A column rather than a table: the alternative is a list of ids to delete,
-- which goes stale the moment somebody edits a demo customer into a real one.
-- Marked on the row, the label travels with it and removal is one predicate.
alter table customers add column is_demo boolean not null default false;
alter table sites     add column is_demo boolean not null default false;
alter table work_orders add column is_demo boolean not null default false;

comment on column customers.is_demo is
  'Sample data loaded during onboarding (0018). Removable in one action, and the flag is cleared if somebody edits the row into something real.';

create index customers_demo_idx   on customers (tenant_id)   where is_demo;
create index sites_demo_idx       on sites (tenant_id)       where is_demo;
create index work_orders_demo_idx on work_orders (tenant_id) where is_demo;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- A company reads and writes its own settings; that is the point of them.
grant select, insert, update on tenant_settings to integr8_app;

alter table tenant_settings enable row level security;
alter table signup_requests enable row level security;
alter table signup_events   enable row level security;

create policy tenant_settings_isolation on tenant_settings
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- Both signup tables are the platform's. They describe people who are not yet
-- customers, and the runtime role holds no grant on either.
create policy signup_requests_platform_only on signup_requests using (false);
create policy signup_events_platform_only   on signup_events   using (false);

-- Expiring abandoned signups needs a turn of its own; see 0016 for the shape.
insert into scheduled_task_runs (task) values ('signup.expire');
