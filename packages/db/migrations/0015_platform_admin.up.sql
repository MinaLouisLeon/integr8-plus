-- 0015 — running the business (P15).
--
-- Everything a super admin needs that the tenant schema deliberately cannot
-- hold: a way for a platform user to sign in, a record of what they did that no
-- company can see or change, and the few pieces of company state that belong to
-- the platform rather than to the company — its plan, its feature flags, the
-- announcements shown to it, the export taken of it and the day it is purged.
--
--   platform_users          who you are (P02) — now with a password and a second factor
--   platform_sessions       one signed-in browser, for a platform user
--   platform_refresh_tokens rotation, chained, exactly as tenant sessions do it
--   platform_audit_log      every super-admin action, append-only, tenant-less
--   feature_flags           the flags that exist, and what they are by default
--   tenant_feature_flags    what one company has, read by that company
--   announcements           a banner for one company or for everybody
--   tenant_exports          a full export of one company, taken before deletion
--   tenant_deletions        the scheduled purge, and the cooling-off before it
--
-- The two identity spaces still never mix: nothing here is granted to
-- integr8_app except the two things a company is allowed to read about itself.

-- ---------------------------------------------------------------------------
-- platform_users: credentials
-- ---------------------------------------------------------------------------
--
-- Tenant users authenticate through Supabase; platform users cannot, because
-- the locked decision is that super-admin identity stays outside tenant auth.
-- So the password lives here, hashed with scrypt, and the second factor is a
-- TOTP secret encrypted with a key the database never sees (AES-256-GCM,
-- PLATFORM_SECRET_KEY). A stolen database backup yields neither.

alter table platform_users
  add column password_hash       text,
  add column password_changed_at timestamptz,
  add column totp_secret         text,
  add column totp_enrolled_at    timestamptz,
  add column last_signed_in_at   timestamptz,
  add column failed_attempts     integer     not null default 0,
  add column locked_until        timestamptz;

alter table platform_users
  add constraint platform_users_failed_attempts_sane check (failed_attempts >= 0),
  -- A second factor is not optional: this account can read every customer's
  -- data. Enrolling and being enrolled are one fact, so they cannot disagree.
  add constraint platform_users_totp_pair check ((totp_secret is null) = (totp_enrolled_at is null));

comment on column platform_users.password_hash is
  'scrypt, as `scrypt$N$r$p$salt$hash`. Null until the account is set up, which no sign-in accepts.';
comment on column platform_users.totp_secret is
  'The TOTP secret, encrypted with PLATFORM_SECRET_KEY (AES-256-GCM). Null until enrolled.';
comment on column platform_users.locked_until is
  'Set after repeated failures. A locked account is refused even with the right password.';

-- ---------------------------------------------------------------------------
-- platform_sessions and their refresh tokens
-- ---------------------------------------------------------------------------

create table platform_sessions (
  id               uuid        primary key default gen_random_uuid(),
  platform_user_id uuid        not null references platform_users (id) on delete cascade,
  user_agent       text,
  ip_address       inet,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  revoked_reason   text,

  constraint platform_sessions_revoked_reason_known
    check (revoked_reason is null or revoked_reason in
      ('signed_out', 'signed_out_everywhere', 'refresh_token_reuse', 'account_disabled',
       'password_changed')),
  constraint platform_sessions_revoked_pair check ((revoked_at is null) = (revoked_reason is null)),
  constraint platform_sessions_expires_after_creation check (expires_at > created_at)
);

comment on table platform_sessions is
  'One signed-in browser for a super admin. Short-lived by design: this session can reach every company.';

create index platform_sessions_live_idx on platform_sessions (platform_user_id) where revoked_at is null;

create table platform_refresh_tokens (
  id          uuid        primary key default gen_random_uuid(),
  session_id  uuid        not null references platform_sessions (id) on delete cascade,
  token_hash  text        not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  replaced_by uuid        references platform_refresh_tokens (id) on delete set null,

  constraint platform_refresh_tokens_hash_unique unique (token_hash),
  constraint platform_refresh_tokens_expires_after_creation check (expires_at > created_at)
);

