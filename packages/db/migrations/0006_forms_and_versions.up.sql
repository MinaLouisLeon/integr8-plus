-- 0006 — forms, their versions, and the submissions bound to them.
--
--   forms --< form_versions (draft -> published, then immutable) --< submissions
--
-- The plan calls the immutability of a published form version the single most
-- important invariant in the product, and says to enforce it in the database
-- rather than by convention. So it is enforced three ways, each sufficient on
-- its own:
--
--   1. A row-level trigger refuses any UPDATE or DELETE of a published version,
--      for every role, the schema owner included.
--   2. A statement-level trigger refuses TRUNCATE, which bypasses row triggers.
--   3. The runtime role has no DELETE privilege on the table at all.
--
-- "Editing" a published form therefore means creating a new draft version and
-- publishing that. Every submission keeps pointing at the version it was made
-- against, and renders against it forever.
--
-- What this migration cannot check is whether a definition is *valid*: that
-- needs the form engine, which lives in TypeScript. The service that publishes
-- runs `prepareForPublish` from @integr8/form-engine first. The database's job
-- is narrower and harder to get wrong — once published, nothing changes.

-- ---------------------------------------------------------------------------
-- forms — the thing a company admin names and manages.
-- ---------------------------------------------------------------------------

create table forms (
  id           uuid        primary key default gen_random_uuid(),
  -- `restrict`, like audit_log: a company with forms is not deleted by a cascade
  -- someone did not think about. Offboarding a company is a deliberate process.
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  title        text        not null,
  created_by   uuid        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz,

  constraint forms_tenant_id_unique unique (tenant_id, id),
  constraint forms_title_not_blank check (btrim(title) <> '')
);

comment on table forms is
  'A form a company uses. Holds no fields: those live in form_versions, one immutable copy per publish.';

create index forms_tenant_idx on forms (tenant_id, created_at desc);

create trigger forms_set_updated_at
  before update on forms
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- form_versions — a definition, drafted then frozen.
-- ---------------------------------------------------------------------------

create table form_versions (
  id                         uuid        primary key default gen_random_uuid(),
  tenant_id                  uuid        not null references tenants (id) on delete restrict,
  form_id                    uuid        not null,
  status                     text        not null default 'draft',
  -- Assigned at publish. A draft has no number: it is not a version of anything
  -- yet, and numbering drafts would leave gaps every time one was discarded.
  version_number             integer,
  definition                 jsonb       not null,
  -- The engine's own format version (`schemaVersion` in the definition). Kept as
  -- a column so old versions can be found when the format moves on.
  definition_schema_version  integer     not null,
  created_by                 uuid        not null,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  published_at               timestamptz,
  published_by               uuid,

  constraint form_versions_tenant_id_unique unique (tenant_id, id),
  constraint form_versions_form_fk
    foreign key (tenant_id, form_id) references forms (tenant_id, id) on delete restrict,
  constraint form_versions_number_unique unique (form_id, version_number),
  constraint form_versions_status_known check (status in ('draft', 'published')),
  -- Published and "has a number, a time and a publisher" are one fact.
  constraint form_versions_publication_complete
    check ((status = 'published') = (version_number is not null and published_at is not null and published_by is not null)),
  constraint form_versions_number_positive check (version_number is null or version_number >= 1),
  constraint form_versions_definition_is_object check (jsonb_typeof(definition) = 'object'),
  constraint form_versions_schema_version_matches
    check (definition ->> 'schemaVersion' = definition_schema_version::text)
);

comment on table form_versions is
  'One copy of a form definition. A draft may change; once published it is immutable, enforced by trigger for every role.';
comment on column form_versions.version_number is
  'Assigned when published, 1 upwards per form. Null while a draft.';

-- One draft at a time per form: two admins editing two drafts of the same form
-- would publish over each other's work.
create unique index form_versions_one_draft_per_form on form_versions (form_id) where status = 'draft';

create index form_versions_published_idx on form_versions (tenant_id, form_id, version_number desc)
  where status = 'published';

create trigger form_versions_set_updated_at
  before update on form_versions
  for each row execute function set_updated_at();

create function reject_published_form_version_change() returns trigger
language plpgsql
as $$
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

comment on function reject_published_form_version_change() is
  'Refuses UPDATE or DELETE of a published form version, for every role. The publish itself is the last permitted update: it is the draft being changed.';

-- Before the updated_at trigger in name order, so a refused update never gets
-- as far as touching anything. Postgres fires same-event triggers
-- alphabetically.
create trigger form_versions_immutable_when_published
  before update or delete on form_versions
  for each row execute function reject_published_form_version_change();

create function reject_form_versions_truncate() returns trigger
language plpgsql
as $$
begin
  raise exception 'form_versions cannot be truncated: published versions are immutable'
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

-- TRUNCATE fires no row triggers, so the row-level guard above cannot see it.
create trigger form_versions_no_truncate
  before truncate on form_versions
  execute function reject_form_versions_truncate();

-- ---------------------------------------------------------------------------
-- submissions — answers, bound to exactly one published version.
-- ---------------------------------------------------------------------------
--
-- The minimum P06 needs to make the binding an invariant. P08 builds the rest
-- of the lifecycle on this table: server-side drafts, generated columns for
-- reportable fields, amendment history.

create table submissions (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete restrict,
  form_version_id  uuid        not null,
  answers          jsonb       not null,
  submitted_by     uuid        not null,
  submitted_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint submissions_tenant_id_unique unique (tenant_id, id),
  -- Composite, so a submission cannot bind to another company's version even if
  -- it names that version's id.
  constraint submissions_form_version_fk
    foreign key (tenant_id, form_version_id) references form_versions (tenant_id, id) on delete restrict,
  constraint submissions_answers_is_object check (jsonb_typeof(answers) = 'object')
);

comment on table submissions is
  'Answers to one published form version. Bound at insert and never rebound: the version is what the answers mean.';

create index submissions_version_idx on submissions (tenant_id, form_version_id, submitted_at desc);

create trigger submissions_set_updated_at
  before update on submissions
  for each row execute function set_updated_at();

create function enforce_submission_binding() returns trigger
language plpgsql
as $$
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

create trigger submissions_bound_to_published_version
  before insert or update of form_version_id on submissions
  for each row execute function enforce_submission_binding();

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
--
-- `delete` on forms and form_versions is withheld from the runtime role. A
-- draft that is abandoned stays; P07's builder replaces its definition instead.
-- That also makes the third of the three controls above hold: the runtime role
-- could not delete a published version even if both triggers were dropped.

grant select, insert, update on forms to integr8_app;
grant select, insert, update on form_versions to integr8_app;
grant select, insert, update on submissions to integr8_app;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------

alter table forms enable row level security;

create policy forms_isolation on forms
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table form_versions enable row level security;

create policy form_versions_isolation on form_versions
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table submissions enable row level security;

create policy submissions_isolation on submissions
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
