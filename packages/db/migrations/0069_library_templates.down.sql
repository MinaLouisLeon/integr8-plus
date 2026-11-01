-- 0069 — down. Discards every staff-made library template, and the record of
-- the pictures they carried (the bytes stay in the platform-library bucket).

drop table if exists form_template_files;
drop table if exists form_template_documents;

delete from form_templates where source = 'staff';

alter table form_templates
  drop constraint if exists form_templates_source_version_positive,
  drop constraint if exists form_templates_origin_complete,
  drop constraint if exists form_templates_origin_staff_only,
  drop constraint if exists form_templates_retirement_complete,
  drop constraint if exists form_templates_retire_staff_only,
  drop constraint if exists form_templates_source_known,
  drop column if exists updated_by,
  drop column if exists created_by,
  drop column if exists source_version_number,
  drop column if exists source_form_id,
  drop column if exists source_tenant_id,
  drop column if exists retired_by,
  drop column if exists retired_at,
  drop column if exists source;
