-- Reverses 0031. Drops every asset, its history and its links to jobs,
-- submissions, parts and attachments; attachments that belonged to an asset
-- go with it. Fine on a fresh or test database; on a live one, take a backup
-- or a company export first.

delete from attachments where asset_id is not null;
alter table attachments
  drop constraint attachments_one_owner,
  drop column asset_id,
  add constraint attachments_one_owner check (num_nonnulls(customer_id, site_id, work_order_id) = 1);

alter table erp_work_order_materials drop column asset_id;
alter table submissions drop column asset_id;

drop table erp_work_order_assets;
drop table erp_asset_events;
drop table erp_assets;
drop function assign_asset_reference();
drop table asset_reference_counters;
drop table erp_asset_settings;

delete from feature_flags where key = 'assets';
