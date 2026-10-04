-- P18 follow-up — a `verifying` status, so a signup is claimed before it is
-- provisioned rather than after.
--
-- `verifySignup` read the request, checked it was `pending`, created the
-- identity and the company, and only then ran the conditional update to
-- `verified`. Two verifies at once — a mail client prefetching the link and the
-- person clicking it, or a double-click — both passed the read. With the fake
-- identity provider both made a company; with GoTrue the second `admin/users`
-- call was refused as a duplicate address, the request stayed `pending`, and an
-- address that already had an identity could never finish signing up.
--
-- The fix is the one the invitation flow already uses: claim first, in one
-- statement, then provision. `verifying` is that claim. It is held for the
-- seconds provisioning takes; success moves it to `verified`, failure puts it
-- back to `pending` so the same link still works. A process that dies between
-- the two leaves a `verifying` row, which the person gets past by starting
-- again — the expiry sweep deliberately leaves it alone, so that a row being
-- provisioned at the moment it expires cannot be marked `expired` under the
-- verify that is about to finish it.
--
-- `signup_requests_verified_pair` needs no change: a `verifying` row has no
-- `verified_at`, which is what the constraint already requires of anything that
-- is not `verified`.
--
-- Widening a check: drop and add in one transaction, per docs/database/migrations.md.

alter table signup_requests drop constraint signup_requests_status_known;

alter table signup_requests
  add constraint signup_requests_status_known
  check (status in ('pending', 'verifying', 'verified', 'expired', 'abandoned'));