comment on table platform_refresh_tokens is
  'One row per platform refresh token ever issued, chained. Presenting a spent token is theft, and ends the session.';

create index platform_refresh_tokens_session_idx on platform_refresh_tokens (session_id);

-- ---------------------------------------------------------------------------
-- platform_audit_log: what a super admin did, for ever
-- ---------------------------------------------------------------------------
--
-- 0001 said a platform event touching no tenant would get its own table when
-- something needed one. This is that table. It is not the company's audit log
-- and is never shown to a company; where an action concerns a company, the
-- company's own audit_log gets its entry too, as impersonation already does.
--
-- The company is recorded by id *and* slug, without a foreign key, so the
-- history of a company survives that company being purged.

create table platform_audit_log (
  id               uuid        primary key default gen_random_uuid(),
  occurred_at      timestamptz not null default now(),
  platform_user_id uuid        references platform_users (id) on delete set null,
  actor_label      text        not null,
  action           text        not null,
  tenant_id        uuid,
  tenant_slug      text,
  target_kind      text,
  target_id        text,
  reason           text,
  request_id       text,
  ip_address       inet,
  user_agent       text,
  metadata         jsonb       not null default '{}'::jsonb,

  constraint platform_audit_log_action_not_blank check (btrim(action) <> ''),
  constraint platform_audit_log_actor_label_not_blank check (btrim(actor_label) <> ''),
  constraint platform_audit_log_metadata_is_object check (jsonb_typeof(metadata) = 'object')
);

comment on table platform_audit_log is
  'Every super-admin action, append-only. Tenant-less by design: it outlives the companies it mentions.';

create index platform_audit_log_recent_idx on platform_audit_log (occurred_at desc);
create index platform_audit_log_tenant_idx on platform_audit_log (tenant_id, occurred_at desc);
create index platform_audit_log_actor_idx on platform_audit_log (platform_user_id, occurred_at desc);

-- Append-only for every role, the schema owner included, exactly as audit_log is.
create function reject_platform_audit_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'platform_audit_log is append-only; % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger platform_audit_log_no_update
  before update on platform_audit_log
  for each statement execute function reject_platform_audit_mutation();

create trigger platform_audit_log_no_delete
  before delete on platform_audit_log
  for each statement execute function reject_platform_audit_mutation();

create trigger platform_audit_log_no_truncate
  before truncate on platform_audit_log
  for each statement execute function reject_platform_audit_mutation();

-- ---------------------------------------------------------------------------
-- What the platform knows about a company
-- ---------------------------------------------------------------------------

alter table tenants
  add column plan               text        not null default 'trial',
  add column seats              integer,
  add column suspended_at       timestamptz,
  add column suspended_reason   text,
  add column onboarded_by       uuid        references platform_users (id) on delete set null;

alter table tenants
  add constraint tenants_plan_known check (plan in ('trial', 'starter', 'standard', 'enterprise')),
  add constraint tenants_seats_positive check (seats is null or seats > 0),
  -- Suspended and why are one fact. A company is never stopped without a reason
  -- somebody can read back to them.
  add constraint tenants_suspension_pair
    check ((suspended_at is null) = (suspended_reason is null)),
  add constraint tenants_suspension_matches_status
    check (status <> 'suspended' or suspended_at is not null);

comment on column tenants.plan is
  'What the company pays for. Seats and quotas hang off it; billing itself is P17.';
comment on column tenants.suspended_reason is
  'Why the company was stopped, shown to them by every client. Cleared on reactivation.';

-- ---------------------------------------------------------------------------
-- feature_flags: what exists, and what each company has
-- ---------------------------------------------------------------------------

create table feature_flags (
  key             text        primary key,
  description     text        not null,
  default_enabled boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint feature_flags_key_format check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint feature_flags_description_not_blank check (btrim(description) <> '')
);

comment on table feature_flags is
  'The flags that exist and what they are when a company has no opinion. Platform content: read by every company, written by the schema owner.';

create trigger feature_flags_set_updated_at
  before update on feature_flags
  for each row execute function set_updated_at();

