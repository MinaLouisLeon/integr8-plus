-- P36: self-hosted sign-in.
--
--   sessions.signed_in_with     how the person proved who they are for this session
--   sessions.authenticated_at   when they last did
--   identity_deletions          sign-in accounts still to delete after a company purge
--
-- Signing in moves to a Supabase Auth container beside the API, which keeps
-- its own tables in the `auth` schema of this database (created by the
-- migrator's bootstrap, migrated by Auth itself). Nothing here touches that
-- schema: everything below is in `public`.
--
-- Changing a password needs proof: the current password, or a sign-in with an
-- emailed code in the last fifteen minutes. The second is read from the
-- session, so the session has to say how it began and when. Switching company
-- copies both to the new session, so the fifteen minutes follow the person and
-- not the session.
--
-- Defaults stay on both columns so an API container from the previous release,
-- still running while this one starts, can go on creating sessions.

alter table sessions
  add column signed_in_with   text        not null default 'password',
  add column authenticated_at timestamptz;

update sessions set authenticated_at = created_at where authenticated_at is null;

alter table sessions
  alter column authenticated_at set default now(),
  alter column authenticated_at set not null,
  add constraint sessions_signed_in_with_known
    check (signed_in_with in ('password', 'email_code', 'invitation', 'signup', 'impersonation'));

comment on column sessions.signed_in_with is
  'How the person proved who they are: password, email_code, invitation, signup or impersonation. Copied on a company switch.';
comment on column sessions.authenticated_at is
  'When the person last proved who they are. Copied on a company switch, so a code sign-in stays fresh for fifteen minutes wherever they go.';

-- ---------------------------------------------------------------------------
-- identity_deletions
-- ---------------------------------------------------------------------------
--
-- When a company is purged, each of its people who belongs to no other company
-- has their sign-in account deleted from Auth. Auth is another service and can
-- be down, so the ids are written here first and worked through after: a
-- failed delete stays pending and the next purge run tries again. Without this
-- table a failure would be lost with the company's rows, which held the only
-- record of who its people were.
--
-- A platform table: it names people by id only, belongs to no company and is
-- reached by the platform (owner) connection alone. RLS is on with no policy,
-- so neither runtime role can read it.

create table identity_deletions (
  user_id          uuid        primary key,
  queued_at        timestamptz not null default now(),
  attempts         integer     not null default 0,
  last_attempt_at  timestamptz,
  last_error       text,
  completed_at     timestamptz,

  constraint identity_deletions_attempts_sane check (attempts >= 0)
);

comment on table identity_deletions is
  'Sign-in accounts to delete from Auth after a purge, retried until done. Platform only.';

create index identity_deletions_pending_idx on identity_deletions (queued_at)
  where completed_at is null;

alter table identity_deletions enable row level security;
