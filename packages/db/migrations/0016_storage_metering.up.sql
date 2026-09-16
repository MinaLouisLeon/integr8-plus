-- P16 — Storage metering and quotas.
--
-- P09 built the ledger: `files` is written from what storage reported, and
-- `tenant_storage_usage` is kept beside it by a trigger, so at any moment the
-- rollup is the sum of what is in the bucket. This migration is the layer over
-- it that turns a number into a decision — what a company is allowed, what they
-- have used, what that has cost, and what to do when they pass it.
--
-- Four tables:
--
--   plan_allowances         what each plan is allowed, edited from the dashboard
--   tenant_storage_samples  one row per company per day: the trend, and the
--                           allowance that applied on that day
--   storage_reconciliations the nightly comparison of the ledger against what
--                           Cloudflare bills from
--   scheduled_task_runs     the smallest thing that makes a nightly job nightly
--                           when several workers are running
--
-- Two numbers exist and both matter. The ledger is what we bill from, because
-- it is attributable to a company, a file and a job. Cloudflare is what we audit
-- against. When they disagree the ledger is wrong until proven otherwise.

-- ---------------------------------------------------------------------------
-- What a plan is allowed
-- ---------------------------------------------------------------------------

create table plan_allowances (
  plan            text        primary key,
  -- Null is uncapped. Enterprise starts uncapped, because the alternative is a
  -- number nobody chose refusing an upload on a Friday afternoon.
  storage_bytes   bigint,
  -- How long media is kept before the retention job takes it. Null is for ever.
  retention_days  integer,
  -- What happens at a hundred percent. `block` refuses new uploads; `allow`
  -- keeps accepting and records the overage for billing (P17).
  overage         text        not null default 'block',
  -- The company is warned from here. Before the limit, not after it.
  warn_at_percent smallint    not null default 80,
  updated_at      timestamptz not null default now(),
  -- Who changed it last, with no foreign key to `platform_users` — the same
  -- reasoning as the platform audit log: what a plan allows outlives whoever
  -- set it, and the account being closed later must not take the record of the
  -- change with it. It also keeps the table out of the cascade when platform
  -- accounts are emptied, which is how a test run discovered the coupling.
  updated_by      uuid,

  constraint plan_allowances_plan_known
    check (plan in ('trial', 'starter', 'standard', 'enterprise')),
  constraint plan_allowances_storage_sane
    check (storage_bytes is null or storage_bytes > 0),
  constraint plan_allowances_retention_sane
    check (retention_days is null or retention_days between 1 and 36500),
  constraint plan_allowances_overage_known check (overage in ('block', 'allow')),
  constraint plan_allowances_warn_sane check (warn_at_percent between 1 and 100)
);

comment on table plan_allowances is
  'What each plan is allowed, and what happens when a company passes it. One row per plan, edited from the platform dashboard (P16). Plan definitions in full — seats, forms, submissions, modules — are P17; this holds the storage half, which is the half that costs money the moment it is wrong.';

comment on column plan_allowances.overage is
  'block refuses new uploads at a hundred percent; allow keeps accepting and records the overage on each daily sample, so P17 can bill for it retrospectively rather than losing the months in between.';

-- The starting point, not a pricing decision: every one of these is editable
-- from the dashboard, and the trial number is deliberately small enough that
-- somebody notices the quota works before a paying customer does.
insert into plan_allowances (plan, storage_bytes, retention_days, overage, warn_at_percent) values
  ('trial',      5368709120,    90, 'block', 80),   --   5 GiB
  ('starter',    107374182400, 365, 'block', 80),   -- 100 GiB
  ('standard',   536870912000, 730, 'allow', 80),   -- 500 GiB
  ('enterprise', null,        null, 'allow', 80);

-- ---------------------------------------------------------------------------
-- The trend
-- ---------------------------------------------------------------------------

