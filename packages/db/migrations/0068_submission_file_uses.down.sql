-- Reverses 0068. The index is derived; the submissions it was read from stay.

drop trigger if exists submission_events_record_file_uses on submission_events;
drop trigger if exists submissions_record_file_uses on submissions;
drop function if exists record_submission_file_uses();
drop function if exists submission_answer_file_ids(jsonb);
drop table if exists submission_file_uses;
