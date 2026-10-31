-- The language a phone reads its push notifications in (P32).
--
-- Nothing stores a language per person: each app picks its language per
-- device. So the phone says which it is using when it registers for push, and
-- the server writes each notification in that language. Null for a phone that
-- has not said (one older than this release): it is written to in English, as
-- before, until it next registers.
alter table push_devices add column locale text;

alter table push_devices add constraint push_devices_locale_known
  check (locale is null or locale in ('en', 'ar'));
