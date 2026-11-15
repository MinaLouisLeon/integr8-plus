-- Removes the sales module (see the up file).

drop table if exists
  erp_sales_delivery_lines,
  erp_sales_deliveries,
  erp_sales_order_work_orders,
  erp_sales_order_lines,
  erp_sales_orders,
  crm_quote_lines,
  crm_quotes,
  sales_document_counters
cascade;
drop function if exists assign_sales_reference();
drop function if exists crm_quote_lines_guard();
drop function if exists erp_assign_line_scale();
drop function if exists erp_currency_minor_unit(text);
drop function if exists erp_sales_order_lines_guard();
