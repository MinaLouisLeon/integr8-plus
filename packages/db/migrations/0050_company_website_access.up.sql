-- Company website access (company website API).
-- Each capability needs both the company's own switch and Integr8's grant.
alter table tenant_settings
  add column website_files_enabled boolean not null default false,
  add column website_jobs_enabled boolean not null default false,
  add column website_quotes_enabled boolean not null default false,
  add column website_invoices_enabled boolean not null default false;

alter table website_keys
  add column enabled boolean not null default true;

insert into feature_flags (key, description, default_enabled)
values
  ('website_files', 'Company website access to customer documents and files.', false),
  ('website_jobs', 'Company website access to customer job status.', false),
  ('website_quotes', 'Company website access to customer quotes.', false),
  ('website_invoices', 'Company website access to customer invoices.', false);
