-- 0008 - down.
--
-- Discards drafts (0006 had no way to hold one), submission history and
-- reportable values, and the record of uploads. Submitted answers stay in
-- submissions, bound to their versions, as they were before this migration.

drop trigger if exists submissions_record_change on submissions;
drop function if exists record_submission_change();
drop trigger if exists submissions_lifecycle on submissions;
drop function if exists enforce_submission_lifecycle();

drop table if exists submission_values;

drop trigger if exists submission_events_no_truncate on submission_events;
drop trigger if exists submission_events_no_delete on submission_events;
drop trigger if exists submission_events_no_update on submission_events;
drop table if exists submission_events;
drop function if exists reject_submission_events_mutation();

drop index if exists submissions_search_idx;
drop index if exists submissions_submitter_idx;
drop index if exists submissions_form_idx;

-- A draft cannot exist under 0006's constraints. Reopened submissions return to
-- submitted with the answers they hold, which is what 0006 would have stored.
delete from submissions where status = 'draft';

alter table submissions
  drop constraint if exists submissions_reason_length,
  drop constraint if exists submissions_revision_positive,
  drop constraint if exists submissions_submitted_at_matches_status,
  drop constraint if exists submissions_status_known,
  drop constraint if exists submissions_form_fk,
  drop column if exists search,
  drop column if exists amended_at,
  drop column if exists last_reason,
  drop column if exists last_actor,
  drop column if exists revision,
  drop column if exists status,
  drop column if exists form_id,
  alter column submitted_at set default now(),
  alter column submitted_at set not null;

drop policy if exists media_objects_isolation on media_objects;
revoke all on media_objects from integr8_app;
drop table if exists media_objects;

alter table form_versions
  drop constraint if exists form_versions_reportable_fields_at_publish,
  drop constraint if exists form_versions_reportable_fields_shape,
  drop column if exists reportable_fields;
