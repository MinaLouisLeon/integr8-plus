-- Removes the sync module (see the up file).

drop table if exists
  sync_reports,
  sync_log_marks,
  sync_touches
cascade;
drop function if exists prune_sync_touches(uuid, interval);
