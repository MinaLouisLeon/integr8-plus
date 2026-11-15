-- Removes the finance module (see the up file).

drop table if exists
  erp_payment_reversals,
  erp_payment_allocations,
  erp_payment_receipts,
  erp_credit_note_lines,
  erp_credit_notes,
  erp_invoice_lines,
  erp_invoices,
  finance_document_counters,
  erp_finance_settings
cascade;
drop function if exists assign_finance_reference();
drop function if exists erp_credit_note_lines_guard();
drop function if exists erp_credit_notes_guard();
drop function if exists erp_credit_notes_ledger_capture();
drop function if exists erp_invoice_balance(uuid, uuid);
drop function if exists erp_invoice_lines_guard();
drop function if exists erp_invoices_guard();
drop function if exists erp_invoices_ledger_capture();
drop function if exists erp_ledger_backfill(uuid);
drop function if exists erp_payment_allocations_guard();
drop function if exists erp_payment_receipts_ledger_capture();
drop function if exists erp_payment_reversals_apply();
