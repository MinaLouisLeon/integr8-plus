-- 0077 — test companies and staff sessions limited to them (P38).
--
-- The developer MCP server lets an AI coding tool act as the people of a
-- company on a running API, production included. What keeps it away from
-- real customers is enforced here and in the API, not in the tool:
--
--   tenants.is_test             set when the company is created, never after
--   platform_sessions.scope     'full' (the dashboard) or 'test_companies'
--   impersonation_grants.from_limited_session
--                               a grant started from a limited session
--   test_outbox                 mail and push a test company would have sent
--
-- Expand-only: the previous release neither reads nor writes any of it, and
-- every default keeps today's behaviour (real companies, full sessions).

-- ---------------------------------------------------------------------------
-- tenants.is_test
-- ---------------------------------------------------------------------------
--
-- A real company can never be turned into one the tool may enter, and a test
-- company never into a real one (whose billing and mail would then start). So
-- the column is written once, by the insert, and a trigger refuses any later
-- change in either direction. The purge runs with triggers suspended (0055)
-- and deletes the row, which is not a change of the mark.

alter table tenants add column is_test boolean not null default false;

comment on column tenants.is_test is
  'A test company (0077): made by the demo seeder or with the dashboard''s switch; left out of billing and totals, sends no mail or push, and the only kind a limited staff session may reach. Fixed at creation.';

create function tenants_is_test_fixed() returns trigger
  language plpgsql
as $$
begin
  if new.is_test is distinct from old.is_test then
    raise exception 'A company''s test mark is set when it is created and cannot change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger tenants_is_test_fixed
  before update of is_test on tenants
  for each row execute function tenants_is_test_fixed();

-- ---------------------------------------------------------------------------
-- platform_sessions.scope
-- ---------------------------------------------------------------------------
--
-- 'test_companies' is asked for at sign-in by the developer tool's terminal
-- login. The API refuses such a session on every platform route not opened to
-- it, and on every opened route for a company that is not a test company. It
-- lasts 8 hours from sign-in whatever happens; the API sets expires_at, and
-- refreshing never extends a platform session (P15).

alter table platform_sessions
  add column scope text not null default 'full',
  add constraint platform_sessions_scope_known check (scope in ('full', 'test_companies'));

comment on column platform_sessions.scope is
  'What the session may reach (0077): ''full'' (the dashboard) or ''test_companies'' (the developer MCP server, 8 hours).';

-- ---------------------------------------------------------------------------
-- impersonation_grants.from_limited_session
-- ---------------------------------------------------------------------------

alter table impersonation_grants
  add column from_limited_session boolean not null default false;

comment on column impersonation_grants.from_limited_session is
  'Started from a staff session limited to test companies (0077): the developer MCP server.';

-- ---------------------------------------------------------------------------
-- test_outbox
-- ---------------------------------------------------------------------------
--
-- What a test company would have emailed or pushed, so a developer can check
-- "the customer would have been sent the PDF" without anybody being sent
-- anything. Written and read by the API's platform role; kept for 7 days by
-- the worker's retention job. Attachments are listed by name, type and size;
-- their bytes are not kept.

create table test_outbox (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete restrict,
  channel     text        not null,
  recipient   text        not null,
  subject     text,
  body        text        not null,
  details     jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),

  constraint test_outbox_tenant_id_unique unique (tenant_id, id),
  constraint test_outbox_channel_known check (channel in ('email', 'push')),
  constraint test_outbox_recipient_length check (char_length(recipient) between 1 and 320),
  constraint test_outbox_subject_length check (subject is null or char_length(subject) <= 500),
  constraint test_outbox_body_length check (char_length(body) <= 100000)
);

create index test_outbox_recent on test_outbox (tenant_id, created_at desc);
create index test_outbox_retention on test_outbox (created_at);

comment on table test_outbox is
  'Mail and push a test company would have sent (0077), kept 7 days for the developer MCP server.';

grant select on test_outbox to integr8_app;

alter table test_outbox enable row level security;

create policy test_outbox_isolation on test_outbox for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
