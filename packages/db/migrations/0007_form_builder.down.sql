-- 0007 - down.
--
-- Dropping columns from form_versions is DDL, so the immutability trigger does
-- not stand in the way; on a database holding real versions it would discard
-- their change notes, which is what rolling back this migration means.

drop policy if exists form_templates_readable on form_templates;
revoke all on form_templates from integr8_app;
drop table if exists form_templates;

alter table form_versions
  drop constraint if exists form_versions_history_only_when_published,
  drop constraint if exists form_versions_changes_is_object,
  drop constraint if exists form_versions_change_note_length,
  drop constraint if exists form_versions_revision_positive,
  drop column if exists changes,
  drop column if exists change_note,
  drop column if exists revision;

alter table forms
  drop constraint if exists forms_single_source,
  drop constraint if exists forms_cloned_from_fk,
  drop constraint if exists forms_fill_roles_not_empty,
  drop constraint if exists forms_fill_roles_known,
  drop column if exists source_template_key,
  drop column if exists cloned_from_form_id,
  drop column if exists signature_required,
  drop column if exists fill_roles;
