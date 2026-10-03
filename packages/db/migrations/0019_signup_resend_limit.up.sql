-- P18 follow-up — a cap on resent verification links.
--
-- `POST /v1/signup/resend` sent a fresh link every time it was asked, with no
-- limit and a renewed expiry. Starting a signup is capped per address and per
-- day; resending was not, which made it a way to send unlimited mail from our
-- domain to any address somebody else typed in: one signup, then a loop.
--
-- The count lives on the request rather than in a separate table because it is
-- a property of that one link, and because incrementing it in the same
-- statement that rotates the token is what stops two resends racing past the
-- cap together.

alter table signup_requests
  add column resend_count integer not null default 0;

alter table signup_requests
  add constraint signup_requests_resend_count_sane check (resend_count >= 0);
