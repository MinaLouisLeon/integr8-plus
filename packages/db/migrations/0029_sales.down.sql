-- Reverses 0029. Drops every quote and sales order; the stock movements the
-- orders' jobs posted stay in the ledger (0026). Fine on a fresh or test
-- database; on a live one, take a backup or a company export first.

drop table erp_sales_order_work_orders;
drop table erp_sales_order_lines;
drop function erp_sales_order_lines_guard();
alter table crm_quotes drop constraint crm_quotes_converted_order_fk;
drop table erp_sales_orders;
drop table crm_quote_lines;
drop function crm_quote_lines_guard();
drop table crm_quotes;
drop function assign_sales_reference();
drop table sales_document_counters;
delete from feature_flags where key = 'sales';
