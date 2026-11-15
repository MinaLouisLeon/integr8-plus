-- Forms, versions, submissions, the template library and PDF documents.
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

CREATE FUNCTION public.enforce_submission_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  bound_status text;
begin
  if tg_op = 'UPDATE' and new.form_version_id is distinct from old.form_version_id then
    raise exception 'submission % is bound to form version % and cannot be moved to %',
      old.id, old.form_version_id, new.form_version_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if tg_op = 'INSERT' then
    -- Same company, by the composite key above; so this read is one the caller's
    -- own row-level security already permits, and needs no elevated privilege.
    select status into bound_status
      from form_versions
     where tenant_id = new.tenant_id and id = new.form_version_id;

    if bound_status is distinct from 'published' then
      raise exception 'form version % is not published; a submission can only bind to a published version',
        new.form_version_id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  return new;
end;
$$;

CREATE FUNCTION public.enforce_submission_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  version_form uuid;
begin
  if new.last_actor is null then
    raise exception 'submission % was written without last_actor; every change names who made it', new.id
      using errcode = 'not_null_violation';
  end if;

  if tg_op = 'INSERT' then
    select form_id into version_form
      from form_versions
     where tenant_id = new.tenant_id and id = new.form_version_id;
    if new.form_id is distinct from version_form then
      raise exception 'submission % names form % but its version belongs to form %',
        new.id, new.form_id, version_form
        using errcode = 'check_violation';
    end if;
    if new.status = 'reopened' then
      raise exception 'a submission cannot be created reopened'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    -- Submitted in one step: the database says when, not the client.
    if new.status = 'submitted' then
      new.submitted_at := now();
    end if;
    return new;
  end if;

  if new.form_id is distinct from old.form_id then
    raise exception 'submission % belongs to form % and cannot be moved', old.id, old.form_id
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if new.submitted_by is distinct from old.submitted_by then
    raise exception 'submission % was filled by % and that cannot be reassigned', old.id, old.submitted_by
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The transitions that exist. Anything else is refused.
  if not (
       (old.status = new.status and old.status in ('draft', 'reopened'))
    or (old.status = 'draft' and new.status = 'submitted')
    or (old.status = 'submitted' and new.status = 'reopened')
    or (old.status = 'reopened' and new.status = 'submitted')
    or (old.status = 'submitted' and new.status = 'submitted' and new.answers = old.answers)
  ) then
    if old.status = 'submitted' and new.status = 'submitted' then
      raise exception 'submission % is submitted; its answers cannot change without reopening it', old.id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    raise exception 'submission % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if old.status = 'submitted' and new.status = 'reopened'
     and (new.last_reason is null or btrim(new.last_reason) = '') then
    raise exception 'reopening submission % needs a reason', old.id
      using errcode = 'check_violation';
  end if;

  if old.status = 'reopened' and new.status = 'submitted' then
    if new.last_reason is null or btrim(new.last_reason) = '' then
      raise exception 'amending submission % needs a reason', old.id
        using errcode = 'check_violation';
    end if;
    new.amended_at := now();
  end if;

  if old.status = 'draft' and new.status = 'submitted' then
    new.submitted_at := now();
  end if;

  if new.submitted_at is distinct from old.submitted_at and old.submitted_at is not null then
    raise exception 'submission % was first submitted at %; that cannot change', old.id, old.submitted_at
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return new;
end;
$$;

CREATE FUNCTION public.guard_submission_work_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    if new.work_order_id is distinct from old.work_order_id then
      raise exception 'submission % was filled for work order % and cannot be moved', old.id, old.work_order_id
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    return new;
  end if;
  if new.work_order_id is not null and not exists (
    select 1 from work_order_forms wof
     where wof.tenant_id = new.tenant_id and wof.work_order_id = new.work_order_id and wof.form_id = new.form_id
  ) then
    raise exception 'form % is not one of work order %''s forms', new.form_id, new.work_order_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.guard_submit_location() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.submit_location is not null and new.status <> 'submitted' then
      raise exception 'submission % has a submit location but was not submitted', new.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.submit_location is distinct from old.submit_location
     and not (old.status in ('draft', 'reopened') and new.status = 'submitted') then
    raise exception 'the submit location of submission % is written only by submitting it', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.guard_submitted_after_close() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.submitted_after_close then
      raise exception 'submission % cannot start as submitted after close', new.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.submitted_after_close is distinct from old.submitted_after_close
     and not (not old.submitted_after_close and old.status = 'draft' and new.status = 'submitted') then
    raise exception 'submission % is marked submitted after close only by submitting its draft', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.integr8_purging(p_tenant uuid) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select current_setting('integr8.purging', true) = p_tenant::text
     and current_user <> 'integr8_app';
$$;

CREATE FUNCTION public.record_submission_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  event_kind text;
  next_sequence integer;
  reportable jsonb;
begin
  if tg_op = 'INSERT' then
    event_kind := case when new.status = 'submitted' then 'submitted' end;
  elsif old.status is distinct from new.status then
    event_kind := case
      when old.status = 'draft' then 'submitted'
      when new.status = 'reopened' then 'reopened'
      else 'amended'
    end;
  end if;

  if event_kind is null then
    return null;
  end if;

  select coalesce(max(sequence), 0) + 1 into next_sequence
    from public.submission_events
   where submission_id = new.id;

  insert into public.submission_events
    (tenant_id, submission_id, sequence, kind, answers, actor_id, reason, location)
  values
    (new.tenant_id, new.id, next_sequence, event_kind,
     case when event_kind = 'reopened' then null else new.answers end,
     new.last_actor,
     case when event_kind = 'submitted' then null else new.last_reason end,
     case when event_kind = 'reopened' then null else new.submit_location end);

  if event_kind = 'reopened' then
    -- The last submitted values stay reportable while a correction is drafted.
    return null;
  end if;

  delete from public.submission_values where tenant_id = new.tenant_id and submission_id = new.id;

  select reportable_fields into reportable
    from public.form_versions
   where tenant_id = new.tenant_id and id = new.form_version_id;

  insert into public.submission_values
    (tenant_id, submission_id, form_id, form_version_id, field_id, entry_id, entry_index, ordinal,
     value_type, value_text, value_number, value_date, value_time, value_timestamp, value_boolean,
     submitted_at)
  select new.tenant_id, new.id, new.form_id, new.form_version_id, item.field, item.entry_id,
         item.entry_index, item.ordinal, item.type,
         case when item.type = 'text' then left(item.value, 512) end,
         case when item.type = 'number' then item.value::numeric end,
         case when item.type = 'date' then item.value::date end,
         case when item.type = 'time' then item.value::time end,
         case when item.type = 'datetime' then item.value::timestamptz end,
         case when item.type = 'boolean' then item.value::boolean end,
         new.submitted_at
    from (
      -- Where each reportable answer lives: the answers themselves, or — for a
      -- field of a repeatable section — the values of each of its entries.
      with answered as (
        select spec, null::text as entry_id, 0 as entry_index, new.answers as answers
          from jsonb_array_elements(coalesce(reportable, '[]'::jsonb)) as spec
         where spec ->> 'section' is null
        union all
        select spec, entry.value ->> 'id', (entry.ordinality - 1)::integer, entry.value -> 'values'
          from jsonb_array_elements(coalesce(reportable, '[]'::jsonb)) as spec
          cross join lateral jsonb_array_elements(
            case when jsonb_typeof(new.answers -> (spec ->> 'section')) = 'array'
                 then new.answers -> (spec ->> 'section')
                 else '[]'::jsonb end
          ) with ordinality as entry (value, ordinality)
         where spec ->> 'section' is not null
           and jsonb_typeof(entry.value -> 'values') = 'object'
      )
      select spec ->> 'field' as field,
             spec ->> 'type' as type,
             entry_id,
             entry_index,
             0 as ordinal,
             answers ->> (spec ->> 'field') as value
        from answered
       where not coalesce((spec ->> 'multiple')::boolean, false)
      union all
      select spec ->> 'field',
             spec ->> 'type',
             entry_id,
             entry_index,
             (option.ordinality - 1)::integer,
             option.value
        from answered
        cross join lateral jsonb_array_elements_text(
          case when jsonb_typeof(answers -> (spec ->> 'field')) = 'array'
               then answers -> (spec ->> 'field')
               else '[]'::jsonb end
        ) with ordinality as option (value, ordinality)
       where coalesce((spec ->> 'multiple')::boolean, false)
    ) as item
   where item.value is not null and item.value <> '';

  return null;
