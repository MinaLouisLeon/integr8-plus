-- 0004 — idempotency, background jobs and rate limiting.
--
-- The three pieces of API plumbing that need durable state. All Postgres: a
-- second datastore is a thing to provision, secure, back up and pay for, and
-- this workload is nowhere near needing one. If rate limiting later becomes a
-- contention point, the fix is Redis and it is a P19 conversation.

-- ---------------------------------------------------------------------------
-- idempotency_keys — replaying a mutation must not repeat its effect.
-- ---------------------------------------------------------------------------
--
-- The mobile outbox in P12 retries on a connection that drops halfway. From the
-- phone, "the request timed out" and "the request succeeded and the reply was
-- lost" are the same event, so it retries — and without this table, retrying a
-- job completion books the work twice.
--
-- The stored response is what makes a replay *identical* rather than merely
-- harmless: the second caller gets the first caller's answer, status code and
-- body, so a client cannot tell it retried.
--
-- `request_fingerprint` guards the other failure: the same key sent with a
-- different body is a client bug, and answering it with the first request's
-- response would hide the bug and lose the second request. It is rejected
-- instead.

create table idempotency_keys (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null references tenants (id) on delete cascade,
  idempotency_key      text        not null,
  user_id              uuid        not null,
  method               text        not null,
  path                 text        not null,
  request_fingerprint  text        not null,
  status               text        not null default 'in_progress',
  response_status      integer,
  response_body        jsonb,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz,
  expires_at           timestamptz not null,

  constraint idempotency_keys_unique unique (tenant_id, idempotency_key),
  constraint idempotency_keys_status_known check (status in ('in_progress', 'completed')),
  constraint idempotency_keys_fingerprint_is_sha256
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  -- Completed means there is a response to replay; in-progress means there is
  -- not. The two cannot disagree.
  constraint idempotency_keys_completion_pair
    check ((status = 'completed') = (completed_at is not null and response_status is not null)),
  constraint idempotency_keys_expires_after_creation check (expires_at > created_at)
);

comment on table idempotency_keys is
  'One row per mutating request that carried an Idempotency-Key. Holds the response so a replay returns the original answer.';
comment on column idempotency_keys.request_fingerprint is
  'SHA-256 of method, path and body. The same key with a different body is a client bug, and is rejected rather than silently replayed.';

create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- jobs — background work, with retries and a dead-letter state.
-- ---------------------------------------------------------------------------
--
-- Tenant-scoped, because every job is work for one company and a job that
-- leaked into another company's queue would run with that company's data.
--
-- That creates one wrinkle worth stating plainly: a worker has to poll across
-- every tenant, which is a question the tenancy model cannot answer. Enqueuing
-- happens on the tenant connection with RLS armed; *claiming* happens on the
-- owner connection, which sees everything, and each claimed job is then
-- executed inside a tenant transaction for its own `tenant_id`. The privileged
-- step is one function, and it serves no tenant request.

create table jobs (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete cascade,
  queue          text        not null,
  payload        jsonb       not null default '{}'::jsonb,
  status         text        not null default 'pending',
  attempts       integer     not null default 0,
  max_attempts   integer     not null default 5,
  available_at   timestamptz not null default now(),
  locked_by      text,
  locked_until   timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,
  dead_lettered_at timestamptz,

  constraint jobs_tenant_id_unique unique (tenant_id, id),
  constraint jobs_status_known
    check (status in ('pending', 'running', 'succeeded', 'failed', 'dead')),
  constraint jobs_queue_not_blank check (btrim(queue) <> ''),
  constraint jobs_attempts_sane check (attempts >= 0 and attempts <= max_attempts + 1),
  constraint jobs_max_attempts_positive check (max_attempts >= 1),
  -- Locked and until-when are one fact.
  constraint jobs_lock_pair check ((locked_by is null) = (locked_until is null)),
  constraint jobs_dead_has_status check ((dead_lettered_at is null) = (status <> 'dead'))
);

comment on table jobs is
  'Background work for one company. Enqueued through the tenant connection; claimed by the worker through the owner connection.';
comment on column jobs.status is
  'pending -> running -> succeeded, or back to pending on a retriable failure, or dead once attempts are exhausted.';
comment on column jobs.locked_until is
  'A lease, not a lock. A worker that dies mid-job leaves the row locked; the lease expiring is what lets another worker pick it up.';

-- The claim query: pending work whose time has come, oldest first. Partial, so
-- the index stays small however much completed history accumulates.
create index jobs_claimable_idx on jobs (available_at, created_at)
  where status in ('pending', 'running');

create index jobs_tenant_status_idx on jobs (tenant_id, status, created_at desc);

-- The dead-letter queue is a status rather than a second table: a dead job
-- keeps its payload, its attempt count and its last error, which is what
-- somebody looking at it needs, and requeuing it is an update rather than a
-- migration between tables.
create index jobs_dead_letter_idx on jobs (tenant_id, dead_lettered_at desc)
  where status = 'dead';

create trigger jobs_set_updated_at
  before update on jobs
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- rate_limit_buckets — fixed-window counters. Not tenant-scoped.
-- ---------------------------------------------------------------------------
--
-- Rate limiting is a gateway concern: it runs before the handler and, for an
-- unauthenticated request, before there is any tenant to scope by. Keying it on
-- an opaque bucket string — `ip:198.51.100.4`, `tenant:<uuid>` — keeps both
-- kinds in one table.
--
-- Reached by `integr8_auth`, the same narrow role that serves the rest of the
-- pre-authentication path, so the tenant runtime role gains no privilege on a
-- cross-tenant table. That role now reaches four objects rather than three, and
-- the schema-invariant suite asserts the new list.
--
-- Fixed windows, not a sliding log: one row per key per window, one upsert per
-- request. A sliding window would be more accurate at the boundary and would
-- cost a row per request, which is the wrong trade for a limit whose job is to
-- stop abuse rather than to meter billing.

create table rate_limit_buckets (
  bucket_key         text        not null,
  window_started_at  timestamptz not null,
  request_count      integer     not null default 0,
  updated_at         timestamptz not null default now(),

  constraint rate_limit_buckets_pkey primary key (bucket_key, window_started_at),
  constraint rate_limit_buckets_key_not_blank check (btrim(bucket_key) <> ''),
  constraint rate_limit_buckets_count_sane check (request_count >= 0)
);

comment on table rate_limit_buckets is
  'Fixed-window request counters, keyed by an opaque bucket string. Not tenant-scoped: an unauthenticated request has no tenant.';

create index rate_limit_buckets_window_idx on rate_limit_buckets (window_started_at);

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------

grant select, insert, update on idempotency_keys to integr8_app;
grant select, insert, update on jobs to integr8_app;
grant select, insert, update, delete on rate_limit_buckets to integr8_auth;

-- `delete` on rate_limit_buckets, uniquely: these rows are counters with no
-- evidentiary value once their window has passed, and something has to sweep
-- them. Every other table in this schema is append-or-revoke.

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

alter table idempotency_keys enable row level security;

create policy idempotency_keys_isolation on idempotency_keys
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table jobs enable row level security;

create policy jobs_isolation on jobs
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table rate_limit_buckets enable row level security;

create policy rate_limit_buckets_gateway on rate_limit_buckets
  for all
  to integr8_auth
  using (true)
  with check (true);
