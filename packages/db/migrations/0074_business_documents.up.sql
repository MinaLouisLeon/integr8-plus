-- 0074 — business PDFs in the documents register (docs/documents/business-pdfs.md).
--
-- A quote, an invoice, a purchase order or a job report can be printed by the
-- server in the company's look and kept in the same register as the PDFs made
-- from submissions and the ones uploaded (0067). Each is made from one record,
-- named by its own column with a key that carries tenant_id, so the record's
-- screen lists its PDFs and nothing can point across companies:
--
--   source           link column          reference              customer
--   quote            quote_id             QT-000123(-R2)         the quote's
--   invoice          invoice_id           INV-000123             the invoice's
--   purchase_order   purchase_order_id    PO-000123              none (a supplier)
--   job_report       work_order_id        WO-000123              the job's
--
-- None has a template or a submission. Like an uploaded document, each starts
-- not shareable (0067): its QR code's /d/ link opens only once someone allowed
-- to switch sharing turns it on. Records keep their PDFs: a quote, an issued
-- invoice, a purchase order and a job are never deleted, and only issued or
-- approved records are printed, so `on delete restrict` never stands in the way
-- of discarding a draft.
--
-- Expand-only. The previous release reads these rows but does not know their
-- `source`; its register would refuse to describe them, so a rollback past
-- this release should run the down migration, which removes them.

alter table documents
  add column quote_id          uuid,
  add column invoice_id        uuid,
  add column purchase_order_id uuid,
  add column work_order_id     uuid,
  add constraint documents_quote_fk
    foreign key (tenant_id, quote_id) references crm_quotes (tenant_id, id) on delete restrict,
  add constraint documents_invoice_fk
    foreign key (tenant_id, invoice_id) references erp_invoices (tenant_id, id) on delete restrict,
  add constraint documents_purchase_order_fk
    foreign key (tenant_id, purchase_order_id) references erp_purchase_orders (tenant_id, id)
    on delete restrict,
  add constraint documents_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id)
    on delete restrict,
  drop constraint documents_source_known,
  drop constraint documents_source_shape;

alter table documents
  add constraint documents_source_known check (
    source in ('generated', 'uploaded', 'quote', 'invoice', 'purchase_order', 'job_report')
  ),
  add constraint documents_source_shape check (
    case source
      when 'generated' then
        template_id is not null and template_revision is not null
        and submission_id is not null and form_id is not null
        and reference is null and customer_id is null
      when 'uploaded' then
        template_id is null and template_revision is null
        and submission_id is null and form_id is null
        and reference is not null and status = 'ready'
      else
        template_id is null and template_revision is null
        and submission_id is null and form_id is null
        and reference is not null
    end
  ),
  -- Exactly the one record a business PDF is made from, and none on the others.
  add constraint documents_business_record check (
    (quote_id is not null)::int + (invoice_id is not null)::int
      + (purchase_order_id is not null)::int + (work_order_id is not null)::int
    = case source
        when 'quote' then 1
        when 'invoice' then 1
        when 'purchase_order' then 1
        when 'job_report' then 1
        else 0
      end
    and (source <> 'quote' or quote_id is not null)
    and (source <> 'invoice' or invoice_id is not null)
    and (source <> 'purchase_order' or (purchase_order_id is not null and customer_id is null))
    and (source <> 'job_report' or work_order_id is not null)
  );

comment on column documents.source is
  'generated: made from a submission with a template; uploaded: a PDF a person uploaded (0067); quote, invoice, purchase_order, job_report: printed by the server from that record (0074).';
comment on column documents.reference is
  'An uploaded document''s reference number (0067), or a business PDF''s record number such as INV-000123 (0074).';
comment on column documents.quote_id is 'The quote a business PDF was printed from (0074).';
comment on column documents.invoice_id is 'The invoice a business PDF was printed from (0074).';
comment on column documents.purchase_order_id is
  'The purchase order a business PDF was printed from (0074).';
comment on column documents.work_order_id is 'The job a job report was printed from (0074).';

create index documents_quote on documents (tenant_id, quote_id, created_at desc)
  where quote_id is not null;
create index documents_invoice on documents (tenant_id, invoice_id, created_at desc)
  where invoice_id is not null;
create index documents_purchase_order on documents (tenant_id, purchase_order_id, created_at desc)
  where purchase_order_id is not null;
create index documents_work_order on documents (tenant_id, work_order_id, created_at desc)
  where work_order_id is not null;