create table tenant_feature_flags (
  tenant_id  uuid        not null references tenants (id) on delete cascade,
  key        text        not null references feature_flags (key) on delete cascade,
  enabled    boolean     not null,
  updated_at timestamptz not null default now(),
  updated_by uuid        references platform_users (id) on delete set null,

  constraint tenant_feature_flags_pk primary key (tenant_id, key)
);

comment on table tenant_feature_flags is
  'One company''s answer for one flag. Absent means the flag''s default. A company reads its own and changes none.';

create trigger tenant_feature_flags_set_updated_at
  before update on tenant_feature_flags
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- announcements
-- ---------------------------------------------------------------------------
--
-- Shown by the web, desktop and mobile apps. A null tenant_id is everybody,
-- which is why this is not a tenant-scoped table; the API reads it as the
-- platform and hands each company only what is theirs.

create table announcements (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        references tenants (id) on delete cascade,
  severity    text        not null default 'info',
  message     jsonb       not null,
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,
  dismissible boolean     not null default true,
  created_by  uuid        references platform_users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint announcements_severity_known check (severity in ('info', 'warning', 'critical')),
  constraint announcements_message_is_object check (jsonb_typeof(message) = 'object'),
  constraint announcements_message_not_empty check (message <> '{}'::jsonb),
  constraint announcements_window_ordered check (ends_at is null or ends_at > starts_at)
);

comment on table announcements is
  'A banner for one company or for every company, between two moments. Written by the platform, read by every client through /v1/me.';

create index announcements_live_idx on announcements (starts_at, ends_at);

create trigger announcements_set_updated_at
  before update on announcements
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Exports and deletion
-- ---------------------------------------------------------------------------
--
-- Neither table has a foreign key to tenants: both outlive the company they
-- describe, because the record that a company was exported and purged is the
-- point. The slug is kept beside the id for the same reason.

create table tenant_exports (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null,
  tenant_slug  text        not null,
  requested_by uuid        references platform_users (id) on delete set null,
  status       text        not null default 'pending',
  object_key   text,
  byte_size    bigint,
  contents     jsonb       not null default '{}'::jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  expires_at   timestamptz,

  constraint tenant_exports_status_known check (status in ('pending', 'running', 'ready', 'failed')),
  constraint tenant_exports_ready_has_object check (status <> 'ready' or object_key is not null),
  constraint tenant_exports_byte_size_sane check (byte_size is null or byte_size >= 0),
  constraint tenant_exports_contents_is_object check (jsonb_typeof(contents) = 'object')
);

comment on table tenant_exports is
  'A full export of one company: every row as JSON, with a manifest of its files. Taken before a company may be deleted.';

create index tenant_exports_tenant_idx on tenant_exports (tenant_id, created_at desc);

create table tenant_deletions (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null,
  tenant_slug    text        not null,
  export_id      uuid        not null references tenant_exports (id) on delete restrict,
  requested_by   uuid        references platform_users (id) on delete set null,
  reason         text        not null,
  purge_after    timestamptz not null,
  created_at     timestamptz not null default now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid        references platform_users (id) on delete set null,
  completed_at   timestamptz,

  constraint tenant_deletions_reason_meaningful check (length(btrim(reason)) >= 10),
  constraint tenant_deletions_cancelled_pair check ((cancelled_at is null) = (cancelled_by is null)),
  constraint tenant_deletions_not_both_ways check (cancelled_at is null or completed_at is null)
);

comment on table tenant_deletions is
  'A company scheduled for deletion: which export was taken first, why, and when the purge may run. Cancelling before then undoes it.';

-- One live schedule per company; a finished or cancelled one may be followed by another.
create unique index tenant_deletions_pending_idx on tenant_deletions (tenant_id)
  where cancelled_at is null and completed_at is null;

-- ---------------------------------------------------------------------------
-- purge_tenant: the only way a company's rows leave this database
-- ---------------------------------------------------------------------------
--
-- Almost every tenant-scoped table references tenants with `on delete restrict`
-- — chosen in P02 so that nothing deletes a company by accident. Purging one
-- therefore deletes table by table, and finds the order itself: it tries each
-- table that has a tenant_id foreign key, skips the ones a child still blocks,
-- and goes round again until nothing is left. A new table in a later phase is
-- covered without anybody remembering to add it here.
--
-- audit_log is append-only for every role including this function's owner, so
-- its no-delete trigger is turned off for the length of the purge and turned
-- back on immediately. There is no window: a failure rolls the whole
-- transaction back, trigger state included.

