alter table push_devices drop constraint if exists push_devices_locale_known;
alter table push_devices drop column if exists locale;
