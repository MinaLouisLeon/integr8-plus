-- Stored files, uploads and storage metering.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.protect_file_ledger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.record_file_usage() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE files (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    bucket text NOT NULL,
    storage_key text NOT NULL,
    byte_size bigint NOT NULL,
    etag text,
    content_type text NOT NULL,
    category text NOT NULL,
    linked_entity_type text,
    linked_entity_id uuid,
    uploaded_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    thumbnail_status text DEFAULT 'none'::text NOT NULL,
    thumbnail_key text,
    thumbnail_bytes bigint,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    purge_after timestamp with time zone,
    purged_at timestamp with time zone,
    CONSTRAINT files_byte_size_sane CHECK ((byte_size >= 0)),
    CONSTRAINT files_category_known CHECK ((category = ANY (ARRAY['image'::text, 'video'::text, 'document'::text, 'other'::text]))),
    CONSTRAINT files_content_type_format CHECK ((content_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'::text)),
    CONSTRAINT files_deletion_complete CHECK (((deleted_at IS NULL) = ((deleted_by IS NULL) AND (purge_after IS NULL)))),
    CONSTRAINT files_link_pair CHECK (((linked_entity_type IS NULL) = (linked_entity_id IS NULL))),
    CONSTRAINT files_purged_only_when_deleted CHECK (((purged_at IS NULL) OR (deleted_at IS NOT NULL))),
    CONSTRAINT files_thumbnail_bytes_sane CHECK (((thumbnail_bytes IS NULL) OR (thumbnail_bytes >= 0))),
    CONSTRAINT files_thumbnail_complete CHECK (((thumbnail_status = 'ready'::text) = ((thumbnail_key IS NOT NULL) AND (thumbnail_bytes IS NOT NULL)))),
    CONSTRAINT files_thumbnail_status_known CHECK ((thumbnail_status = ANY (ARRAY['none'::text, 'pending'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE storage_reconciliations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    ran_at timestamp with time zone DEFAULT now() NOT NULL,
    ledger_bytes bigint NOT NULL,
    ledger_objects integer NOT NULL,
    cloudflare_bytes bigint,
    cloudflare_objects integer,
    cloudflare_sampled_at timestamp with time zone,
    drift_bytes bigint,
    status text NOT NULL,
    note text,
    CONSTRAINT storage_reconciliations_drift_pair CHECK ((((status = 'unavailable'::text) AND (cloudflare_bytes IS NULL)) OR ((status <> 'unavailable'::text) AND (cloudflare_bytes IS NOT NULL) AND (drift_bytes IS NOT NULL)))),
    CONSTRAINT storage_reconciliations_ledger_sane CHECK (((ledger_bytes >= 0) AND (ledger_objects >= 0))),
    CONSTRAINT storage_reconciliations_status_known CHECK ((status = ANY (ARRAY['matched'::text, 'drifted'::text, 'unavailable'::text])))
);

CREATE TABLE tenant_storage (
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    bucket text NOT NULL,
    provisioned_at timestamp with time zone DEFAULT now() NOT NULL,
    purged_at timestamp with time zone,
    CONSTRAINT tenant_storage_bucket_name CHECK ((bucket ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'::text)),
    CONSTRAINT tenant_storage_provider_known CHECK ((provider = ANY (ARRAY['local'::text, 'r2'::text])))
);

CREATE TABLE tenant_storage_samples (
    tenant_id uuid NOT NULL,
    sampled_on date NOT NULL,
    bytes bigint NOT NULL,
    objects integer NOT NULL,
    by_category jsonb DEFAULT '{}'::jsonb NOT NULL,
    allowance_bytes bigint,
    overage_bytes bigint,
    class_a_operations bigint,
    class_b_operations bigint,
    CONSTRAINT tenant_storage_samples_category_shape CHECK ((jsonb_typeof(by_category) = 'object'::text)),
    CONSTRAINT tenant_storage_samples_overage_sane CHECK (((overage_bytes IS NULL) OR (overage_bytes >= 0))),
    CONSTRAINT tenant_storage_samples_sane CHECK (((bytes >= 0) AND (objects >= 0)))
);

CREATE TABLE tenant_storage_usage (
    tenant_id uuid NOT NULL,
    category text NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL,
    objects integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_storage_usage_category_known CHECK ((category = ANY (ARRAY['image'::text, 'video'::text, 'document'::text, 'other'::text, 'thumbnail'::text]))),
    CONSTRAINT tenant_storage_usage_non_negative CHECK (((bytes >= 0) AND (objects >= 0)))
);

CREATE TABLE upload_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    bucket text NOT NULL,
    storage_key text NOT NULL,
    content_type text NOT NULL,
    declared_bytes bigint NOT NULL,
    category text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    multipart_upload_id text,
    part_size integer,
    CONSTRAINT upload_intents_category_known CHECK ((category = ANY (ARRAY['image'::text, 'video'::text, 'document'::text, 'other'::text]))),
    CONSTRAINT upload_intents_content_type_format CHECK ((content_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'::text)),
    CONSTRAINT upload_intents_declared_positive CHECK ((declared_bytes > 0)),
    CONSTRAINT upload_intents_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT upload_intents_multipart_pair CHECK (((multipart_upload_id IS NULL) = (part_size IS NULL))),
    CONSTRAINT upload_intents_part_size_sane CHECK (((part_size IS NULL) OR ((part_size >= 5242880) AND (part_size <= 104857600))))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY files
    ADD CONSTRAINT files_key_unique UNIQUE (bucket, storage_key);

ALTER TABLE ONLY files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY files
    ADD CONSTRAINT files_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY storage_reconciliations
    ADD CONSTRAINT storage_reconciliations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenant_storage
    ADD CONSTRAINT tenant_storage_bucket_unique UNIQUE (provider, bucket);

ALTER TABLE ONLY tenant_storage
    ADD CONSTRAINT tenant_storage_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY tenant_storage_samples
    ADD CONSTRAINT tenant_storage_samples_pk PRIMARY KEY (tenant_id, sampled_on);

ALTER TABLE ONLY tenant_storage_usage
    ADD CONSTRAINT tenant_storage_usage_pk PRIMARY KEY (tenant_id, category);

ALTER TABLE ONLY upload_intents
    ADD CONSTRAINT upload_intents_key_unique UNIQUE (bucket, storage_key);

ALTER TABLE ONLY upload_intents
    ADD CONSTRAINT upload_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY upload_intents
    ADD CONSTRAINT upload_intents_tenant_id_unique UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX files_purge_due_idx ON files USING btree (tenant_id, purge_after) WHERE ((deleted_at IS NOT NULL) AND (purged_at IS NULL));

CREATE INDEX files_tenant_idx ON files USING btree (tenant_id, created_at DESC);

CREATE INDEX files_thumbnail_pending_idx ON files USING btree (tenant_id) WHERE (thumbnail_status = 'pending'::text);

CREATE INDEX storage_reconciliations_drifted_idx ON storage_reconciliations USING btree (ran_at DESC) WHERE (status = 'drifted'::text);

CREATE INDEX storage_reconciliations_recent_idx ON storage_reconciliations USING btree (tenant_id, ran_at DESC);

CREATE INDEX tenant_storage_samples_recent_idx ON tenant_storage_samples USING btree (tenant_id, sampled_on DESC);

CREATE INDEX upload_intents_expiry_idx ON upload_intents USING btree (tenant_id, expires_at);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY files
    ADD CONSTRAINT files_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY storage_reconciliations
    ADD CONSTRAINT storage_reconciliations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY tenant_settings
    ADD CONSTRAINT tenant_settings_app_icon_fk FOREIGN KEY (tenant_id, app_icon_media_id) REFERENCES files(tenant_id, id) ON DELETE SET NULL;

ALTER TABLE ONLY tenant_settings
    ADD CONSTRAINT tenant_settings_logo_fk FOREIGN KEY (tenant_id, logo_media_id) REFERENCES files(tenant_id, id) ON DELETE SET NULL;

ALTER TABLE ONLY tenant_storage_samples
    ADD CONSTRAINT tenant_storage_samples_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY tenant_storage
    ADD CONSTRAINT tenant_storage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY tenant_storage_usage
    ADD CONSTRAINT tenant_storage_usage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY upload_intents
    ADD CONSTRAINT upload_intents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER files_protect_ledger BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION protect_file_ledger();

CREATE TRIGGER files_record_usage AFTER INSERT OR DELETE OR UPDATE ON files FOR EACH ROW EXECUTE FUNCTION record_file_usage();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE files ENABLE ROW LEVEL SECURITY;

ALTER TABLE storage_reconciliations ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_storage ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_storage_samples ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_storage_usage ENABLE ROW LEVEL SECURITY;

ALTER TABLE upload_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY files_isolation ON files TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY storage_reconciliations_isolation ON storage_reconciliations USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY tenant_storage_isolation ON tenant_storage FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY tenant_storage_samples_isolation ON tenant_storage_samples USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY tenant_storage_usage_isolation ON tenant_storage_usage FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY upload_intents_isolation ON upload_intents TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION record_file_usage() IS 'Keeps tenant_storage_usage equal to the sum of what the ledger says occupies each bucket. Security definer: the runtime role can only read the rollup.';

COMMENT ON TABLE files IS 'The media ledger. A row is written only after storage confirms the object; size and ETag are storage''s and cannot change.';

COMMENT ON COLUMN files.purge_after IS 'End of the restore window. After this the object is deleted from storage and purged_at is set.';

COMMENT ON TABLE storage_reconciliations IS 'The nightly comparison of the ledger against what Cloudflare bills from (P16). Internal: a company never sees it, because a disagreement between our two counts is our accounting problem and there is nothing they could do about it.';

COMMENT ON TABLE tenant_storage IS 'The bucket each company''s files live in. Written by provisioning, as the schema owner; read by the runtime role.';

COMMENT ON TABLE tenant_storage_samples IS 'One row per company per day: what the ledger said, what the plan allowed, and what Cloudflare charged for (P16). The thirty and ninety day trends read from here, and P17 bills overage from here, which is why the allowance is copied onto the row rather than joined at read time.';

COMMENT ON TABLE tenant_storage_usage IS 'Bytes and objects in each company''s bucket, by media category, maintained by trigger from files. Thumbnails are their own category.';

COMMENT ON TABLE upload_intents IS 'An upload a client has asked to make. Declared values only; not billing data. Confirmed into files or swept with its object.';

COMMENT ON COLUMN upload_intents.multipart_upload_id IS 'Set when the bytes arrive in parts, which can be resumed across connections and days.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,UPDATE ON TABLE files TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE files TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE storage_reconciliations TO integr8_platform;

GRANT SELECT ON TABLE tenant_storage TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_storage TO integr8_platform;

GRANT SELECT ON TABLE tenant_storage_samples TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_storage_samples TO integr8_platform;

GRANT SELECT ON TABLE tenant_storage_usage TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_storage_usage TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE upload_intents TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE upload_intents TO integr8_platform;

GRANT UPDATE(expires_at) ON TABLE upload_intents TO integr8_app;
