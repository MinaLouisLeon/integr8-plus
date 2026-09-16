-- Reverses 0018.

delete from scheduled_task_runs where task = 'signup.expire';

drop index if exists work_orders_demo_idx;
drop index if exists sites_demo_idx;
drop index if exists customers_demo_idx;

alter table work_orders drop column if exists is_demo;
alter table sites       drop column if exists is_demo;
alter table customers   drop column if exists is_demo;

drop table if exists tenant_settings;
drop table if exists signup_events;
drop table if exists signup_requests;
