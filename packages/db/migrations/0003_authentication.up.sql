-- 0003 — sessions, invitations, impersonation and login security.
--
-- P03 makes this service the session authority: Supabase Auth holds the
-- credentials and sends the magic links, and everything after the password is
-- accepted is recorded here. That is what makes tenant switching, per-device
-- revocation, time-limited impersonation and a multi-day offline grant
-- expressible at all — none of them are things an opaque third-party session
-- can be asked for.
--
-- Two tables here are deliberately not tenant-scoped, and a third database role
-- exists because of them. See the login-security section at the bottom.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'integr8_auth') then
    raise exception
      'Role integr8_auth does not exist. Run: pnpm --filter @integr8/db db bootstrap (see docs/database/runbook-supabase-setup.md)'
      using errcode = 'undefined_object';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Composite keys, so a child row cannot point across a tenant boundary.
-- ---------------------------------------------------------------------------
--
-- `references sessions (id)` alone would let a refresh token in company A name
-- a session in company B: both ids are valid uuids and nothing in the schema
-- would object. Carrying tenant_id into the key makes that a foreign-key
-- violation rather than a leak RLS has to catch on the way out. Every
-- tenant-scoped foreign key in this migration is composite for that reason.

alter table audit_log add constraint audit_log_tenant_id_unique unique (tenant_id, id);

-- ---------------------------------------------------------------------------
-- sessions — one per signed-in device, per company.
-- ---------------------------------------------------------------------------
--
-- A session belongs to a company, not merely to a person. Someone who works for
-- two companies has two sessions on the same phone, and revoking one does not
-- touch the other — which is what an admin means when they revoke a session,
-- and it keeps the table inside the tenancy rule with no exception.

create table sessions (
  id                      uuid        primary key default gen_random_uuid(),
  tenant_id               uuid        not null references tenants (id) on delete cascade,
  user_id                 uuid        not null,
  client_app              text        not null,
  device_label            text,
  user_agent              text,
  ip_address              inet,
  created_at              timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  expires_at              timestamptz not null,
  revoked_at              timestamptz,
  revoked_reason          text,
  impersonation_grant_id  uuid,

  constraint sessions_tenant_id_unique unique (tenant_id, id),
  constraint sessions_client_app_known
    check (client_app in ('web', 'desktop', 'mobile', 'api')),
  constraint sessions_revoked_reason_known
    check (revoked_reason is null or revoked_reason in
      ('signed_out', 'signed_out_everywhere', 'refresh_token_reuse', 'revoked_by_admin',
       'membership_ended', 'impersonation_ended', 'password_changed')),
  -- Revoked and why are one fact, so they cannot disagree.
  constraint sessions_revoked_pair check ((revoked_at is null) = (revoked_reason is null)),
  constraint sessions_expires_after_creation check (expires_at > created_at)
);

comment on table sessions is
  'One signed-in device, for one company. The unit an admin revokes and the unit an access token is minted from.';
comment on column sessions.impersonation_grant_id is
  'Set when this session exists only because a super admin is impersonating. Ordinary sign-in leaves it null.';

create index sessions_live_idx on sessions (tenant_id, user_id) where revoked_at is null;
create index sessions_expiry_idx on sessions (expires_at) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- refresh_tokens — one row per token ever issued, chained.
-- ---------------------------------------------------------------------------
--
-- A row per token rather than a column on the session, because rotation without
-- history cannot tell "this device is refreshing normally" from "somebody
-- stole this token and is using it behind the real user's back". With the
-- chain, presenting a token that has already been used is unambiguous theft:
-- the legitimate holder moved on to its replacement. The whole session is then
-- revoked, which logs the thief out and the victim too — the right outcome,
-- because the victim needs to know.
--
-- Only the hash is stored. A database dump must not be a list of live
-- credentials.

