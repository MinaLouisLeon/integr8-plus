-- Reverses 0067. Uploaded documents have nowhere to go in the older shape, so
-- their records (and their fields) are removed; their PDFs stay in the media
-- ledger and the company's bucket. Every other document keeps its link.

delete from documents where source = 'uploaded';

drop index if exists documents_customer;

alter table documents
  drop constraint documents_source_shape,
  drop constraint documents_customer_fk,
  drop constraint documents_reference_length,
  drop constraint documents_source_known,
  drop column shareable,
  drop column customer_id,
  drop column reference,
  drop column source,
  alter column template_id set not null,
  alter column template_revision set not null,
  alter column submission_id set not null,
  alter column form_id set not null;

update feature_flags set description = 'Company website access to customer documents and files.'
 where key = 'website_files';
update feature_flags set description = 'Company website access to customer job status.'
 where key = 'website_jobs';
update feature_flags set description = 'Company website access to customer quotes.'
 where key = 'website_quotes';
update feature_flags set description = 'Company website access to customer invoices.'
 where key = 'website_invoices';