end;
$$;

CREATE FUNCTION public.record_submission_file_uses() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_table_name = 'submission_events' then
    if new.answers is not null then
      insert into public.submission_file_uses (tenant_id, file_id, submission_id, source)
      select new.tenant_id, file_id, new.submission_id, 'history'
        from public.submission_answer_file_ids(new.answers) as file_id
      on conflict do nothing;
    end if;
    return null;
  end if;

  if tg_op = 'UPDATE' and new.answers is not distinct from old.answers then
    return null;
  end if;
  delete from public.submission_file_uses
   where tenant_id = new.tenant_id and submission_id = new.id and source = 'answers';
  insert into public.submission_file_uses (tenant_id, file_id, submission_id, source)
  select new.tenant_id, file_id, new.id, 'answers'
    from public.submission_answer_file_ids(new.answers) as file_id
  on conflict do nothing;
  return null;
end;
$$;

CREATE FUNCTION public.record_submitted_after_close() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if new.submitted_after_close and not old.submitted_after_close and new.work_order_id is not null then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
    select new.tenant_id, new.work_order_id, 'form_submitted_after_close', new.last_actor,
           jsonb_build_object('submissionId', new.id, 'formId', new.form_id, 'title', f.title)
      from public.forms f
     where f.tenant_id = new.tenant_id and f.id = new.form_id;
  end if;
  return null;
end;
$$;

CREATE FUNCTION public.reject_form_versions_truncate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'form_versions cannot be truncated: published versions are immutable'
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

CREATE FUNCTION public.reject_published_form_version_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.status = 'published' then
    raise exception 'form version % (version %) is published and immutable; % is not permitted. Create a new draft instead.',
      old.id, old.version_number, tg_op
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.reject_submission_events_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'submission_events is append-only; % is not permitted', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

CREATE FUNCTION public.submission_action_results_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'DELETE' then
    if integr8_purging(old.tenant_id) then
      return old;
    end if;
    raise exception 'An action''s outcome is never deleted'
      using errcode = 'check_violation', constraint = 'submission_action_results_frozen';
  end if;
  if old.outcome = 'made' then
    raise exception 'A made action does not change'
      using errcode = 'check_violation', constraint = 'submission_action_results_frozen';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.submission_answer_file_ids(answers jsonb) RETURNS SETOF uuid
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
  select distinct (found #>> '{}')::uuid
    from jsonb_path_query(coalesce(answers, '{}'::jsonb), 'lax $.**.mediaId', '{}', true) as found
   where jsonb_typeof(found) = 'string'
     and (found #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$_$;

CREATE FUNCTION public.submission_links_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'DELETE' and integr8_purging(old.tenant_id) then
    return old;
  end if;
  raise exception 'A link between submissions never changes'
    using errcode = 'check_violation', constraint = 'submission_links_frozen';
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE document_field_values (
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    field_key text NOT NULL,
    label jsonb NOT NULL,
    value text NOT NULL,
    value_normalized text NOT NULL,
    lookup_role text,
    CONSTRAINT document_field_values_key_format CHECK ((field_key ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT document_field_values_lookup_role_known CHECK (((lookup_role IS NULL) OR (lookup_role = ANY (ARRAY['key'::text, 'confirm'::text, 'search'::text])))),
    CONSTRAINT document_field_values_value_length CHECK ((char_length(value) <= 500))
);

CREATE TABLE document_templates (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid NOT NULL,
    name text NOT NULL,
    design jsonb NOT NULL,
    design_schema_version integer DEFAULT 1 NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    archived_at timestamp with time zone,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT document_templates_design_object CHECK ((jsonb_typeof(design) = 'object'::text)),
    CONSTRAINT document_templates_name_length CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT document_templates_revision_positive CHECK ((revision > 0))
);

CREATE TABLE documents (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    template_id uuid,
    template_revision integer,
    submission_id uuid,
    form_id uuid,
    title text NOT NULL,
    public_code text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_code text,
    file_id uuid,
    byte_size bigint,
    page_count integer,
    sha256 text,
    rendered_at timestamp with time zone,
    expired_at timestamp with time zone,
    expired_by uuid,
    expires_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'generated'::text NOT NULL,
    reference text,
    customer_id uuid,
    shareable boolean DEFAULT false NOT NULL,
    quote_id uuid,
    invoice_id uuid,
    purchase_order_id uuid,
    work_order_id uuid,
    qr_spot boolean DEFAULT false NOT NULL,
    qr_printed boolean DEFAULT false NOT NULL,
    printed_design jsonb,
    qr_placement jsonb,
    original_file_id uuid,
    CONSTRAINT documents_business_record CHECK ((((((((quote_id IS NOT NULL))::integer + ((invoice_id IS NOT NULL))::integer) + ((purchase_order_id IS NOT NULL))::integer) + ((work_order_id IS NOT NULL))::integer) =
CASE source
    WHEN 'quote'::text THEN 1
    WHEN 'invoice'::text THEN 1
    WHEN 'purchase_order'::text THEN 1
    WHEN 'job_report'::text THEN 1
    ELSE 0
END) AND ((source <> 'quote'::text) OR (quote_id IS NOT NULL)) AND ((source <> 'invoice'::text) OR (invoice_id IS NOT NULL)) AND ((source <> 'purchase_order'::text) OR ((purchase_order_id IS NOT NULL) AND (customer_id IS NULL))) AND ((source <> 'job_report'::text) OR (work_order_id IS NOT NULL)))),
    CONSTRAINT documents_byte_size_sane CHECK (((byte_size IS NULL) OR (byte_size >= 0))),
    CONSTRAINT documents_expiry_complete CHECK (((expired_at IS NULL) = (expired_by IS NULL))),
    CONSTRAINT documents_failure_explained CHECK (((status = 'failed'::text) = (failure_code IS NOT NULL))),
    CONSTRAINT documents_page_count_sane CHECK (((page_count IS NULL) OR (page_count > 0))),
    CONSTRAINT documents_public_code_format CHECK ((public_code ~ '^[A-Za-z0-9_-]{22}$'::text)),
    CONSTRAINT documents_qr_placement_uploaded CHECK (((qr_placement IS NULL) OR (source = 'uploaded'::text))),
    CONSTRAINT documents_ready_complete CHECK (((status = 'ready'::text) = ((file_id IS NOT NULL) AND (byte_size IS NOT NULL) AND (rendered_at IS NOT NULL)))),
    CONSTRAINT documents_reference_length CHECK (((reference IS NULL) OR ((char_length(reference) >= 1) AND (char_length(reference) <= 100)))),
    CONSTRAINT documents_source_known CHECK ((source = ANY (ARRAY['generated'::text, 'uploaded'::text, 'quote'::text, 'invoice'::text, 'purchase_order'::text, 'job_report'::text]))),
    CONSTRAINT documents_source_shape CHECK (
CASE source
    WHEN 'generated'::text THEN ((template_id IS NOT NULL) AND (template_revision IS NOT NULL) AND (submission_id IS NOT NULL) AND (form_id IS NOT NULL) AND (reference IS NULL) AND (customer_id IS NULL))
    WHEN 'uploaded'::text THEN ((template_id IS NULL) AND (template_revision IS NULL) AND (submission_id IS NULL) AND (form_id IS NULL) AND (reference IS NOT NULL) AND (status = 'ready'::text))
    ELSE ((template_id IS NULL) AND (template_revision IS NULL) AND (submission_id IS NULL) AND (form_id IS NULL) AND (reference IS NOT NULL))
END),
    CONSTRAINT documents_status_known CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT documents_template_revision_positive CHECK ((template_revision > 0)),
    CONSTRAINT documents_title_length CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200)))
);

CREATE TABLE form_template_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_key text NOT NULL,
    "position" integer NOT NULL,
    name text NOT NULL,
    design jsonb NOT NULL,
    design_schema_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT form_template_documents_design_is_object CHECK ((jsonb_typeof(design) = 'object'::text)),
    CONSTRAINT form_template_documents_name_length CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 120))),
    CONSTRAINT form_template_documents_position_positive CHECK (("position" >= 0))
);

