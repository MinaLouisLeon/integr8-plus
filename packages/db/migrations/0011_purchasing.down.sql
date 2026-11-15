-- Removes the purchasing module (see the up file).

drop table if exists
  erp_van_request_lines,
  erp_van_requests,
  erp_work_order_purchases,
  erp_supplier_prices,
  erp_goods_receipt_lines,
  erp_goods_receipts,
  erp_purchase_order_lines,
  erp_purchase_orders,
  erp_purchase_order_counters,
  erp_suppliers
cascade;
drop function if exists assign_purchase_order_reference();
drop function if exists erp_purchase_order_lines_guard();
drop function if exists erp_work_order_purchases_guard();