create table refresh_tokens (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete cascade,
  session_id   uuid        not null,
  token_hash   text        not null,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  replaced_by  uuid,

  constraint refresh_tokens_tenant_id_unique unique (tenant_id, id),
  constraint refresh_tokens_hash_unique unique (token_hash),
  constraint refresh_tokens_hash_is_sha256 check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint refresh_tokens_session_fk
    foreign key (tenant_id, session_id) references sessions (tenant_id, id) on delete cascade,
  constraint refresh_tokens_replacement_fk
    foreign key (tenant_id, replaced_by) references refresh_tokens (tenant_id, id) on delete set null,
  -- A token has a replacement exactly when it has been spent.
  constraint refresh_tokens_replacement_pair check ((used_at is null) = (replaced_by is null))
);

comment on table refresh_tokens is
  'Rotating refresh tokens, stored as SHA-256 hashes. A reused token means theft; see refresh_tokens_replacement_pair.';

create index refresh_tokens_session_idx on refresh_tokens (tenant_id, session_id);
create index refresh_tokens_live_idx on refresh_tokens (expires_at) where used_at is null;

-- ---------------------------------------------------------------------------
-- offline_grants — the reason the mobile app opens in a basement.
-- ---------------------------------------------------------------------------
--
-- The grant itself is a signed token the app verifies locally against an
-- embedded public key, with no network involved. This row exists so the grant
-- can be revoked when the phone is lost — which only takes effect the next time
-- that phone has signal, and there is no way around that. It is the whole
-- security tradeoff of working offline, written down in
-- docs/auth/offline-access.md.
--
-- No token_hash: the app presents the signed grant, not a secret we look up.

create table offline_grants (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete cascade,
  session_id      uuid        not null,
  user_id         uuid        not null,
  device_label    text,
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_reason  text,

  constraint offline_grants_tenant_id_unique unique (tenant_id, id),
  constraint offline_grants_session_fk
    foreign key (tenant_id, session_id) references sessions (tenant_id, id) on delete cascade,
  constraint offline_grants_revoked_reason_known
    check (revoked_reason is null or revoked_reason in
      ('device_lost', 'revoked_by_admin', 'session_revoked', 'membership_ended', 'replaced')),
  constraint offline_grants_revoked_pair check ((revoked_at is null) = (revoked_reason is null)),
  constraint offline_grants_expires_after_issue check (expires_at > issued_at)
);

comment on table offline_grants is
  'Records a long-lived grant so it can be revoked. Revocation only bites once the device is online again.';

