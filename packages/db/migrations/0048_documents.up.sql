-- PDF documents made from submissions (docs/documents/ADR-0001).
--
--   document_templates     a form's PDF layouts, designed by Integr8 staff
--   documents              each PDF made from a submission, its public code
--                          and whether its link still opens
--   document_field_values  the fields typed or taken at export, searchable
--   website_keys           a company website's key for the document lookup,
--                          issued by the terminal account only (platform-level)
--
-- A document's file lives in the company's bucket and in the media ledger
-- (`files`, category document); the row here says what it is and who may
-- reach it. Templates are archived, never deleted, because documents name the
-- revision they were made from.

insert into feature_flags (key, description, default_enabled)
values
  ('documents',
   'Documents: PDF templates Integr8 designs for a company''s forms, the PDFs its people make from submissions, their QR links and the website lookup. Off until Integr8 switches it on for a company.',
   false);

-- ---------------------------------------------------------------------------
-- Templates
-- ---------------------------------------------------------------------------

create table document_templates (
  id                     uuid        primary key,
  tenant_id              uuid        not null references tenants (id) on delete restrict,
  form_id                uuid        not null,
  name                   text        not null,
  -- The design, validated by @integr8/document-render before it is written:
  -- page settings, document fields and blocks.
  design                 jsonb       not null,
  design_schema_version  integer     not null default 1,
  -- Every saved change is a new revision; a document records the one it used.
  revision               integer     not null default 1,
  archived_at            timestamptz,
  created_by             uuid        not null,
  updated_by             uuid        not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint document_templates_tenant_id_unique unique (tenant_id, id),
  constraint document_templates_form_fk
    foreign key (tenant_id, form_id) references forms (tenant_id, id) on delete restrict,
  constraint document_templates_name_length check (char_length(name) between 1 and 120),
  constraint document_templates_revision_positive check (revision > 0),
  constraint document_templates_design_object check (jsonb_typeof(design) = 'object')
);
comment on table document_templates is
  'A form''s PDF layouts (documents ADR-0001 D1-D3). Designed by Integr8 staff; archived, never deleted.';

create index document_templates_form on document_templates (tenant_id, form_id);

create trigger document_templates_set_updated_at
  before update on document_templates
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

create table documents (
  id                 uuid        primary key,
  tenant_id          uuid        not null references tenants (id) on delete restrict,
  template_id        uuid        not null,
  template_revision  integer     not null,
  submission_id      uuid        not null,
  form_id            uuid        not null,
  -- What the register calls it: the template's name when made.
  title              text        not null,
  -- The QR code's key: 128 random bits, base64url. Shown to the company again
  -- in its register, so kept as it is; printed copies carry it anyway (D7).
  public_code        text        not null,
  status             text        not null default 'pending',
  failure_code       text,
  file_id            uuid,
  byte_size          bigint,
  page_count         integer,
  sha256             text,
  rendered_at        timestamptz,
  -- Expired by a person: the link stops at once. Undone by clearing both.
  expired_at         timestamptz,
  expired_by         uuid,
  -- Expires by itself from this moment, when set.
  expires_at         timestamptz,
  created_by         uuid        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint documents_tenant_id_unique unique (tenant_id, id),
  constraint documents_public_code_unique unique (public_code),
  constraint documents_public_code_format check (public_code ~ '^[A-Za-z0-9_-]{22}$'),
  constraint documents_template_fk
    foreign key (tenant_id, template_id) references document_templates (tenant_id, id)
    on delete restrict,
  constraint documents_submission_fk
    foreign key (tenant_id, submission_id) references submissions (tenant_id, id)
    on delete restrict,
  constraint documents_form_fk
    foreign key (tenant_id, form_id) references forms (tenant_id, id) on delete restrict,
  constraint documents_file_fk
    foreign key (tenant_id, file_id) references files (tenant_id, id) on delete restrict,
  constraint documents_status_known check (status in ('pending', 'ready', 'failed')),
  constraint documents_title_length check (char_length(title) between 1 and 200),
  -- A ready document has its file; a failed one says why; a pending one has neither.
  constraint documents_ready_complete check (
    (status = 'ready') = (file_id is not null and byte_size is not null and rendered_at is not null)
  ),
  constraint documents_failure_explained check ((status = 'failed') = (failure_code is not null)),
  constraint documents_expiry_complete check ((expired_at is null) = (expired_by is null)),
  constraint documents_byte_size_sane check (byte_size is null or byte_size >= 0),
  constraint documents_page_count_sane check (page_count is null or page_count > 0),
  constraint documents_template_revision_positive check (template_revision > 0)
);
comment on table documents is
  'PDFs made from submissions (documents ADR-0001 D4-D8). The file is in the company''s bucket and the media ledger; public_code is the QR link''s key.';