CREATE TABLE form_template_files (
    id uuid NOT NULL,
    template_key text NOT NULL,
    bucket text NOT NULL,
    storage_key text NOT NULL,
    content_type text NOT NULL,
    byte_size bigint NOT NULL,
    etag text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT form_template_files_image CHECK ((content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text]))),
    CONSTRAINT form_template_files_size_sane CHECK ((byte_size >= 0))
);

CREATE TABLE form_templates (
    key text NOT NULL,
    title jsonb NOT NULL,
    description jsonb NOT NULL,
    category text NOT NULL,
    definition jsonb NOT NULL,
    definition_schema_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'builtin'::text NOT NULL,
    retired_at timestamp with time zone,
    retired_by uuid,
    source_tenant_id uuid,
    source_form_id uuid,
    source_version_number integer,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT form_templates_category_known CHECK ((category = ANY (ARRAY['maintenance'::text, 'safety'::text, 'completion'::text]))),
    CONSTRAINT form_templates_definition_is_object CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT form_templates_key_format CHECK ((key ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT form_templates_origin_complete CHECK (((source_tenant_id IS NULL) = (source_form_id IS NULL))),
    CONSTRAINT form_templates_origin_staff_only CHECK (((source = 'staff'::text) OR ((source_tenant_id IS NULL) AND (source_form_id IS NULL)))),
    CONSTRAINT form_templates_retire_staff_only CHECK (((source = 'staff'::text) OR (retired_at IS NULL))),
    CONSTRAINT form_templates_retirement_complete CHECK (((retired_at IS NULL) = (retired_by IS NULL))),
    CONSTRAINT form_templates_schema_version_matches CHECK (((definition ->> 'schemaVersion'::text) = (definition_schema_version)::text)),
    CONSTRAINT form_templates_source_known CHECK ((source = ANY (ARRAY['builtin'::text, 'staff'::text]))),
    CONSTRAINT form_templates_source_version_positive CHECK (((source_version_number IS NULL) OR (source_version_number >= 1)))
);

CREATE TABLE form_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    version_number integer,
    definition jsonb NOT NULL,
    definition_schema_version integer NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    revision integer DEFAULT 1 NOT NULL,
    change_note text,
    changes jsonb,
    reportable_fields jsonb,
    actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT form_versions_actions_shape CHECK (((jsonb_typeof(actions) = 'array'::text) AND (jsonb_array_length(actions) <= 10))),
    CONSTRAINT form_versions_change_note_length CHECK (((change_note IS NULL) OR (char_length(change_note) <= 2000))),
    CONSTRAINT form_versions_changes_is_object CHECK (((changes IS NULL) OR (jsonb_typeof(changes) = 'object'::text))),
    CONSTRAINT form_versions_definition_is_object CHECK ((jsonb_typeof(definition) = 'object'::text)),
    CONSTRAINT form_versions_history_only_when_published CHECK (((status = 'published'::text) OR ((change_note IS NULL) AND (changes IS NULL)))),
    CONSTRAINT form_versions_number_positive CHECK (((version_number IS NULL) OR (version_number >= 1))),
    CONSTRAINT form_versions_publication_complete CHECK (((status = 'published'::text) = ((version_number IS NOT NULL) AND (published_at IS NOT NULL) AND (published_by IS NOT NULL)))),
    CONSTRAINT form_versions_reportable_fields_shape CHECK (((reportable_fields IS NULL) OR (jsonb_typeof(reportable_fields) = 'array'::text))),
    CONSTRAINT form_versions_revision_positive CHECK ((revision >= 1)),
    CONSTRAINT form_versions_schema_version_matches CHECK (((definition ->> 'schemaVersion'::text) = (definition_schema_version)::text)),
    CONSTRAINT form_versions_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);

CREATE TABLE forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    title text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    fill_roles text[] DEFAULT ARRAY['owner'::text, 'admin'::text, 'dispatcher'::text, 'engineer'::text, 'viewer'::text] NOT NULL,
    signature_required boolean DEFAULT false NOT NULL,
    cloned_from_form_id uuid,
    source_template_key text,
    CONSTRAINT forms_fill_roles_known CHECK ((fill_roles <@ ARRAY['owner'::text, 'admin'::text, 'hr_manager'::text, 'inventory_manager'::text, 'accountant'::text, 'dispatcher'::text, 'engineer'::text, 'viewer'::text])),
    CONSTRAINT forms_fill_roles_not_empty CHECK ((cardinality(fill_roles) > 0)),
    CONSTRAINT forms_single_source CHECK (((cloned_from_form_id IS NULL) OR (source_template_key IS NULL))),
    CONSTRAINT forms_title_not_blank CHECK ((btrim(title) <> ''::text))
);

