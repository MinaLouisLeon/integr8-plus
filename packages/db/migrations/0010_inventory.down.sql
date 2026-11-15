-- Removes the inventory module (see the up file).

drop table if exists
  erp_work_order_materials,
  erp_reorder_levels,
  erp_stock_lot_balances,
  erp_stock_balances,
  erp_stock_movements,
  erp_stock_lots,
  erp_stock_count_lines,
  erp_stock_counts,
  erp_stock_locations,
  erp_items,
  erp_item_categories
cascade;
drop function if exists erp_ledger_auto_on(public.erp_ledger_settings, text);
drop function if exists erp_ledger_capture(uuid, text, uuid, date, text, uuid);
drop function if exists erp_ledger_parent_invoice(uuid, text, uuid);
drop function if exists erp_ledger_proposal(uuid, text, uuid);
drop function if exists erp_ledger_source_label(uuid, text, uuid);
drop function if exists erp_ledger_try_post(uuid, uuid, boolean);
drop function if exists erp_stock_apply_lot_movement();
drop function if exists erp_stock_apply_movement();
drop function if exists erp_stock_lock_balance(uuid, uuid, uuid);
drop function if exists erp_stock_lock_lot_balance(uuid, uuid, uuid);
drop function if exists erp_stock_movements_immutable();
drop function if exists erp_stock_movements_ledger_capture();
drop function if exists erp_stock_movements_lot_check();
drop function if exists guard_work_order_material_job();