create table tenant_storage_samples (
  tenant_id       uuid        not null references tenants (id) on delete restrict,
  sampled_on      date        not null,
  bytes           bigint      not null,
  objects         integer     not null,
  -- Bytes per category on the day, so the breakdown can be plotted too without
  -- a row per category per day.
  by_category     jsonb       not null default '{}',
  -- The allowance that applied on the day, copied rather than joined: an
  -- allowance edited next month must not silently rewrite last month's overage.
  allowance_bytes bigint,
  -- What was over the line that day. Null when there was no line to cross.
  overage_bytes   bigint,
  -- What Cloudflare charged for, when the reconciliation reached it.
  class_a_operations bigint,
  class_b_operations bigint,

  constraint tenant_storage_samples_pk primary key (tenant_id, sampled_on),
  constraint tenant_storage_samples_sane
    check (bytes >= 0 and objects >= 0),
  constraint tenant_storage_samples_overage_sane
    check (overage_bytes is null or overage_bytes >= 0),
  constraint tenant_storage_samples_category_shape
    check (jsonb_typeof(by_category) = 'object')
);

comment on table tenant_storage_samples is
  'One row per company per day: what the ledger said, what the plan allowed, and what Cloudflare charged for (P16). The thirty and ninety day trends read from here, and P17 bills overage from here, which is why the allowance is copied onto the row rather than joined at read time.';

create index tenant_storage_samples_recent_idx
  on tenant_storage_samples (tenant_id, sampled_on desc);

-- ---------------------------------------------------------------------------
-- The audit against Cloudflare
-- ---------------------------------------------------------------------------

create table storage_reconciliations (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references tenants (id) on delete restrict,
  ran_at                timestamptz not null default now(),
  ledger_bytes          bigint      not null,
  ledger_objects        integer     not null,
  -- Null when Cloudflare had no sample for the bucket yet, or is not configured.
  cloudflare_bytes      bigint,
  cloudflare_objects    integer,
  cloudflare_sampled_at timestamptz,
  -- Signed: positive means the ledger claims more than Cloudflare reports.
  drift_bytes           bigint,
  status                text        not null,
  note                  text,

  constraint storage_reconciliations_status_known
    check (status in ('matched', 'drifted', 'unavailable')),
  constraint storage_reconciliations_ledger_sane
    check (ledger_bytes >= 0 and ledger_objects >= 0),
  -- A drifted result has to say by how much, and a matched one cannot have.
  constraint storage_reconciliations_drift_pair
    check (
      (status = 'unavailable' and cloudflare_bytes is null)
      or (status <> 'unavailable' and cloudflare_bytes is not null and drift_bytes is not null)
    )
);

comment on table storage_reconciliations is
  'The nightly comparison of the ledger against what Cloudflare bills from (P16). Internal: a company never sees it, because a disagreement between our two counts is our accounting problem and there is nothing they could do about it.';

create index storage_reconciliations_recent_idx
  on storage_reconciliations (tenant_id, ran_at desc);

create index storage_reconciliations_drifted_idx
  on storage_reconciliations (ran_at desc) where status = 'drifted';

-- ---------------------------------------------------------------------------
-- Making a nightly job nightly
-- ---------------------------------------------------------------------------

create table scheduled_task_runs (
  task          text        primary key,
  last_run_at   timestamptz not null default to_timestamp(0),
  last_finished_at timestamptz,
  claimed_by    text,
  last_error    text
);

comment on table scheduled_task_runs is
  'When each recurring platform task last ran (P16). There is no cron in this system and no scheduler process; the worker runs housekeeping on a timer, and several workers run at once. A task that must happen once a day rather than once a day per worker claims its turn here, with a conditional update that exactly one of them wins.';

insert into scheduled_task_runs (task) values
  ('storage.reconcile'),
  ('storage.sample'),
  ('storage.retention');

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- A company may read its own history, because P16 shows them the same numbers
-- the platform sees. It may not read the reconciliation, the plan table or the
-- scheduler: the first is our internal audit, and the other two belong to no
-- company at all.
grant select on tenant_storage_samples to integr8_app;

alter table plan_allowances          enable row level security;
alter table tenant_storage_samples   enable row level security;
alter table storage_reconciliations  enable row level security;
alter table scheduled_task_runs      enable row level security;

create policy tenant_storage_samples_isolation on tenant_storage_samples
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- `storage_reconciliations` carries a tenant_id and a policy so the isolation
-- invariant holds for it like every other company-keyed table, and so a purge
-- takes it with the company. No grant is made to the runtime role, so nothing
-- serving a company's request can read it whatever the policy would allow.
create policy storage_reconciliations_isolation on storage_reconciliations
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
