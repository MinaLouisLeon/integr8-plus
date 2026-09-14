-- 0009 - the media ledger.
--
-- P08 recorded uploads in media_objects, one row per file whether or not it had
-- arrived. P09 bills from this data, so it splits in two:
--
--   upload_intents   what a client asked to upload. The declared type and size
--                    live here, and only here. Not billing data: an intent that
--                    is never confirmed is swept away with its object.
--
--   files            the ledger. A row exists only once the API has read the
--                    object back from storage (HEAD) and found exactly what was
--                    declared; its size and ETag are storage's, never the
--                    client's. Nothing may change them afterwards.
--
--   tenant_storage_usage
--                    bytes and objects per company per media category, kept by
--                    trigger on every ledger change, so it is always the sum of
--                    what the ledger says is in the bucket — thumbnails and files
--                    in their restore window included, because both still occupy
--                    the bucket until they are purged.
--
--   tenant_storage   which bucket belongs to which company. One bucket each,
--                    because Cloudflare reports storage per bucket and cannot
--                    split a bucket by prefix.
--
-- The id a submission's answer carries (`mediaId`) is the intent's id, and the
-- ledger row keeps it, so references made in P08 still resolve.

-- ---------------------------------------------------------------------------
-- tenant_storage
-- ---------------------------------------------------------------------------

