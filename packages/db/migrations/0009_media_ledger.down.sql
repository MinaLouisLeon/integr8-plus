-- 0009 - down.
--
-- Returns to P08's media_objects: ledger rows become stored objects, intents
-- become pending ones. Deletion history, thumbnails and the usage rollup are
-- discarded, and purged files are dropped because their bytes are gone.

create table media_objects (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  content_type  text        not null,
  byte_size     bigint      not null,
  storage_key   text        not null,
  status        text        not null default 'pending',
  created_by    uuid        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  stored_at     timestamptz,

  constraint media_objects_tenant_id_unique unique (tenant_id, id),
  constraint media_objects_storage_key_unique unique (storage_key),
  constraint media_objects_status_known check (status in ('pending', 'stored')),
  constraint media_objects_stored_complete check ((status = 'stored') = (stored_at is not null)),
  constraint media_objects_content_type_format check (content_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  constraint media_objects_byte_size_positive check (byte_size > 0)
);

create index media_objects_tenant_idx on media_objects (tenant_id, created_at desc);

create trigger media_objects_set_updated_at
  before update on media_objects
  for each row execute function set_updated_at();

insert into media_objects (id, tenant_id, content_type, byte_size, storage_key, status, created_by, created_at, stored_at)
select id, tenant_id, content_type, greatest(byte_size, 1), storage_key, 'stored', uploaded_by, created_at, created_at
  from files
 where purged_at is null;

insert into media_objects (id, tenant_id, content_type, byte_size, storage_key, status, created_by, created_at)
select id, tenant_id, content_type, declared_bytes, storage_key, 'pending', created_by, created_at
  from upload_intents;

grant select, insert, update on media_objects to integr8_app;
alter table media_objects enable row level security;
create policy media_objects_isolation on media_objects
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

drop trigger if exists files_record_usage on files;
drop function if exists record_file_usage();
drop trigger if exists files_protect_ledger on files;
drop function if exists protect_file_ledger();

drop table if exists tenant_storage_usage;
drop table if exists files;
drop table if exists upload_intents;
drop table if exists tenant_storage;