CREATE TABLE job_type_forms (
    tenant_id uuid NOT NULL,
    job_type_id uuid NOT NULL,
    form_id uuid NOT NULL,
    required boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE submission_action_results (
    tenant_id uuid NOT NULL,
    submission_id uuid NOT NULL,
    form_action_id text NOT NULL,
    kind text NOT NULL,
    outcome text NOT NULL,
    claim_id uuid,
    link_id uuid,
    reason_code text,
    reason text,
    attempts integer DEFAULT 1 NOT NULL,
    attempted_by uuid NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT submission_action_results_action_shape CHECK ((form_action_id ~ '^[a-z][a-z0-9_]{0,39}$'::text)),
    CONSTRAINT submission_action_results_attempts_positive CHECK ((attempts > 0)),
    CONSTRAINT submission_action_results_kind_known CHECK ((kind = ANY (ARRAY['expense_claim'::text, 'open_form'::text]))),
    CONSTRAINT submission_action_results_outcome_known CHECK ((outcome = ANY (ARRAY['made'::text, 'skipped'::text, 'failed'::text]))),
    CONSTRAINT submission_action_results_pairing CHECK ((((outcome = 'made'::text) = ((claim_id IS NOT NULL) OR (link_id IS NOT NULL))) AND ((claim_id IS NULL) OR (kind = 'expense_claim'::text)) AND ((link_id IS NULL) OR (kind = 'open_form'::text)) AND ((outcome = 'failed'::text) = (reason_code IS NOT NULL)) AND ((reason_code IS NULL) = (reason IS NULL)) AND ((reason IS NULL) OR (char_length(reason) <= 1000))))
);

CREATE TABLE submission_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    submission_id uuid NOT NULL,
    sequence integer NOT NULL,
    kind text NOT NULL,
    answers jsonb,
    actor_id uuid NOT NULL,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    location jsonb,
    CONSTRAINT submission_events_answers_when_submitted CHECK (((kind = 'reopened'::text) = (answers IS NULL))),
    CONSTRAINT submission_events_kind_known CHECK ((kind = ANY (ARRAY['submitted'::text, 'reopened'::text, 'amended'::text]))),
    CONSTRAINT submission_events_reason_when_changed CHECK (((kind = 'submitted'::text) OR ((reason IS NOT NULL) AND (btrim(reason) <> ''::text))))
);

CREATE TABLE submission_file_uses (
    tenant_id uuid NOT NULL,
    file_id uuid NOT NULL,
    submission_id uuid NOT NULL,
    source text NOT NULL,
    CONSTRAINT submission_file_uses_source_known CHECK ((source = ANY (ARRAY['answers'::text, 'history'::text])))
);

CREATE TABLE submission_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    from_submission_id uuid NOT NULL,
    to_submission_id uuid NOT NULL,
    form_action_id text NOT NULL,
    required boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT submission_links_action_shape CHECK ((form_action_id ~ '^[a-z][a-z0-9_]{0,39}$'::text)),
    CONSTRAINT submission_links_not_self CHECK ((from_submission_id <> to_submission_id))
);

CREATE TABLE submission_values (
    tenant_id uuid NOT NULL,
    submission_id uuid NOT NULL,
    form_id uuid NOT NULL,
    form_version_id uuid NOT NULL,
    field_id text NOT NULL,
    ordinal integer DEFAULT 0 NOT NULL,
    value_type text NOT NULL,
    value_text text,
    value_number numeric,
    value_date date,
    value_time time without time zone,
    value_timestamp timestamp with time zone,
    value_boolean boolean,
    submitted_at timestamp with time zone NOT NULL,
    entry_id text,
    entry_index integer DEFAULT 0 NOT NULL,
    CONSTRAINT submission_values_entry_shape CHECK (((entry_index >= 0) AND ((entry_id IS NOT NULL) OR (entry_index = 0)) AND ((entry_id IS NULL) OR (entry_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'::text)))),
    CONSTRAINT submission_values_one_value CHECK (((num_nonnulls(value_text, value_number, value_date, value_time, value_timestamp, value_boolean) = 1) AND
CASE value_type
    WHEN 'text'::text THEN (value_text IS NOT NULL)
    WHEN 'number'::text THEN (value_number IS NOT NULL)
    WHEN 'date'::text THEN (value_date IS NOT NULL)
    WHEN 'time'::text THEN (value_time IS NOT NULL)
    WHEN 'datetime'::text THEN (value_timestamp IS NOT NULL)
    WHEN 'boolean'::text THEN (value_boolean IS NOT NULL)
    ELSE NULL::boolean
END)),
    CONSTRAINT submission_values_type_known CHECK ((value_type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'time'::text, 'datetime'::text, 'boolean'::text])))
)
PARTITION BY RANGE (submitted_at);

CREATE TABLE submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    form_version_id uuid NOT NULL,
    answers jsonb NOT NULL,
    submitted_by uuid NOT NULL,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    form_id uuid NOT NULL,
    status text DEFAULT 'submitted'::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    last_actor uuid NOT NULL,
    last_reason text,
    amended_at timestamp with time zone,
    search tsvector GENERATED ALWAYS AS (jsonb_to_tsvector('simple'::regconfig, answers, '["string"]'::jsonb)) STORED,
    work_order_id uuid,
    submit_location jsonb,
    asset_id uuid,
    carried_over jsonb,
    submitted_after_close boolean DEFAULT false NOT NULL,
    title text,
    CONSTRAINT submissions_answers_is_object CHECK ((jsonb_typeof(answers) = 'object'::text)),
    CONSTRAINT submissions_carried_over_shape CHECK (((carried_over IS NULL) OR ((asset_id IS NOT NULL) AND (jsonb_typeof(carried_over) = 'object'::text) AND (jsonb_typeof((carried_over -> 'fromSubmissionId'::text)) = 'string'::text) AND (jsonb_typeof((carried_over -> 'fields'::text)) = 'array'::text)))),
    CONSTRAINT submissions_reason_length CHECK (((last_reason IS NULL) OR (char_length(last_reason) <= 2000))),
    CONSTRAINT submissions_revision_positive CHECK ((revision >= 1)),
    CONSTRAINT submissions_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'reopened'::text]))),
    CONSTRAINT submissions_submit_location_shape CHECK (((submit_location IS NULL) OR ((jsonb_typeof(submit_location) = 'object'::text) AND ((((submit_location ->> 'status'::text) = 'captured'::text) AND (submit_location ?& ARRAY['latitude'::text, 'longitude'::text, 'capturedAt'::text])) OR ((submit_location ->> 'status'::text) = ANY (ARRAY['denied'::text, 'unavailable'::text])))))),
    CONSTRAINT submissions_submitted_at_matches_status CHECK (((status = 'draft'::text) = (submitted_at IS NULL))),
    CONSTRAINT submissions_title_length CHECK (((title IS NULL) OR ((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 200))))
);