create index offline_grants_live_idx on offline_grants (tenant_id, user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- invitations — how somebody joins a company.
-- ---------------------------------------------------------------------------

create table invitations (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants (id) on delete cascade,
  email               text        not null,
  role                text        not null,
  token_hash          text        not null,
  invited_by_user_id  uuid        not null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  accepted_at         timestamptz,
  accepted_user_id    uuid,
  revoked_at          timestamptz,
  revoked_by_user_id  uuid,

  constraint invitations_token_hash_unique unique (token_hash),
  constraint invitations_hash_is_sha256 check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint invitations_email_lowercase check (email = lower(email)),
  constraint invitations_email_shaped check (email like '%_@_%'),
  constraint invitations_role_known
    check (role in ('owner', 'admin', 'dispatcher', 'engineer', 'viewer')),
  constraint invitations_accepted_pair check ((accepted_at is null) = (accepted_user_id is null)),
  constraint invitations_revoked_pair check ((revoked_at is null) = (revoked_by_user_id is null)),
  -- An invitation cannot have been both accepted and withdrawn.
  constraint invitations_single_outcome check (accepted_at is null or revoked_at is null),
  constraint invitations_expires_after_creation check (expires_at > created_at)
);

comment on table invitations is
  'Pending membership. The emailed token is stored only as a hash; acceptance binds the invitee to this tenant at this role.';

-- One live invitation per address per company: re-inviting someone replaces
-- rather than accumulates, so revoking "the" invitation is unambiguous.
create unique index invitations_one_live_per_email
  on invitations (tenant_id, email)
  where accepted_at is null and revoked_at is null;

create index invitations_pending_idx on invitations (tenant_id, expires_at)
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- impersonation_grants — a super admin acting as somebody, briefly, on record.
-- ---------------------------------------------------------------------------
--
-- `audit_log_id` is not null and references an existing row. That is the
-- schema-level statement of "the audit entry is written before access is
-- granted": there is no order of operations in which a grant exists and its
-- audit entry does not, because the insert would fail. Combined with
-- audit_log's append-only triggers, the entry then cannot be removed by
-- anyone, including the owner.

create table impersonation_grants (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants (id) on delete cascade,
  platform_user_id  uuid        not null references platform_users (id) on delete restrict,
  target_user_id    uuid        not null,
  reason            text        not null,
  audit_log_id      uuid        not null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  ended_at          timestamptz,
  ended_reason      text,

  constraint impersonation_grants_tenant_id_unique unique (tenant_id, id),
  constraint impersonation_grants_audit_fk
    foreign key (tenant_id, audit_log_id) references audit_log (tenant_id, id) on delete restrict,
  -- A reason of "test" or "x" is not a reason. Ten characters is not much of a
  -- bar, and it is enough to stop the reflex.
  constraint impersonation_grants_reason_meaningful check (length(btrim(reason)) >= 10),
  constraint impersonation_grants_ended_reason_known
    check (ended_reason is null or ended_reason in ('ended_by_admin', 'expired', 'revoked_by_tenant')),
  constraint impersonation_grants_ended_pair check ((ended_at is null) = (ended_reason is null)),
  constraint impersonation_grants_expires_after_creation check (expires_at > created_at)
);

comment on table impersonation_grants is
  'A time-limited grant for a super admin to act as a tenant user. Cannot exist without its audit entry.';

create index impersonation_grants_live_idx on impersonation_grants (tenant_id, expires_at)
  where ended_at is null;
create index impersonation_grants_by_platform_user_idx
  on impersonation_grants (platform_user_id, created_at desc);

alter table sessions add constraint sessions_impersonation_grant_fk
  foreign key (tenant_id, impersonation_grant_id)
  references impersonation_grants (tenant_id, id) on delete cascade;

-- ---------------------------------------------------------------------------
-- Login security. Not tenant-scoped, and that is the point.
-- ---------------------------------------------------------------------------
--
-- At the moment a sign-in fails, the company is not yet known — and cannot be,
-- because the address may belong to nobody, or to somebody in two companies.
-- Rate limiting and lockout therefore key on the email address across the whole
-- platform.
--
-- These two tables are the only reason `integr8_auth` exists. Granting the
-- tenant runtime role access to them would hand every tenant request the
-- ability to read a global list of every address that has ever attempted to
-- sign in, which is precisely the sort of thing the isolation model is for.
-- Instead the pre-authentication path connects as a role that can reach these
-- two tables and one view, and nothing else — checked by the schema-invariant
-- suite.

create table login_attempts (
  id           uuid        primary key default gen_random_uuid(),
  email        text        not null,
  ip_address   inet,
  user_agent   text,
  outcome      text        not null,
  occurred_at  timestamptz not null default now(),

  constraint login_attempts_email_lowercase check (email = lower(email)),
  constraint login_attempts_outcome_known
    check (outcome in
      ('succeeded', 'bad_credentials', 'unknown_identity', 'locked_out',
       'no_membership', 'rate_limited'))
);

comment on table login_attempts is
  'Every sign-in attempt, successful or not. Keyed on email because at attempt time no tenant is known.';

create index login_attempts_email_time_idx on login_attempts (email, occurred_at desc);
create index login_attempts_ip_time_idx on login_attempts (ip_address, occurred_at desc)
  where ip_address is not null;

create table account_locks (
  email            text        primary key,
  failed_count     integer     not null default 0,
  last_failure_at  timestamptz,
  locked_at        timestamptz,
  locked_until     timestamptz,
  unlocked_at      timestamptz,
  unlocked_by      text,
  updated_at       timestamptz not null default now(),

  constraint account_locks_email_lowercase check (email = lower(email)),
  constraint account_locks_failed_count_sane check (failed_count >= 0),
  constraint account_locks_locked_pair check ((locked_at is null) = (locked_until is null))
);

comment on table account_locks is
  'Lockout state per address. `unlocked_by` records the admin who lifted it, so an unlock is attributable.';
comment on column account_locks.unlocked_by is
  'Free text: "admin:<uuid>", "platform:<uuid>" or "auto". Not a foreign key — an unlock can come from either identity space.';

create trigger account_locks_set_updated_at
  before update on account_locks
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- auth_memberships — the one controlled cross-tenant read.
-- ---------------------------------------------------------------------------
--
-- "Which companies does this person belong to?" is unanswerable inside the
-- tenancy model, because answering it requires looking at every company. It is
-- also the first question sign-in has to ask.
--
-- This view is the narrow, named exception. It is owned by the migrator and
-- created without `security_invoker`, so it reads `tenant_users` with the
-- owner's privileges and RLS does not apply — which is exactly why it exposes
-- four columns and not one more. No email, no display name: given an identity
-- you learn which companies it belongs to and at what role, which is the
-- question, and nothing about anybody else.
--
-- Granted to `integr8_auth` alone. The schema-invariant suite fails if any
-- other view appears in this schema.

create view auth_memberships
with (security_invoker = false) as
  select
    tu.tenant_id,
    tu.user_id,
    tu.role,
    tu.status
  from tenant_users tu
  join tenants t on t.id = tu.tenant_id
  where tu.deleted_at is null
    and t.deleted_at is null
    and t.status = 'active';

comment on view auth_memberships is
  'Sign-in only: which active companies an identity belongs to. Deliberately bypasses RLS; granted to integr8_auth alone.';

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------

grant usage on schema public to integr8_auth;

-- The pre-authentication role reaches these three objects and nothing else.
grant select, insert on login_attempts to integr8_auth;
grant select, insert, update on account_locks to integr8_auth;
grant select on auth_memberships to integr8_auth;

-- The tenant runtime role owns everything that happens after a company is
-- known. It cannot see login_attempts, account_locks or auth_memberships.
grant select, insert, update on sessions to integr8_app;
grant select, insert, update on refresh_tokens to integr8_app;
grant select, insert, update on offline_grants to integr8_app;
grant select, insert, update on invitations to integr8_app;
grant select, insert, update on impersonation_grants to integr8_app;

-- No delete anywhere above. Sessions, tokens, invitations and grants are
-- revoked by setting a timestamp, never removed: "this session was revoked at
-- 14:02 for refresh_token_reuse" is the answer an incident needs, and a deleted
-- row cannot give it.

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

alter table sessions enable row level security;

create policy sessions_isolation on sessions
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table refresh_tokens enable row level security;

create policy refresh_tokens_isolation on refresh_tokens
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table offline_grants enable row level security;

create policy offline_grants_isolation on offline_grants
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table invitations enable row level security;

create policy invitations_isolation on invitations
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table impersonation_grants enable row level security;

create policy impersonation_grants_isolation on impersonation_grants
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

-- The two platform tables: RLS on, so the "every table in public" invariant
-- holds with no exception. `integr8_auth` reaches them through a policy that
-- does not filter, because there is no tenant to filter by; the isolation it
-- gets is that this role can reach nothing else.
alter table login_attempts enable row level security;

create policy login_attempts_pre_auth on login_attempts
  for all
  to integr8_auth
  using (true)
  with check (true);

alter table account_locks enable row level security;

create policy account_locks_pre_auth on account_locks
  for all
  to integr8_auth
  using (true)
  with check (true);