create index documents_recent on documents (tenant_id, created_at desc, id desc);
create index documents_submission on documents (tenant_id, submission_id);
create index documents_template on documents (tenant_id, template_id);

create trigger documents_set_updated_at
  before update on documents
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Document fields
-- ---------------------------------------------------------------------------

create table document_field_values (
  tenant_id         uuid  not null references tenants (id) on delete restrict,
  document_id       uuid  not null,
  field_key         text  not null,
  -- The field's label when the document was made, in each language.
  label             jsonb not null,
  value             text  not null,
  -- Trimmed and lower-cased: what search and the website lookup compare.
  value_normalized  text  not null,
  -- Whether the website lookup may find the document by this field (D10).
  lookup_role       text,

  constraint document_field_values_pkey primary key (tenant_id, document_id, field_key),
  constraint document_field_values_document_fk
    foreign key (tenant_id, document_id) references documents (tenant_id, id) on delete cascade,
  constraint document_field_values_key_format check (field_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint document_field_values_value_length check (char_length(value) <= 500),
  constraint document_field_values_lookup_role_known
    check (lookup_role is null or lookup_role in ('key', 'confirm'))
);
comment on table document_field_values is
  'The fields a document was made with (D6): typed at export or taken from the submission. Searchable; some open the website lookup.';

create index document_field_values_search
  on document_field_values (tenant_id, field_key, value_normalized);

-- ---------------------------------------------------------------------------
-- Website keys (platform-level)
-- ---------------------------------------------------------------------------

create table website_keys (
  id            uuid        primary key,
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  -- SHA-256 of the key, hex. The key itself is shown once and kept nowhere.
  key_hash      text        not null,
  -- The key's last four characters, so people can tell two keys apart.
  key_hint      text        not null,
  label         text,
  created_by    uuid        not null references platform_users (id),
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid        references platform_users (id),
  last_used_at  timestamptz,
  lookups       bigint      not null default 0,
  found         bigint      not null default 0,

  constraint website_keys_hash_unique unique (key_hash),
  constraint website_keys_hash_format check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint website_keys_hint_format check (key_hint ~ '^[A-Za-z0-9_-]{4}$'),
  constraint website_keys_label_length check (label is null or char_length(label) between 1 and 80),
  constraint website_keys_revocation_complete check ((revoked_at is null) = (revoked_by is null)),
  constraint website_keys_counts_sane check (lookups >= 0 and found >= 0 and found <= lookups)
);
comment on table website_keys is
  'A company website''s key for the document lookup (documents ADR-0001 D10, D11). Platform-level: issued and revoked by staff managers; no runtime grant.';

create index website_keys_tenant on website_keys (tenant_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on document_templates to integr8_app;
grant select, insert, update, delete on documents to integr8_app;
grant select, insert, update, delete on document_field_values to integr8_app;

alter table document_templates enable row level security;
alter table documents enable row level security;
alter table document_field_values enable row level security;
-- Platform-level: no grant and no policy for the runtime role.
alter table website_keys enable row level security;

create policy document_templates_isolation on document_templates for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy documents_isolation on documents for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy document_field_values_isolation on document_field_values for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
