drop table if exists sync_reports;

revoke update (expires_at) on upload_intents from integr8_app;

alter table upload_intents
  drop constraint if exists upload_intents_part_size_sane,
  drop constraint if exists upload_intents_multipart_pair,
  drop column if exists part_size,
  drop column if exists multipart_upload_id;

drop function if exists prune_sync_touches(uuid, interval);

drop trigger if exists form_versions_touch_sync on form_versions;
drop trigger if exists forms_touch_sync on forms;
drop trigger if exists sites_touch_sync on sites;
drop trigger if exists customer_contacts_touch_sync on customer_contacts;
drop trigger if exists customers_touch_sync on customers;
drop trigger if exists attachments_touch_site on attachments;
drop trigger if exists attachments_touch_customer on attachments;
drop trigger if exists attachments_touch_work_order on attachments;
drop trigger if exists submissions_touch_sync on submissions;
drop trigger if exists work_order_forms_touch_sync on work_order_forms;
drop trigger if exists work_order_comments_touch_sync on work_order_comments;
drop trigger if exists work_order_checklist_items_touch_sync on work_order_checklist_items;
drop trigger if exists work_order_assignments_touch_sync on work_order_assignments;
drop trigger if exists work_orders_touch_sync on work_orders;

drop function if exists touch_sync();

drop table if exists sync_log_marks;
drop table if exists sync_touches;
