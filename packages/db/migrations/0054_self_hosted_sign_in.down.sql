-- Reverses 0054. Forgets how each session began and any sign-in account still
-- waiting to be deleted from Auth.

drop table if exists identity_deletions;

alter table sessions
  drop constraint if exists sessions_signed_in_with_known,
  drop column if exists authenticated_at,
  drop column if exists signed_in_with;
