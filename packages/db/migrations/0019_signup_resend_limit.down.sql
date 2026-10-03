-- Reverses 0019.

alter table signup_requests drop constraint if exists signup_requests_resend_count_sane;
alter table signup_requests drop column if exists resend_count;
