-- Reverses 0034. Journals already posted from documents stay; the queue and
-- its capture go.

drop trigger erp_stock_movements_ledger_capture on erp_stock_movements;
drop function erp_stock_movements_ledger_capture();
drop trigger erp_payment_receipts_ledger_capture on erp_payment_receipts;
drop function erp_payment_receipts_ledger_capture();
drop trigger erp_credit_notes_ledger_capture on erp_credit_notes;
drop function erp_credit_notes_ledger_capture();
drop trigger erp_invoices_ledger_capture on erp_invoices;
drop function erp_invoices_ledger_capture();
drop function erp_ledger_backfill(uuid);
drop function erp_ledger_capture(uuid, text, uuid, date, text, uuid);
drop function erp_ledger_try_post(uuid, uuid, boolean);
drop function erp_ledger_source_label(uuid, text, uuid);
drop function erp_ledger_parent_invoice(uuid, text, uuid);
drop function erp_ledger_proposal(uuid, text, uuid);
drop function erp_ledger_currency(uuid);
drop function erp_ledger_timezone(uuid);
drop table erp_ledger_postings;
drop function erp_ledger_postings_guard();
