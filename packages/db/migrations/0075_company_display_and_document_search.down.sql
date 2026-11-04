-- Reverses 0075. Typed fields keep their values but stop being searchable
-- from the company website, which the older release never offered.

-- An uploaded PDF goes back to the file as uploaded; its stamped copy stays in
-- the media ledger and goes the way of any file nothing uses.
update documents set file_id = original_file_id where original_file_id is not null;

alter table documents
  drop constraint documents_qr_placement_uploaded,
  drop constraint documents_original_file_fk,
  drop column original_file_id,
  drop column qr_placement,
  drop column printed_design,
  drop column qr_printed,
  drop column qr_spot;

update document_field_values set lookup_role = null where lookup_role = 'search';

alter table document_field_values
  drop constraint document_field_values_lookup_role_known,
  add constraint document_field_values_lookup_role_known
    check (lookup_role is null or lookup_role in ('key', 'confirm'));

alter table tenant_settings
  drop constraint tenant_settings_document_link_pattern_shape,
  drop constraint tenant_settings_hidden_nav_sections_size,
  drop column document_link_pattern,
  drop column hidden_nav_sections,
  drop column show_company_name;
