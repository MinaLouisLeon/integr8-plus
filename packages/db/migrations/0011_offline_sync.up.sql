-- P12: offline sync.
--
-- Three things a phone needs from the database to stay in step with it:
--
-- 1. **What changed since it last asked** — `sync_touches`, a log of which
--    work orders, customers, sites and forms each transaction touched, with the
--    transaction's id. A pull asks for touches between its cursor and the
--    oldest transaction still running (`pg_snapshot_xmin`): every transaction
--    below that line has finished, so nothing committed out of order can be
--    skipped. The log is appended to, never updated, so two transactions
--    touching the same jobs in different orders never wait on each other.
-- 2. **Uploads that survive days without signal** — multipart uploads, whose
--    parts can be sent over several connections and resumed.
-- 3. **How sync is going in the field** — `sync_reports`, one row per sync run
--    a phone reports.

-- ---------------------------------------------------------------------------
-- The change log
-- ---------------------------------------------------------------------------

create table sync_touches (
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  entity_kind  text        not null,
  entity_id    uuid        not null,
  xid          xid8        not null default pg_current_xact_id(),
  created_at   timestamptz not null default now(),

  constraint sync_touches_kind_known
    check (entity_kind in ('work_order', 'customer', 'site', 'form'))
);

comment on table sync_touches is
  'Which records each transaction changed, by transaction id. Written by trigger; a pull reads the touches between its cursor and the oldest running transaction.';

create index sync_touches_by_xid on sync_touches (tenant_id, xid);
create index sync_touches_by_entity on sync_touches (tenant_id, entity_kind, entity_id, xid);

-- How far the log has been pruned, per company. A cursor from before this has
-- missed touches, and its phone downloads everything again.
create table sync_log_marks (
  tenant_id      uuid  primary key references tenants (id) on delete restrict,
  pruned_before  xid8  not null
);

comment on table sync_log_marks is
  'The oldest transaction id still fully covered by sync_touches for a company.';

-- Security definer: the runtime role can read the log, not write it.
create function touch_sync() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  kind   text := tg_argv[0];
  column_name text := tg_argv[1];
  target record;
  entity uuid;
begin
  if tg_op = 'DELETE' then
    target := old;
  else
    target := new;
  end if;
  entity := (to_jsonb(target) ->> column_name)::uuid;
  if entity is not null then
    insert into public.sync_touches (tenant_id, entity_kind, entity_id)
    values (target.tenant_id, kind, entity);
  end if;
  -- A row that moved to another parent touches the old parent too.
  if tg_op = 'UPDATE' and (to_jsonb(old) ->> column_name) is distinct from (to_jsonb(new) ->> column_name)
     and (to_jsonb(old) ->> column_name) is not null then
    insert into public.sync_touches (tenant_id, entity_kind, entity_id)
    values (old.tenant_id, kind, (to_jsonb(old) ->> column_name)::uuid);
  end if;
  return null;
end;
$$;

comment on function touch_sync() is
  'Records that a row touched a synced record: tg_argv[0] is the record kind, tg_argv[1] the column naming it. Security definer: the runtime role cannot write sync_touches.';

create trigger work_orders_touch_sync after insert or update on work_orders
  for each row execute function touch_sync('work_order', 'id');
create trigger work_order_assignments_touch_sync after insert or update or delete on work_order_assignments
  for each row execute function touch_sync('work_order', 'work_order_id');
create trigger work_order_checklist_items_touch_sync after insert or update or delete on work_order_checklist_items
  for each row execute function touch_sync('work_order', 'work_order_id');
create trigger work_order_comments_touch_sync after insert on work_order_comments
  for each row execute function touch_sync('work_order', 'work_order_id');
create trigger work_order_forms_touch_sync after insert or update or delete on work_order_forms
  for each row execute function touch_sync('work_order', 'work_order_id');
create trigger submissions_touch_sync after insert or update on submissions
  for each row execute function touch_sync('work_order', 'work_order_id');
create trigger attachments_touch_work_order after insert or update on attachments
  for each row execute function touch_sync('work_order', 'work_order_id');
create trigger attachments_touch_customer after insert or update on attachments
  for each row execute function touch_sync('customer', 'customer_id');
create trigger attachments_touch_site after insert or update on attachments
  for each row execute function touch_sync('site', 'site_id');
create trigger customers_touch_sync after insert or update on customers
  for each row execute function touch_sync('customer', 'id');
