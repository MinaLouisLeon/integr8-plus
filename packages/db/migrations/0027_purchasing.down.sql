-- Reverses 0027.
--
-- Drops every supplier, purchase order and goods receipt. The stock movements
-- those receipts posted stay in the ledger (0026): what arrived, arrived.
-- Fine on a fresh or test database; on a live one, take a backup or a company
-- export first.

drop table erp_goods_receipt_lines;
drop table erp_goods_receipts;
drop table erp_purchase_order_lines;
drop function erp_purchase_order_lines_guard();
drop table erp_purchase_orders;
drop function assign_purchase_order_reference();
drop table erp_purchase_order_counters;
alter table erp_items
  drop constraint erp_items_supplier_fk,
  drop constraint erp_items_supplier_part_number_length,
  drop column preferred_supplier_id,
  drop column supplier_part_number;
drop table erp_suppliers;
