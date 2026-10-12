-- Reverses 0042.

alter table erp_stock_count_lines
  drop constraint erp_stock_count_lines_unique,
  drop constraint erp_stock_count_lines_lot_code_length,
  drop constraint erp_stock_count_lines_lot_fk,
  drop column lot_expires_on,
  drop column lot_code,
  drop column lot_id;
delete from erp_stock_count_lines a
 using erp_stock_count_lines b
 where a.tenant_id = b.tenant_id and a.count_id = b.count_id and a.item_id = b.item_id and a.ctid > b.ctid;
alter table erp_stock_count_lines add primary key (tenant_id, count_id, item_id);

alter table erp_work_order_materials
  drop constraint erp_work_order_materials_lots_shape,
  drop column lots;

drop function erp_stock_lock_lot_balance(uuid, uuid, uuid);
drop trigger erp_stock_movements_apply_lot on erp_stock_movements;
drop function erp_stock_apply_lot_movement();
drop trigger erp_stock_movements_lot_check on erp_stock_movements;
drop function erp_stock_movements_lot_check();
drop table erp_stock_lot_balances;
drop index erp_stock_movements_lot_idx;
alter table erp_stock_movements
  drop constraint erp_stock_movements_lot_fk,
  drop column lot_id;
drop table erp_stock_lots;

alter table erp_items
  drop constraint erp_items_tracking_stock_only,
  drop constraint erp_items_tracking_known,
  drop column tracking;
