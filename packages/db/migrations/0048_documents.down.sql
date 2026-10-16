-- Reverses 0048. Development databases only: on a running deployment this
-- removes every company's PDF records and website keys. The PDFs themselves
-- stay in the companies' buckets and in the media ledger.

drop table if exists website_keys;
drop table if exists document_field_values;
drop table if exists documents;
drop table if exists document_templates;

delete from feature_flags where key = 'documents';
