-- Reverses 0020.
--
-- A request caught mid-claim goes back to `pending`, which is what the code
-- before 0020 understands and what the link it was sent still means: nothing
-- has been marked verified, so nothing has been provisioned for it.

update signup_requests set status = 'pending' where status = 'verifying';

alter table signup_requests drop constraint signup_requests_status_known;

alter table signup_requests
  add constraint signup_requests_status_known
  check (status in ('pending', 'verified', 'expired', 'abandoned'));
