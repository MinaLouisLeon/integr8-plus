-- Reverses 0032. Asset imports go with it; drafts forget which answers were
-- carried over, keeping the answers themselves.

delete from imports where kind = 'assets';
alter table imports
  drop constraint imports_kind_known,
  add constraint imports_kind_known check (kind in ('customers', 'sites', 'work_orders'));

alter table submissions drop column carried_over;
