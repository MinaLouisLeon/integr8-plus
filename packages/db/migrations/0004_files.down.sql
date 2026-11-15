-- Removes the files module (see the up file).

drop table if exists
  storage_reconciliations,
  tenant_storage_samples,
  tenant_storage_usage,
  files,
  upload_intents,
  tenant_storage
cascade;
drop function if exists protect_file_ledger();
drop function if exists record_file_usage();