create function purge_tenant(p_tenant uuid) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  scheduled  uuid;
  remaining  text[];
  attempt    text[];
  progressed boolean;
  candidate  text;
  guard      text;
begin
  select d.id into scheduled
    from public.tenant_deletions d
   where d.tenant_id = p_tenant
     and d.cancelled_at is null
     and d.completed_at is null
     and d.purge_after <= now();

  if scheduled is null then
    raise exception 'tenant % is not scheduled for deletion, or its cooling-off has not passed', p_tenant
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Every table with a tenant_id foreign key to tenants, in `public` only.
  -- The schema predicates matter: the delete below names `public.%I`, so a
  -- table of the same name in another schema would either raise undefined_table
  -- and stop every purge for ever, or — worse — name a real public table that
  -- was never meant to be in the list.
  select array_agg(distinct child.relname::text)
    into remaining
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_attribute att on att.attrelid = child.oid and att.attnum = any (con.conkey)
   where con.contype = 'f'
     and parent.relname = 'tenants'
     and parent.relnamespace = 'public'::regnamespace
     and child.relnamespace = 'public'::regnamespace
     and att.attname = 'tenant_id';

  -- The append-only guards refuse delete for every role, the schema owner
  -- included. That is the point of them, and it makes this function the one
  -- place allowed to lift them: it has already checked that a deletion is
  -- scheduled and due, so a company's history goes only when the company does.
  -- `platform_audit_log` is deliberately not on this list — it has no tenant_id
  -- foreign key and outlives the company it describes.
  foreach guard in array array['audit_log', 'submission_events', 'work_order_events'] loop
    execute format('alter table public.%I disable trigger %I', guard, guard || '_no_delete');
  end loop;

  while coalesce(array_length(remaining, 1), 0) > 0 loop
    progressed := false;
    attempt := remaining;
    foreach candidate in array attempt loop
      begin
        execute format('delete from public.%I where tenant_id = $1', candidate) using p_tenant;
        remaining := array_remove(remaining, candidate);
        progressed := true;
      exception
        when foreign_key_violation then
          -- A child of this table still holds rows. Another pass will reach it.
          null;
      end;
    end loop;

    if not progressed then
      raise exception 'could not purge tenant %: % still holds rows', p_tenant, remaining
        using errcode = 'foreign_key_violation';
    end if;
  end loop;

  delete from public.tenants where id = p_tenant;

  update public.tenant_deletions set completed_at = now() where id = scheduled;

  foreach guard in array array['audit_log', 'submission_events', 'work_order_events'] loop
    execute format('alter table public.%I enable trigger %I', guard, guard || '_no_delete');
  end loop;
end;
$$;

comment on function purge_tenant(uuid) is
  'Deletes every row belonging to one company, in an order it works out itself. Refuses unless a deletion is scheduled and its cooling-off has passed.';

revoke all on function purge_tenant(uuid) from public;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- A company may read the flags that exist and its own answers, so /v1/me can
-- tell its apps what is turned on. It may read nothing else here: the platform
-- tables carry no grant at all, exactly as platform_users carries none.

grant select on feature_flags to integr8_app;
grant select on tenant_feature_flags to integr8_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table platform_sessions enable row level security;
alter table platform_refresh_tokens enable row level security;
alter table platform_audit_log enable row level security;
alter table feature_flags enable row level security;
alter table tenant_feature_flags enable row level security;
alter table announcements enable row level security;
alter table tenant_exports enable row level security;
alter table tenant_deletions enable row level security;

-- Readable by every company, because the list of flags belongs to none of them.
create policy feature_flags_readable on feature_flags
  for select
  to integr8_app
  using (true);

create policy tenant_feature_flags_isolation on tenant_feature_flags
  for select
  to integr8_app
  using (tenant_id = app_current_tenant_id());
