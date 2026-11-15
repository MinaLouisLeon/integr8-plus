-- Removes the e invoicing module (see the up file).

drop table if exists
  eta_schemas,
  eta_signing_requests,
  eta_attempts,
  eta_documents,
  eta_tax_mappings,
  eta_unit_types,
  eta_item_codes,
  eta_receivers,
  eta_settings
cascade;
drop function if exists eta_documents_guard();