create trigger customer_contacts_touch_sync after insert or update on customer_contacts
  for each row execute function touch_sync('customer', 'customer_id');
create trigger sites_touch_sync after insert or update on sites
  for each row execute function touch_sync('site', 'id');
create trigger forms_touch_sync after insert or update on forms
  for each row execute function touch_sync('form', 'id');
create trigger form_versions_touch_sync after insert or update on form_versions
  for each row execute function touch_sync('form', 'form_id');

-- Removes touches older than `older_than`, remembering how far it went.
create function prune_sync_touches(tenant uuid, older_than interval) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  boundary xid8;
  removed bigint;
begin
  if tenant is distinct from public.app_current_tenant_id() then
    raise exception 'prune_sync_touches may only prune the current company' using errcode = '42501';
  end if;
  select max(xid) into boundary
  from public.sync_touches
  where tenant_id = tenant and created_at < now() - older_than;
  if boundary is null then
    return 0;
  end if;
  delete from public.sync_touches where tenant_id = tenant and xid <= boundary;
  get diagnostics removed = row_count;
  insert into public.sync_log_marks (tenant_id, pruned_before)
  values (tenant, boundary)
  on conflict (tenant_id) do update
    set pruned_before = greatest(public.sync_log_marks.pruned_before, excluded.pruned_before);
  return removed;
end;
$$;

comment on function prune_sync_touches(uuid, interval) is
  'Deletes the current company''s sync touches older than an interval and records the boundary. Security definer: the runtime role cannot delete from sync_touches.';

-- ---------------------------------------------------------------------------
-- Resumable uploads
-- ---------------------------------------------------------------------------

alter table upload_intents
  add column multipart_upload_id text,
  add column part_size integer,
  add constraint upload_intents_multipart_pair
    check ((multipart_upload_id is null) = (part_size is null)),
  add constraint upload_intents_part_size_sane
    check (part_size is null or part_size between 5242880 and 104857600);

comment on column upload_intents.multipart_upload_id is
  'Set when the bytes arrive in parts, which can be resumed across connections and days.';

-- A phone resuming an upload keeps it alive; nothing else about an intent changes.
grant update (expires_at) on upload_intents to integr8_app;

-- ---------------------------------------------------------------------------
-- Field reports
-- ---------------------------------------------------------------------------

create table sync_reports (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete restrict,
  user_id            uuid        not null,
  report_id          uuid        not null,
  started_at         timestamptz not null,
  duration_ms        integer     not null,
  trigger            text        not null,
  outcome            text        not null,
  pushed             integer     not null default 0,
  conflicts          integer     not null default 0,
  rejected           integer     not null default 0,
  retried            integer     not null default 0,
  pulled             integer     not null default 0,
  uploads_completed  integer     not null default 0,
  uploads_failed     integer     not null default 0,
  uploaded_bytes     bigint      not null default 0,
  queue_depth        integer     not null default 0,
  pending_uploads    integer     not null default 0,
  network_type       text,
  clock_offset_ms    integer,
  app_version        text,
  received_at        timestamptz not null default now(),

  constraint sync_reports_report_unique unique (tenant_id, report_id),
  constraint sync_reports_trigger_known
    check (trigger in ('launch', 'foreground', 'reconnect', 'background', 'manual', 'change')),
  constraint sync_reports_outcome_known
    check (outcome in ('complete', 'partial', 'offline', 'failed')),
  constraint sync_reports_counts_sane
    check (duration_ms >= 0 and pushed >= 0 and conflicts >= 0 and rejected >= 0 and retried >= 0
           and pulled >= 0 and uploads_completed >= 0 and uploads_failed >= 0 and uploaded_bytes >= 0
           and queue_depth >= 0 and pending_uploads >= 0)
);

comment on table sync_reports is
  'One sync run as a phone reported it: how long, what moved, what is still waiting. started_at is corrected by the phone''s measured clock offset.';

create index sync_reports_tenant_idx on sync_reports (tenant_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------

grant select on sync_touches to integr8_app;
grant select on sync_log_marks to integr8_app;
grant select, insert on sync_reports to integr8_app;

alter table sync_touches enable row level security;
create policy sync_touches_isolation on sync_touches
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table sync_log_marks enable row level security;
create policy sync_log_marks_isolation on sync_log_marks
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table sync_reports enable row level security;
create policy sync_reports_isolation on sync_reports
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
