-- Reverses 0074. Business PDFs have no place in the older shape, so their
-- records (and their fields) are removed; their PDFs stay in the media ledger
-- and the company's bucket, like any file whose record is gone.

delete from documents
 where source in ('quote', 'invoice', 'purchase_order', 'job_report');

drop index if exists documents_work_order;
drop index if exists documents_purchase_order;
drop index if exists documents_invoice;
drop index if exists documents_quote;

alter table documents
  drop constraint documents_business_record,
  drop constraint documents_source_shape,
  drop constraint documents_source_known,
  drop constraint documents_work_order_fk,
  drop constraint documents_purchase_order_fk,
  drop constraint documents_invoice_fk,
  drop constraint documents_quote_fk,
  drop column work_order_id,
  drop column purchase_order_id,
  drop column invoice_id,
  drop column quote_id;

alter table documents
  add constraint documents_source_known check (source in ('generated', 'uploaded')),
  add constraint documents_source_shape check (
    case source
      when 'generated' then
        template_id is not null and template_revision is not null
        and submission_id is not null and form_id is not null
        and reference is null and customer_id is null
      else
        template_id is null and template_revision is null
        and submission_id is null and form_id is null
        and reference is not null and status = 'ready'
    end
  );

comment on column documents.source is
  'generated: made from a submission with a template; uploaded: a PDF a person uploaded (0067).';
comment on column documents.reference is
  'An uploaded document''s reference number, such as a certificate number: what the website lookup finds it by (0067).';
