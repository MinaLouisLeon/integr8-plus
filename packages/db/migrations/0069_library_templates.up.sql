-- 0069 — staff-made library templates, and the PDF templates they carry.
--
-- Until now the template library held only what @integr8/form-engine ships,
-- loaded by `db templates`. Integr8 staff can now save a company's form into
-- it too (form builder decisions 1B and 10b, 1.3.0):
--
--   * `form_templates.source` says which kind a template is. A `builtin` one is
--     code-managed: `db templates` keeps it equal to the code, and the API
--     refuses to change it. A `staff` one was saved from a company's form and is
--     renamed, replaced and retired from the dashboard; `db templates` never
--     touches it.
--   * Retired rather than deleted, as before: a retired template leaves the
--     picker, and every form already made from it is a copy that stays as it is.
--   * Where a staff-made template came from: the company, the form and the
--     version, so "replace with the newer version" knows what to read. No
--     foreign key: the library outlives the company it came from, which may be
--     purged — the template then simply cannot be refreshed any more.
--
-- Two platform tables hold the PDF templates a staff-made library form
-- carries, and the pictures those use. The pictures' bytes live in the
-- platform's own `platform-library` bucket, not in any company's, so a
-- company's purge cannot take them and no company's storage pays for them. A
-- company that starts from the template gets its own copy of every picture in
-- its own bucket.
--
-- Platform data: the runtime role holds nothing on either new table (it reads
-- the library itself through `form_templates`, select only, as before); the
-- API reaches them as the platform role.

alter table form_templates
  add column source                 text        not null default 'builtin',
  add column retired_at             timestamptz,
  add column retired_by             uuid        references platform_users (id),
  add column source_tenant_id       uuid,
  add column source_form_id         uuid,
  add column source_version_number  integer,
  add column created_by             uuid        references platform_users (id),
  add column updated_by             uuid        references platform_users (id);

alter table form_templates
  add constraint form_templates_source_known check (source in ('builtin', 'staff')),
  -- Only a staff-made template is retired from the dashboard; a built-in one
  -- leaves the library by leaving the code, which never deletes it either.
  add constraint form_templates_retire_staff_only check (source = 'staff' or retired_at is null),
  add constraint form_templates_retirement_complete
    check ((retired_at is null) = (retired_by is null)),
  add constraint form_templates_origin_staff_only
    check (source = 'staff' or (source_tenant_id is null and source_form_id is null)),
  add constraint form_templates_origin_complete
    check ((source_tenant_id is null) = (source_form_id is null)),
  add constraint form_templates_source_version_positive
    check (source_version_number is null or source_version_number >= 1);

comment on column form_templates.source is
  '`builtin`: shipped in @integr8/form-engine and kept equal to it by `db templates`. `staff`: saved from a company''s form by Integr8 staff; managed from the dashboard and never touched by `db templates`.';
comment on column form_templates.retired_at is
  'A retired staff-made template is no longer offered to companies. Forms already made from it are copies and are unaffected.';
comment on column form_templates.source_tenant_id is
  'The company a staff-made template was saved from. No foreign key: the library outlives a purged company.';

-- ---------------------------------------------------------------------------
-- form_template_documents: the PDF templates a library form carries.
-- ---------------------------------------------------------------------------

create table form_template_documents (
  id                     uuid        primary key default gen_random_uuid(),
  template_key           text        not null references form_templates (key) on delete cascade,
  position               integer     not null,
  name                   text        not null,
  -- A design as @integr8/document-render reads it. Its pictures name rows of
  -- form_template_files below by id.
  design                 jsonb       not null,
  design_schema_version  integer     not null,
  created_at             timestamptz not null default now(),

  constraint form_template_documents_position_unique unique (template_key, position),
  constraint form_template_documents_position_positive check (position >= 0),
  constraint form_template_documents_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint form_template_documents_design_is_object check (jsonb_typeof(design) = 'object')
);

comment on table form_template_documents is
  'PDF templates carried by a staff-made library template, copied to every company that starts from it. Platform data.';

alter table form_template_documents enable row level security;

-- ---------------------------------------------------------------------------
-- form_template_files: the pictures those designs use.
-- ---------------------------------------------------------------------------

create table form_template_files (
  -- The id the designs name: a design is copied as it is, and only these ids
  -- are swapped for new ones when it reaches a company.
  id            uuid        primary key,
  template_key  text        not null references form_templates (key) on delete cascade,
  bucket        text        not null,
  storage_key   text        not null,
  content_type  text        not null,
  byte_size     bigint      not null,
  etag          text,
  created_at    timestamptz not null default now(),

  constraint form_template_files_key_unique unique (bucket, storage_key),
  constraint form_template_files_size_sane check (byte_size >= 0),
  constraint form_template_files_image check (content_type in ('image/png', 'image/jpeg', 'image/webp'))
);

comment on table form_template_files is
  'Pictures used by library PDF templates, kept in the platform''s own bucket. Platform data.';

create index form_template_files_template_idx on form_template_files (template_key);

alter table form_template_files enable row level security;
