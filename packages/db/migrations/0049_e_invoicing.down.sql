-- Reverses 0049. Development databases only: on a running deployment this
-- deletes every company's e-invoicing settings, sealed credentials and the
-- record of every document sent to the Tax Authority. The invoices themselves
-- are untouched; what the ETA holds stays at the ETA.

drop table if exists eta_schemas;
drop table if exists eta_signing_requests;
drop table if exists eta_attempts;
drop table if exists eta_documents;
drop function if exists eta_documents_guard();
drop table if exists eta_tax_mappings;
drop table if exists eta_unit_types;
drop table if exists eta_item_codes;
drop table if exists eta_receivers;
drop table if exists eta_settings;

delete from feature_flags where key = 'e_invoicing';
