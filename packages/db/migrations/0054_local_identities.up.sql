-- Sign-in without Supabase: company people's credentials kept here.
--
--   identities             one row per person who can sign in to a company,
--                          with their password hash
--   identity_magic_links   one-time sign-in links, stored as hashes
--
-- Used when the API runs with IDENTITY_PROVIDER=local. With the default,
-- Supabase holds credentials and these tables stay empty.
--
-- Not tenant-scoped, for the same reason login_attempts is not (0003): at the
-- moment somebody signs in, the company is not known yet, and one person can
-- belong to several. Only the pre-authentication role reaches them; the tenant
-- runtime role holds nothing on either, so no company request can list who
-- else can sign in.
--
-- An identity's id is the user id every company row uses (tenant_users.user_id
-- and the rest). It carries no foreign key from those tables, exactly as a
-- Supabase user id never did: an identity outlives any one company.

create table identities (
  id                 uuid        primary key default gen_random_uuid(),
  email              text        not null,
  -- scrypt$N$r$p$salt$hash, as for platform users (0015). Null for somebody
  -- who has only ever signed in with a link.
  password_hash      text,
  email_verified_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint identities_email_lower check (email = lower(btrim(email))),
  constraint identities_email_shape check (email like '%_@_%')
);

comment on table identities is
  'Credentials for people who sign in to companies, when IDENTITY_PROVIDER=local. Not tenant-scoped; reached by integr8_auth alone.';

create unique index identities_email_key on identities (email);

create table identity_magic_links (
  token_hash   text        primary key,
  identity_id  uuid        not null references identities (id) on delete cascade,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);

comment on table identity_magic_links is
  'One-time sign-in links, as SHA-256 hashes of the token sent. Not tenant-scoped; reached by integr8_auth alone.';

create index identity_magic_links_identity_idx on identity_magic_links (identity_id);

-- ---------------------------------------------------------------------------
-- Grants. No delete on identities: a person stops signing in by losing their
-- memberships, and the row that says who they were stays. Links are deleted
-- once spent or expired, like rate-limit counters (0004).
-- ---------------------------------------------------------------------------

grant select, insert, update on identities to integr8_auth;
grant select, insert, update, delete on identity_magic_links to integr8_auth;

alter table identities enable row level security;

create policy identities_pre_auth on identities
  for all
  to integr8_auth
  using (true)
  with check (true);

alter table identity_magic_links enable row level security;

create policy identity_magic_links_pre_auth on identity_magic_links
  for all
  to integr8_auth
  using (true)
  with check (true);
