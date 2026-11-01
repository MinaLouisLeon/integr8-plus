-- Tables that only ever grew, and request fingerprints of passwords.
--
-- Three tables gain a row on ordinary traffic and nothing removed any: one
-- rate-limit counter per address and window, one idempotency record per
-- retried write, one login attempt per sign-in. The worker now deletes them
-- once a night (`housekeeping.tables`, apps/api/src/jobs/table-housekeeping.ts):
-- counters a day old, idempotency records past their own `expires_at` (by then
-- they are taken over rather than replayed anyway), login attempts after 90
-- days. Its turn is claimed like every other nightly task, so several workers
-- produce one run.
--
-- Deleting login attempts by age needs an index on the time alone; the two
-- that exist lead with the email or the address.
create index if not exists login_attempts_occurred_at_idx on login_attempts (occurred_at);

insert into scheduled_task_runs (task) values ('housekeeping.tables')
on conflict (task) do nothing;

-- Until this release a request's fingerprint was a plain SHA-256 of its body,
-- passwords included, so a stored fingerprint of Change password could be
-- checked offline against guesses at the new password. Fingerprints are now a
-- keyed HMAC over the body without its password fields
-- (apps/api/src/http/idempotency.ts). The records already written for the
-- routes that carry a password or a secret are deleted here rather than left
-- to age out: a retry of one of them arriving across the deploy runs again,
-- which for these routes is harmless (the same password set twice, the same
-- credentials saved twice).
delete from idempotency_keys
where path in ('/v1/me/password', '/v1/eta/settings/credentials');
