-- Removes the assets module (see the up file).

drop table if exists
  erp_work_order_assets,
  erp_asset_events,
  erp_assets,
  asset_reference_counters,
  erp_asset_settings
cascade;
drop function if exists assign_asset_reference();
