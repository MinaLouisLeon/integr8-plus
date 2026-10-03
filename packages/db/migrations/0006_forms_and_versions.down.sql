-- 0006 — down.
--
-- Rolling this back discards every form, version and submission. That is what
-- a down migration of a table-creating migration means; it is written so the
-- test suite can prove the migration is reversible on an empty schema, not so
-- that anyone runs it against data they want.

drop policy if exists submissions_isolation on submissions;
drop policy if exists form_versions_isolation on form_versions;
drop policy if exists forms_isolation on forms;

revoke all on submissions from integr8_app;
revoke all on form_versions from integr8_app;
revoke all on forms from integr8_app;

drop table if exists submissions;
drop function if exists enforce_submission_binding();

-- Dropping a table drops its triggers with it, and a DROP is not a TRUNCATE,
-- so the immutability guards do not stand in the way. Their functions go after.
drop table if exists form_versions;
drop function if exists reject_form_versions_truncate();
drop function if exists reject_published_form_version_change();

drop table if exists forms;
