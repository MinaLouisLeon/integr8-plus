delete from feature_flags where key in ('website_files', 'website_jobs', 'website_quotes', 'website_invoices');
alter table website_keys drop column enabled;
alter table tenant_settings
  drop column website_files_enabled,
  drop column website_jobs_enabled,
  drop column website_quotes_enabled,
  drop column website_invoices_enabled;