create table tenant_storage (
  tenant_id       uuid        primary key references tenants (id) on delete restrict,
  provider        text        not null,
  bucket          text        not null,
  provisioned_at  timestamptz not null default now(),
  purged_at       timestamptz,

  constraint tenant_storage_bucket_unique unique (provider, bucket),
  constraint tenant_storage_provider_known check (provider in ('local', 'r2')),
  -- R2's rules: 3-63 lowercase letters, digits and hyphens, starting and ending alphanumeric.
  constraint tenant_storage_bucket_name check (bucket ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')
);

comment on table tenant_storage is
  'The bucket each company''s files live in. Written by provisioning, as the schema owner; read by the runtime role.';

-- ---------------------------------------------------------------------------
-- upload_intents
-- ---------------------------------------------------------------------------

create table upload_intents (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete restrict,
  bucket          text        not null,
  storage_key     text        not null,
  content_type    text        not null,
  declared_bytes  bigint      not null,
  category        text        not null,
  created_by      uuid        not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,

  constraint upload_intents_tenant_id_unique unique (tenant_id, id),
  constraint upload_intents_key_unique unique (bucket, storage_key),
  constraint upload_intents_declared_positive check (declared_bytes > 0),
  constraint upload_intents_category_known check (category in ('image', 'video', 'document', 'other')),
  constraint upload_intents_content_type_format check (content_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  constraint upload_intents_expiry_after_creation check (expires_at > created_at)
);

comment on table upload_intents is
  'An upload a client has asked to make. Declared values only; not billing data. Confirmed into files or swept with its object.';

create index upload_intents_expiry_idx on upload_intents (tenant_id, expires_at);

-- ---------------------------------------------------------------------------
-- files
-- ---------------------------------------------------------------------------

create table files (
  id                  uuid        primary key,
  tenant_id           uuid        not null references tenants (id) on delete restrict,
  bucket              text        not null,
  storage_key         text        not null,
  -- From storage's HEAD response at confirmation. Never from the client.
  byte_size           bigint      not null,
  etag                text,
  content_type        text        not null,
  category            text        not null,
  linked_entity_type  text,
  linked_entity_id    uuid,
  uploaded_by         uuid        not null,
  created_at          timestamptz not null default now(),
  thumbnail_status    text        not null default 'none',
  thumbnail_key       text,
  thumbnail_bytes     bigint,
  deleted_at          timestamptz,
  deleted_by          uuid,
  purge_after         timestamptz,
  purged_at           timestamptz,

  constraint files_tenant_id_unique unique (tenant_id, id),
  constraint files_key_unique unique (bucket, storage_key),
  constraint files_byte_size_sane check (byte_size >= 0),
  constraint files_category_known check (category in ('image', 'video', 'document', 'other')),
  constraint files_content_type_format check (content_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  constraint files_link_pair check ((linked_entity_type is null) = (linked_entity_id is null)),
  constraint files_thumbnail_status_known
    check (thumbnail_status in ('none', 'pending', 'ready', 'failed')),
  -- A ready thumbnail is an object, with a key and a size; nothing else has one.
  constraint files_thumbnail_complete
    check ((thumbnail_status = 'ready') = (thumbnail_key is not null and thumbnail_bytes is not null)),
  constraint files_thumbnail_bytes_sane check (thumbnail_bytes is null or thumbnail_bytes >= 0),
  -- Deleted, by whom, and when it is purged are one fact.
  constraint files_deletion_complete
    check ((deleted_at is null) = (deleted_by is null and purge_after is null)),
  constraint files_purged_only_when_deleted check (purged_at is null or deleted_at is not null)
);

comment on table files is
  'The media ledger. A row is written only after storage confirms the object; size and ETag are storage''s and cannot change.';
comment on column files.purge_after is
  'End of the restore window. After this the object is deleted from storage and purged_at is set.';

create index files_tenant_idx on files (tenant_id, created_at desc);
create index files_purge_due_idx on files (tenant_id, purge_after) where deleted_at is not null and purged_at is null;
create index files_thumbnail_pending_idx on files (tenant_id) where thumbnail_status = 'pending';

-- The ledger's facts do not change: what was stored, where, how big, by whom.
-- Deletion, purge and thumbnails move forward only.
create function protect_file_ledger() returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.bucket is distinct from old.bucket
     or new.storage_key is distinct from old.storage_key
     or new.byte_size is distinct from old.byte_size
     or new.etag is distinct from old.etag
     or new.content_type is distinct from old.content_type
     or new.category is distinct from old.category
     or new.uploaded_by is distinct from old.uploaded_by
     or new.created_at is distinct from old.created_at then
    raise exception 'file % is in the ledger; what was stored cannot be changed', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.purged_at is not null and (new.purged_at is null or new.deleted_at is distinct from old.deleted_at) then
    raise exception 'file % was purged from storage and cannot be restored', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.thumbnail_status = 'ready'
     and (new.thumbnail_key is distinct from old.thumbnail_key
          or new.thumbnail_bytes is distinct from old.thumbnail_bytes) then
    raise exception 'file % already has a thumbnail', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

create trigger files_protect_ledger
  before update on files
  for each row execute function protect_file_ledger();

-- ---------------------------------------------------------------------------
-- tenant_storage_usage
-- ---------------------------------------------------------------------------

create table tenant_storage_usage (
  tenant_id   uuid        not null references tenants (id) on delete restrict,
  category    text        not null,
  bytes       bigint      not null default 0,
  objects     integer     not null default 0,
  updated_at  timestamptz not null default now(),

  constraint tenant_storage_usage_pk primary key (tenant_id, category),
  constraint tenant_storage_usage_category_known
    check (category in ('image', 'video', 'document', 'other', 'thumbnail')),
  constraint tenant_storage_usage_non_negative check (bytes >= 0 and objects >= 0)
);

comment on table tenant_storage_usage is
  'Bytes and objects in each company''s bucket, by media category, maintained by trigger from files. Thumbnails are their own category.';

-- What a ledger row contributes to its bucket: the file until it is purged, and
-- its thumbnail once one exists, until the same moment.
create function record_file_usage() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  tenant uuid;
  category_name text;
  file_bytes bigint := 0;
  file_objects integer := 0;
  thumb_bytes bigint := 0;
  thumb_objects integer := 0;
  delta_category text;
  delta_bytes bigint;
  delta_objects integer;
begin
  if tg_op = 'DELETE' then
    tenant := old.tenant_id;
    category_name := old.category;
  else
    tenant := new.tenant_id;
    category_name := new.category;
  end if;

  if tg_op <> 'INSERT' and old.purged_at is null then
    file_bytes := file_bytes - old.byte_size;
    file_objects := file_objects - 1;
    if old.thumbnail_bytes is not null then
      thumb_bytes := thumb_bytes - old.thumbnail_bytes;
      thumb_objects := thumb_objects - 1;
    end if;
  end if;
  if tg_op <> 'DELETE' and new.purged_at is null then
    file_bytes := file_bytes + new.byte_size;
    file_objects := file_objects + 1;
    if new.thumbnail_bytes is not null then
      thumb_bytes := thumb_bytes + new.thumbnail_bytes;
      thumb_objects := thumb_objects + 1;
    end if;
  end if;

  -- Update first, insert only if there is no row yet. A CHECK is judged on the
  -- proposed insert before ON CONFLICT resolves, so a negative delta offered as
  -- an insert is refused however large the existing row is.
  for pass in 1..2 loop
    if pass = 1 then
      delta_category := category_name;
      delta_bytes := file_bytes;
      delta_objects := file_objects;
    else
      delta_category := 'thumbnail';
      delta_bytes := thumb_bytes;
      delta_objects := thumb_objects;
    end if;
    continue when delta_bytes = 0 and delta_objects = 0;

    update public.tenant_storage_usage
       set bytes = bytes + delta_bytes,
           objects = objects + delta_objects,
           updated_at = now()
     where tenant_id = tenant and category = delta_category;
    if not found then
      insert into public.tenant_storage_usage as usage (tenant_id, category, bytes, objects)
      values (tenant, delta_category, delta_bytes, delta_objects)
      on conflict (tenant_id, category) do update
        set bytes = usage.bytes + excluded.bytes,
            objects = usage.objects + excluded.objects,
            updated_at = now();
    end if;
  end loop;
  return null;
end;
$$;

comment on function record_file_usage() is
  'Keeps tenant_storage_usage equal to the sum of what the ledger says occupies each bucket. Security definer: the runtime role can only read the rollup.';

create trigger files_record_usage
  after insert or update or delete on files
  for each row execute function record_file_usage();

-- ---------------------------------------------------------------------------
-- From P08's media_objects
-- ---------------------------------------------------------------------------
--
-- Everything P08 stored was on local disk, whose "bucket" is the company id's
-- directory. Stored objects become ledger rows (no ETag: the local store never
-- had one); pending ones become intents that expire at once, so the sweeper
-- clears them.

insert into tenant_storage (tenant_id, provider, bucket)
select distinct tenant_id, 'local', 'local-' || tenant_id::text
  from media_objects
on conflict do nothing;

insert into files (id, tenant_id, bucket, storage_key, byte_size, content_type, category, uploaded_by, created_at)
select id, tenant_id, 'local-' || tenant_id::text, storage_key, byte_size, content_type,
       case
         when content_type like 'image/%' then 'image'
         when content_type like 'video/%' then 'video'
         when content_type in ('application/pdf', 'text/plain') then 'document'
         else 'other'
       end,
       created_by, coalesce(stored_at, created_at)
  from media_objects
 where status = 'stored';

insert into upload_intents (id, tenant_id, bucket, storage_key, content_type, declared_bytes, category, created_by, created_at, expires_at)
select id, tenant_id, 'local-' || tenant_id::text, storage_key, content_type, byte_size, 'other',
       created_by, created_at, created_at + interval '1 second'
  from media_objects
 where status = 'pending';

drop policy media_objects_isolation on media_objects;
drop table media_objects;

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------
--
-- The runtime role confirms uploads, soft-deletes, restores, purges and records
-- thumbnails. It never deletes a ledger row: removing a company's files is a
-- platform operation run as the schema owner.

grant select on tenant_storage to integr8_app;
grant select, insert, delete on upload_intents to integr8_app;
grant select, insert, update on files to integr8_app;
grant select on tenant_storage_usage to integr8_app;

alter table tenant_storage enable row level security;
create policy tenant_storage_isolation on tenant_storage
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table upload_intents enable row level security;
create policy upload_intents_isolation on upload_intents
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table files enable row level security;
create policy files_isolation on files
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table tenant_storage_usage enable row level security;
create policy tenant_storage_usage_isolation on tenant_storage_usage
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());