CREATE TABLE website_keys (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    key_hash text NOT NULL,
    key_hint text NOT NULL,
    label text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    last_used_at timestamp with time zone,
    lookups bigint DEFAULT 0 NOT NULL,
    found bigint DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT website_keys_counts_sane CHECK (((lookups >= 0) AND (found >= 0) AND (found <= lookups))),
    CONSTRAINT website_keys_hash_format CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT website_keys_hint_format CHECK ((key_hint ~ '^[A-Za-z0-9_-]{4}$'::text)),
    CONSTRAINT website_keys_label_length CHECK (((label IS NULL) OR ((char_length(label) >= 1) AND (char_length(label) <= 80)))),
    CONSTRAINT website_keys_revocation_complete CHECK (((revoked_at IS NULL) = (revoked_by IS NULL)))
);

CREATE TABLE work_order_forms (
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    form_id uuid NOT NULL,
    required boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    added_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY document_field_values
    ADD CONSTRAINT document_field_values_pkey PRIMARY KEY (tenant_id, document_id, field_key);

ALTER TABLE ONLY document_templates
    ADD CONSTRAINT document_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY document_templates
    ADD CONSTRAINT document_templates_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_public_code_unique UNIQUE (public_code);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY form_template_documents
    ADD CONSTRAINT form_template_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY form_template_documents
    ADD CONSTRAINT form_template_documents_position_unique UNIQUE (template_key, "position");

ALTER TABLE ONLY form_template_files
    ADD CONSTRAINT form_template_files_key_unique UNIQUE (bucket, storage_key);

ALTER TABLE ONLY form_template_files
    ADD CONSTRAINT form_template_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY form_templates
    ADD CONSTRAINT form_templates_pkey PRIMARY KEY (key);

ALTER TABLE ONLY form_versions
    ADD CONSTRAINT form_versions_number_unique UNIQUE (form_id, version_number);

ALTER TABLE ONLY form_versions
    ADD CONSTRAINT form_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY form_versions
    ADD CONSTRAINT form_versions_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY forms
    ADD CONSTRAINT forms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY forms
    ADD CONSTRAINT forms_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY job_type_forms
    ADD CONSTRAINT job_type_forms_pk PRIMARY KEY (tenant_id, job_type_id, form_id);

ALTER TABLE ONLY submission_action_results
    ADD CONSTRAINT submission_action_results_pkey PRIMARY KEY (tenant_id, submission_id, form_action_id);

ALTER TABLE ONLY submission_events
    ADD CONSTRAINT submission_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY submission_events
    ADD CONSTRAINT submission_events_sequence_unique UNIQUE (submission_id, sequence);

ALTER TABLE ONLY submission_file_uses
    ADD CONSTRAINT submission_file_uses_pkey PRIMARY KEY (tenant_id, file_id, submission_id, source);

ALTER TABLE ONLY submission_links
    ADD CONSTRAINT submission_links_action_unique UNIQUE (tenant_id, from_submission_id, form_action_id);

ALTER TABLE ONLY submission_links
    ADD CONSTRAINT submission_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY submission_links
    ADD CONSTRAINT submission_links_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY submission_links
    ADD CONSTRAINT submission_links_to_unique UNIQUE (tenant_id, to_submission_id);

ALTER TABLE submission_values
    ADD CONSTRAINT submission_values_pk PRIMARY KEY (tenant_id, submission_id, field_id, entry_index, ordinal, submitted_at);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY website_keys
    ADD CONSTRAINT website_keys_hash_unique UNIQUE (key_hash);

ALTER TABLE ONLY website_keys
    ADD CONSTRAINT website_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY work_order_forms
    ADD CONSTRAINT work_order_forms_pk PRIMARY KEY (tenant_id, work_order_id, form_id);

ALTER TABLE form_versions
    ADD CONSTRAINT form_versions_reportable_fields_at_publish CHECK (((status = 'draft'::text) OR (reportable_fields IS NOT NULL))) NOT VALID;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX document_field_values_search ON document_field_values USING btree (tenant_id, field_key, value_normalized);

CREATE INDEX document_templates_form ON document_templates USING btree (tenant_id, form_id);

CREATE INDEX documents_customer ON documents USING btree (tenant_id, customer_id) WHERE (customer_id IS NOT NULL);

CREATE INDEX documents_invoice ON documents USING btree (tenant_id, invoice_id, created_at DESC) WHERE (invoice_id IS NOT NULL);

CREATE INDEX documents_purchase_order ON documents USING btree (tenant_id, purchase_order_id, created_at DESC) WHERE (purchase_order_id IS NOT NULL);

CREATE INDEX documents_quote ON documents USING btree (tenant_id, quote_id, created_at DESC) WHERE (quote_id IS NOT NULL);

CREATE INDEX documents_recent ON documents USING btree (tenant_id, created_at DESC, id DESC);

CREATE INDEX documents_submission ON documents USING btree (tenant_id, submission_id);

CREATE INDEX documents_template ON documents USING btree (tenant_id, template_id);

CREATE INDEX documents_work_order ON documents USING btree (tenant_id, work_order_id, created_at DESC) WHERE (work_order_id IS NOT NULL);

CREATE INDEX form_template_files_template_idx ON form_template_files USING btree (template_key);

CREATE UNIQUE INDEX form_versions_one_draft_per_form ON form_versions USING btree (form_id) WHERE (status = 'draft'::text);

CREATE INDEX form_versions_published_idx ON form_versions USING btree (tenant_id, form_id, version_number DESC) WHERE (status = 'published'::text);

CREATE INDEX forms_tenant_idx ON forms USING btree (tenant_id, created_at DESC);

CREATE INDEX job_type_forms_form_idx ON job_type_forms USING btree (tenant_id, form_id);

CREATE INDEX submission_events_submission_idx ON submission_events USING btree (tenant_id, submission_id, sequence);

CREATE INDEX submission_file_uses_submission ON submission_file_uses USING btree (tenant_id, submission_id);

CREATE INDEX submission_links_by_to ON submission_links USING btree (tenant_id, to_submission_id);

CREATE INDEX submission_values_boolean_idx ON submission_values USING btree (tenant_id, form_id, field_id, value_boolean) WHERE (value_boolean IS NOT NULL);

CREATE INDEX submission_values_date_idx ON submission_values USING btree (tenant_id, form_id, field_id, value_date) WHERE (value_date IS NOT NULL);

CREATE INDEX submission_values_number_idx ON submission_values USING btree (tenant_id, form_id, field_id, value_number) WHERE (value_number IS NOT NULL);

CREATE INDEX submission_values_text_idx ON submission_values USING btree (tenant_id, form_id, field_id, value_text) WHERE (value_text IS NOT NULL);

CREATE INDEX submission_values_time_idx ON submission_values USING btree (tenant_id, form_id, field_id, value_time) WHERE (value_time IS NOT NULL);

CREATE INDEX submission_values_timestamp_idx ON submission_values USING btree (tenant_id, form_id, field_id, value_timestamp) WHERE (value_timestamp IS NOT NULL);

CREATE INDEX submissions_asset_idx ON submissions USING btree (tenant_id, asset_id, form_id) WHERE (asset_id IS NOT NULL);

CREATE INDEX submissions_form_idx ON submissions USING btree (tenant_id, form_id, submitted_at DESC) WHERE (status <> 'draft'::text);

CREATE INDEX submissions_search_idx ON submissions USING gin (search);

CREATE INDEX submissions_submitter_idx ON submissions USING btree (tenant_id, submitted_by, updated_at DESC);

CREATE INDEX submissions_version_idx ON submissions USING btree (tenant_id, form_version_id, submitted_at DESC);

CREATE INDEX submissions_work_order_idx ON submissions USING btree (tenant_id, work_order_id, form_id) WHERE (work_order_id IS NOT NULL);

CREATE INDEX website_keys_tenant ON website_keys USING btree (tenant_id) WHERE (revoked_at IS NULL);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY document_field_values
    ADD CONSTRAINT document_field_values_document_fk FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY document_field_values
    ADD CONSTRAINT document_field_values_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_templates
    ADD CONSTRAINT document_templates_form_fk FOREIGN KEY (tenant_id, form_id) REFERENCES forms(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_templates
    ADD CONSTRAINT document_templates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_file_fk FOREIGN KEY (tenant_id, file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_form_fk FOREIGN KEY (tenant_id, form_id) REFERENCES forms(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_original_file_fk FOREIGN KEY (tenant_id, original_file_id) REFERENCES files(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_submission_fk FOREIGN KEY (tenant_id, submission_id) REFERENCES submissions(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_template_fk FOREIGN KEY (tenant_id, template_id) REFERENCES document_templates(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY form_template_documents
    ADD CONSTRAINT form_template_documents_template_key_fkey FOREIGN KEY (template_key) REFERENCES form_templates(key) ON DELETE CASCADE;

ALTER TABLE ONLY form_template_files
    ADD CONSTRAINT form_template_files_template_key_fkey FOREIGN KEY (template_key) REFERENCES form_templates(key) ON DELETE CASCADE;

ALTER TABLE ONLY form_templates
    ADD CONSTRAINT form_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES platform_users(id);

ALTER TABLE ONLY form_templates
    ADD CONSTRAINT form_templates_retired_by_fkey FOREIGN KEY (retired_by) REFERENCES platform_users(id);

ALTER TABLE ONLY form_templates
    ADD CONSTRAINT form_templates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES platform_users(id);

ALTER TABLE ONLY form_versions
    ADD CONSTRAINT form_versions_form_fk FOREIGN KEY (tenant_id, form_id) REFERENCES forms(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY form_versions
    ADD CONSTRAINT form_versions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY forms
    ADD CONSTRAINT forms_cloned_from_fk FOREIGN KEY (tenant_id, cloned_from_form_id) REFERENCES forms(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY forms
    ADD CONSTRAINT forms_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY job_type_forms
    ADD CONSTRAINT job_type_forms_form_fk FOREIGN KEY (tenant_id, form_id) REFERENCES forms(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY job_type_forms
    ADD CONSTRAINT job_type_forms_job_type_fk FOREIGN KEY (tenant_id, job_type_id) REFERENCES job_types(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY job_type_forms
    ADD CONSTRAINT job_type_forms_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY submission_action_results
    ADD CONSTRAINT submission_action_results_link_fk FOREIGN KEY (tenant_id, link_id) REFERENCES submission_links(tenant_id, id);

ALTER TABLE ONLY submission_action_results
    ADD CONSTRAINT submission_action_results_submission_fk FOREIGN KEY (tenant_id, submission_id) REFERENCES submissions(tenant_id, id);

ALTER TABLE ONLY submission_action_results
    ADD CONSTRAINT submission_action_results_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY submission_events
    ADD CONSTRAINT submission_events_submission_fk FOREIGN KEY (tenant_id, submission_id) REFERENCES submissions(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY submission_events
    ADD CONSTRAINT submission_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY submission_file_uses
    ADD CONSTRAINT submission_file_uses_submission_fk FOREIGN KEY (tenant_id, submission_id) REFERENCES submissions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY submission_file_uses
    ADD CONSTRAINT submission_file_uses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY submission_links
    ADD CONSTRAINT submission_links_from_fk FOREIGN KEY (tenant_id, from_submission_id) REFERENCES submissions(tenant_id, id);

ALTER TABLE ONLY submission_links
    ADD CONSTRAINT submission_links_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY submission_links
    ADD CONSTRAINT submission_links_to_fk FOREIGN KEY (tenant_id, to_submission_id) REFERENCES submissions(tenant_id, id);

ALTER TABLE submission_values
    ADD CONSTRAINT submission_values_submission_fk FOREIGN KEY (tenant_id, submission_id) REFERENCES submissions(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE submission_values
    ADD CONSTRAINT submission_values_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_form_fk FOREIGN KEY (tenant_id, form_id) REFERENCES forms(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_form_version_fk FOREIGN KEY (tenant_id, form_version_id) REFERENCES form_versions(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY website_keys
    ADD CONSTRAINT website_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES platform_users(id);

ALTER TABLE ONLY website_keys
    ADD CONSTRAINT website_keys_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES platform_users(id);

ALTER TABLE ONLY website_keys
    ADD CONSTRAINT website_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_forms
    ADD CONSTRAINT work_order_forms_form_fk FOREIGN KEY (tenant_id, form_id) REFERENCES forms(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_forms
    ADD CONSTRAINT work_order_forms_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_forms
    ADD CONSTRAINT work_order_forms_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER document_templates_set_updated_at BEFORE UPDATE ON document_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER documents_set_updated_at BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER form_templates_set_updated_at BEFORE UPDATE ON form_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER form_versions_immutable_when_published BEFORE DELETE OR UPDATE ON form_versions FOR EACH ROW EXECUTE FUNCTION reject_published_form_version_change();

CREATE TRIGGER form_versions_no_truncate BEFORE TRUNCATE ON form_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_form_versions_truncate();

CREATE TRIGGER form_versions_set_updated_at BEFORE UPDATE ON form_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER form_versions_touch_sync AFTER INSERT OR UPDATE ON form_versions FOR EACH ROW EXECUTE FUNCTION touch_sync('form', 'form_id');

CREATE TRIGGER forms_set_updated_at BEFORE UPDATE ON forms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER forms_touch_sync AFTER INSERT OR UPDATE ON forms FOR EACH ROW EXECUTE FUNCTION touch_sync('form', 'id');

CREATE TRIGGER submission_action_results_guard BEFORE DELETE OR UPDATE ON submission_action_results FOR EACH ROW EXECUTE FUNCTION submission_action_results_guard();

CREATE TRIGGER submission_events_no_delete BEFORE DELETE ON submission_events FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_events_mutation();

CREATE TRIGGER submission_events_no_truncate BEFORE TRUNCATE ON submission_events FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_events_mutation();

CREATE TRIGGER submission_events_no_update BEFORE UPDATE ON submission_events FOR EACH STATEMENT EXECUTE FUNCTION reject_submission_events_mutation();

CREATE TRIGGER submission_events_record_file_uses AFTER INSERT ON submission_events FOR EACH ROW EXECUTE FUNCTION record_submission_file_uses();

CREATE TRIGGER submission_links_guard BEFORE DELETE OR UPDATE ON submission_links FOR EACH ROW EXECUTE FUNCTION submission_links_guard();

CREATE TRIGGER submissions_after_close_guard BEFORE INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION guard_submitted_after_close();

CREATE TRIGGER submissions_after_close_history AFTER UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION record_submitted_after_close();

CREATE TRIGGER submissions_bound_to_published_version BEFORE INSERT OR UPDATE OF form_version_id ON submissions FOR EACH ROW EXECUTE FUNCTION enforce_submission_binding();

CREATE TRIGGER submissions_lifecycle BEFORE INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION enforce_submission_lifecycle();

CREATE TRIGGER submissions_location_guard BEFORE INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION guard_submit_location();

CREATE TRIGGER submissions_record_change AFTER INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION record_submission_change();

CREATE TRIGGER submissions_record_file_uses AFTER INSERT OR UPDATE OF answers ON submissions FOR EACH ROW EXECUTE FUNCTION record_submission_file_uses();

CREATE TRIGGER submissions_set_updated_at BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER submissions_touch_sync AFTER INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER submissions_work_order_guard BEFORE INSERT OR UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION guard_submission_work_order();

CREATE TRIGGER work_order_forms_touch_sync AFTER INSERT OR DELETE OR UPDATE ON work_order_forms FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE document_field_values ENABLE ROW LEVEL SECURITY;

ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE form_template_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE form_template_files ENABLE ROW LEVEL SECURITY;

ALTER TABLE form_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE form_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE forms ENABLE ROW LEVEL SECURITY;

ALTER TABLE job_type_forms ENABLE ROW LEVEL SECURITY;

ALTER TABLE submission_action_results ENABLE ROW LEVEL SECURITY;

ALTER TABLE submission_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE submission_file_uses ENABLE ROW LEVEL SECURITY;

ALTER TABLE submission_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE submission_values ENABLE ROW LEVEL SECURITY;

ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE website_keys ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_forms ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_field_values_isolation ON document_field_values TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY document_templates_isolation ON document_templates TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY documents_isolation ON documents TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY form_templates_readable ON form_templates FOR SELECT TO integr8_app USING (true);

CREATE POLICY form_versions_isolation ON form_versions TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY forms_isolation ON forms TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY job_type_forms_isolation ON job_type_forms TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY submission_action_results_isolation ON submission_action_results TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY submission_events_isolation ON submission_events FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY submission_file_uses_isolation ON submission_file_uses TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY submission_links_isolation ON submission_links TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY submission_values_isolation ON submission_values FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY submissions_isolation ON submissions TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_forms_isolation ON work_order_forms TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION enforce_submission_lifecycle() IS 'Refuses a submission change the lifecycle does not allow: editing submitted answers, skipping a state, moving it to another form or person, or reopening and amending without a reason.';

COMMENT ON FUNCTION guard_submit_location() IS 'Refuses a submit location written other than by submitting: set on a draft, or changed after the fact.';

COMMENT ON FUNCTION record_submission_change() IS 'Writes submission_events for every submit, reopen and amendment, and refreshes submission_values when a submission becomes submitted. Security definer: the runtime role cannot write either table directly.';

COMMENT ON FUNCTION record_submission_file_uses() IS 'Keeps submission_file_uses in step with submissions.answers and submission_events (0068). Security definer: the runtime role cannot write the index.';

COMMENT ON FUNCTION reject_published_form_version_change() IS 'Refuses UPDATE or DELETE of a published form version, for every role. The publish itself is the last permitted update: it is the draft being changed.';

COMMENT ON TABLE document_field_values IS 'The fields a document was made with (D6): typed at export or taken from the submission. Searchable; some open the website lookup.';

COMMENT ON TABLE document_templates IS 'A form''s PDF layouts (documents ADR-0001 D1-D3). Designed by Integr8 staff; archived, never deleted.';

COMMENT ON TABLE documents IS 'PDFs made from submissions (documents ADR-0001 D4-D8). The file is in the company''s bucket and the media ledger; public_code is the QR link''s key.';

COMMENT ON COLUMN documents.source IS 'generated: made from a submission with a template; uploaded: a PDF a person uploaded (0067); quote, invoice, purchase_order, job_report: printed by the server from that record (0074).';

COMMENT ON COLUMN documents.reference IS 'An uploaded document''s reference number (0067), or a business PDF''s record number such as INV-000123 (0074).';

COMMENT ON COLUMN documents.customer_id IS 'The customer an uploaded document is for, if any: the website lookup''s second match (0067).';

COMMENT ON COLUMN documents.shareable IS 'Whether the QR code''s link and the company website may show the document. New documents start off; those before 0067 stay on.';

COMMENT ON COLUMN documents.quote_id IS 'The quote a business PDF was printed from (0074).';

COMMENT ON COLUMN documents.invoice_id IS 'The invoice a business PDF was printed from (0074).';

COMMENT ON COLUMN documents.purchase_order_id IS 'The purchase order a business PDF was printed from (0074).';

COMMENT ON COLUMN documents.work_order_id IS 'The job a job report was printed from (0074).';

COMMENT ON COLUMN documents.qr_spot IS 'The document has a place for its share QR code: printed only once shared (0075).';

COMMENT ON COLUMN documents.qr_printed IS 'The file served now carries the share QR code (0075).';

COMMENT ON COLUMN documents.printed_design IS 'The template design the document was printed from, for an identical re-print (0075).';

COMMENT ON COLUMN documents.qr_placement IS 'Uploaded PDF: where its share QR code is stamped, { page, x, y, size } as page fractions (0075).';

COMMENT ON COLUMN documents.original_file_id IS 'Uploaded PDF: the file as uploaded, when the served file is a stamped copy (0075).';

COMMENT ON TABLE form_template_documents IS 'PDF templates carried by a staff-made library template, copied to every company that starts from it. Platform data.';

COMMENT ON TABLE form_template_files IS 'Pictures used by library PDF templates, kept in the platform''s own bucket. Platform data.';

COMMENT ON TABLE form_templates IS 'The global form template library. Platform content: read by every company, written only by the schema owner.';

COMMENT ON COLUMN form_templates.source IS '`builtin`: shipped in @integr8/form-engine and kept equal to it by `db templates`. `staff`: saved from a company''s form by Integr8 staff; managed from the dashboard and never touched by `db templates`.';

COMMENT ON COLUMN form_templates.retired_at IS 'A retired staff-made template is no longer offered to companies. Forms already made from it are copies and are unaffected.';

COMMENT ON COLUMN form_templates.source_tenant_id IS 'The company a staff-made template was saved from. No foreign key: the library outlives a purged company.';

COMMENT ON TABLE form_versions IS 'One copy of a form definition. A draft may change; once published it is immutable, enforced by trigger for every role.';

COMMENT ON COLUMN form_versions.version_number IS 'Assigned when published, 1 upwards per form. Null while a draft.';

COMMENT ON COLUMN form_versions.revision IS 'Incremented by every save of a draft. A save naming an older revision is refused, so a second builder tab cannot overwrite the first.';

COMMENT ON COLUMN form_versions.changes IS 'The diff against the previous published version, computed by @integr8/form-engine at publish. What version history shows.';

COMMENT ON COLUMN form_versions.reportable_fields IS 'Set at publish from @integr8/form-engine reportableFields: [{field, type, multiple}]. Which answers of this version are copied into submission_values.';

COMMENT ON COLUMN form_versions.actions IS 'What a submit of this version does (P40): expense claims and follow-up forms. Checked by @integr8/form-package; the server alone reads it.';

COMMENT ON TABLE forms IS 'A form a company uses. Holds no fields: those live in form_versions, one immutable copy per publish.';

COMMENT ON COLUMN forms.fill_roles IS 'Roles that may fill this form. Enforced where forms are filled (P08, P13); stored and validated here.';

COMMENT ON COLUMN forms.signature_required IS 'Whether a signature is mandatory before a job with a submission of this form can close. Read from the form at completion (0060), not from the version filled.';

COMMENT ON TABLE submission_action_results IS 'The last outcome of each action of a submitted form (P40). A failed one is retried from the office ("Make it now").';

COMMENT ON TABLE submission_events IS 'Append-only history of a submission: each submit, reopen and amendment, with the answers submitted. Written only by trigger; updates and deletes are refused for every role.';

COMMENT ON COLUMN submission_events.location IS 'For submitted and amended events: submissions.submit_location as it was written by that submit.';

COMMENT ON TABLE submission_file_uses IS 'Which files each submission names, in its answers now or in its history (0068). Maintained by trigger; read-only to the runtime role.';

COMMENT ON TABLE submission_links IS 'A follow-up submission a form action opened (P40). Written once by the server; never changed.';

COMMENT ON TABLE submission_values IS 'The reportable answers of submitted submissions, one typed row per answer (per option for a multi-select). Maintained by trigger from submissions.answers; read-only to the runtime role.';

COMMENT ON COLUMN submission_values.entry_id IS 'For a field of a repeatable section: the id of the entry the answer is in. Null for every other answer.';

COMMENT ON COLUMN submission_values.entry_index IS 'For a field of a repeatable section: the entry''s position when submitted, from 0. 0 for every other answer.';

COMMENT ON TABLE submissions IS 'Answers to one published form version. Bound at insert and never rebound: the version is what the answers mean.';

COMMENT ON COLUMN submissions.submitted_by IS 'The person filling the form in: who started the draft, and who submitted it.';

COMMENT ON COLUMN submissions.submitted_at IS 'When it was first submitted. Null while a draft; kept through reopening and amendment.';

COMMENT ON COLUMN submissions.revision IS 'Incremented by every change. A save or submit naming an older revision is refused, so two devices cannot overwrite each other.';

COMMENT ON COLUMN submissions.last_actor IS 'Who made the change being written. Set on every insert and update; submission_events records it.';

COMMENT ON COLUMN submissions.last_reason IS 'Why a reopening or amendment was made. Required for both, by trigger.';

COMMENT ON COLUMN submissions.search IS 'Generated: every string answer, for full-text search across submissions.';

COMMENT ON COLUMN submissions.work_order_id IS 'The job this form was filled for, if any. Set when the draft is started and never changed; the form must be one of the job''s.';

COMMENT ON COLUMN submissions.submit_location IS 'Where the device was when this was last submitted: captured with accuracy and time, or why not. Null when the device did not record one (web, desktop).';

COMMENT ON COLUMN submissions.asset_id IS 'The asset this form was filled for, if any; one of the job''s assets.';

COMMENT ON COLUMN submissions.carried_over IS '{ fromSubmissionId, fields } when answers were carried over from the asset''s last visit.';

COMMENT ON COLUMN submissions.submitted_after_close IS 'Submitted from a phone after its job was completed, reviewed or cancelled, from a draft started before (0061). Written only by that submit.';

COMMENT ON COLUMN submissions.title IS 'The name the person gave it when submitting (0076). Null shows the form''s title.';

COMMENT ON TABLE website_keys IS 'A company website''s key for the document lookup (documents ADR-0001 D10, D11). Platform-level: issued and revoked by staff managers; no runtime grant.';

COMMENT ON TABLE work_order_forms IS 'The forms on one job. Copied from its type when it is created, so changing a type later does not change a job already out.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE document_field_values TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE document_field_values TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE document_templates TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE document_templates TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE documents TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE documents TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE form_template_documents TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE form_template_files TO integr8_platform;

GRANT SELECT ON TABLE form_templates TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE form_templates TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE form_versions TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE form_versions TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE forms TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE forms TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE job_type_forms TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE job_type_forms TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE submission_action_results TO integr8_platform;
GRANT SELECT,INSERT,UPDATE ON TABLE submission_action_results TO integr8_app;

GRANT SELECT ON TABLE submission_events TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE submission_events TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE submission_file_uses TO integr8_platform;
GRANT SELECT ON TABLE submission_file_uses TO integr8_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE submission_links TO integr8_platform;
GRANT SELECT,INSERT ON TABLE submission_links TO integr8_app;

GRANT SELECT ON TABLE submission_values TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE submission_values TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE submissions TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE submissions TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE website_keys TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_forms TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_forms TO integr8_platform;

-- ---------------------------------------------------------------------------
-- Year partitions for the tables above (see 0001)
-- ---------------------------------------------------------------------------

SELECT ensure_year_partitions();
