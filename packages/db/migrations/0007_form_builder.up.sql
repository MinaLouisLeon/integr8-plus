-- 0007 - what the form builder needs to store.
--
-- Four additions, each small, for P07:
--
--   * form settings: which roles may fill a form, and whether a signature is
--     mandatory before a job can close;
--   * where a form came from: another form, or a template;
--   * a revision number on drafts, so two builder tabs cannot silently
--     overwrite each other's autosave;
--   * a change note and a stored change summary on every published version,
--     which is what version history reads.
--
-- And one platform table: the global template library.
--
-- Adding columns to form_versions is DDL, not an UPDATE, so the immutability
-- trigger from 0006 is not involved and every published row keeps its bytes:
-- the new columns read as null on versions published before this migration.

-- ---------------------------------------------------------------------------
-- forms: settings and provenance
-- ---------------------------------------------------------------------------

alter table forms
  add column fill_roles text[] not null default array['owner', 'admin', 'dispatcher', 'engineer', 'viewer'],
  add column signature_required boolean not null default false,
  add column cloned_from_form_id uuid,
  add column source_template_key text;

alter table forms
  add constraint forms_fill_roles_known
    check (fill_roles <@ array['owner', 'admin', 'dispatcher', 'engineer', 'viewer']),
  -- A form nobody may fill is a form nobody can use, and the builder would show
  -- it as working. Refused here rather than discovered on a phone.
  add constraint forms_fill_roles_not_empty check (cardinality(fill_roles) > 0),
  add constraint forms_cloned_from_fk
    foreign key (tenant_id, cloned_from_form_id) references forms (tenant_id, id) on delete restrict,
  add constraint forms_single_source
    check (cloned_from_form_id is null or source_template_key is null);

comment on column forms.fill_roles is
  'Roles that may fill this form. Enforced where forms are filled (P08, P13); stored and validated here.';
comment on column forms.signature_required is
  'Whether a signature is mandatory before a job using this form can close. Enforced from P10.';

-- ---------------------------------------------------------------------------
-- form_versions: draft revision, change note, change summary
-- ---------------------------------------------------------------------------

alter table form_versions
  add column revision integer not null default 1,
  add column change_note text,
  add column changes jsonb;

alter table form_versions
  add constraint form_versions_revision_positive check (revision >= 1),
  add constraint form_versions_change_note_length check (change_note is null or char_length(change_note) <= 2000),
  add constraint form_versions_changes_is_object check (changes is null or jsonb_typeof(changes) = 'object'),
  -- A note and a summary describe a publish, so a draft has neither.
  add constraint form_versions_history_only_when_published
    check (status = 'published' or (change_note is null and changes is null));

comment on column form_versions.revision is
  'Incremented by every save of a draft. A save naming an older revision is refused, so a second builder tab cannot overwrite the first.';
comment on column form_versions.changes is
  'The diff against the previous published version, computed by @integr8/form-engine at publish. What version history shows.';

-- ---------------------------------------------------------------------------
-- form_templates: the global library. Platform content, not tenant data.
-- ---------------------------------------------------------------------------
--
-- Every company may read it and clone from it; none may write to it. P15 gives
-- super admins a screen to manage it; until then it is loaded from
-- @integr8/form-engine by `pnpm --filter @integr8/db db templates`, run as the
-- schema owner.

create table form_templates (
  key                        text        primary key,
  title                      jsonb       not null,
  description                jsonb       not null,
  category                   text        not null,
  definition                 jsonb       not null,
  definition_schema_version  integer     not null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint form_templates_key_format check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint form_templates_category_known check (category in ('maintenance', 'safety', 'completion')),
  constraint form_templates_definition_is_object check (jsonb_typeof(definition) = 'object'),
  constraint form_templates_schema_version_matches
    check (definition ->> 'schemaVersion' = definition_schema_version::text)
);

comment on table form_templates is
  'The global form template library. Platform content: read by every company, written only by the schema owner.';

create trigger form_templates_set_updated_at
  before update on form_templates
  for each row execute function set_updated_at();

grant select on form_templates to integr8_app;

alter table form_templates enable row level security;

-- Readable by every company, because it belongs to none of them. Select only:
-- there is no insert, update or delete grant for this policy to widen.
create policy form_templates_readable on form_templates
  for select
  to integr8_app
  using (true);
