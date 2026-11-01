-- 0067 — uploaded documents, and whether a document may be shared (docs/documents).
--
-- Two changes to the register, both expand-only.
--
-- 1. A company can upload a PDF it already has (a certificate signed on paper,
--    a report from a subcontractor) into the same register as the PDFs made
--    from submissions. An uploaded document has no template and no
--    submission, so those four columns become nullable; a check keeps every
--    generated document exactly as it was, and says what an uploaded one
--    carries instead: a reference number (what the website lookup finds it
--    by) and, optionally, the customer it is for (the lookup's second match).
--    It is ready the moment it is recorded: the file is already stored.
--
-- 2. `shareable`: whether the QR code's link and the company website may show
--    the document at all. Off, the public link answers as if the code did not
--    exist and the website lookup does not find it. Documents that exist
--    today stay shareable, because their QR codes are already printed; new
--    ones, generated or uploaded, start off and someone allowed to upload
--    documents switches each on. Adding the column with default true fills
--    every existing row in one step; the default then becomes false.
--
-- The previous release keeps working on this schema: it inserts generated
-- documents with every column it knows, which the check allows, and new rows
-- it writes start not shareable, which it ignores.

alter table documents
  alter column template_id drop not null,
  alter column template_revision drop not null,
  alter column submission_id drop not null,
  alter column form_id drop not null,
  add column source      text    not null default 'generated',
  add column reference   text,
  add column customer_id uuid,
  add column shareable   boolean not null default true,
  add constraint documents_source_known check (source in ('generated', 'uploaded')),
  add constraint documents_reference_length
    check (reference is null or char_length(reference) between 1 and 100),
  add constraint documents_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
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

alter table documents alter column shareable set default false;

comment on column documents.source is
  'generated: made from a submission with a template; uploaded: a PDF a person uploaded (0067).';
comment on column documents.reference is
  'An uploaded document''s reference number, such as a certificate number: what the website lookup finds it by (0067).';
comment on column documents.customer_id is
  'The customer an uploaded document is for, if any: the website lookup''s second match (0067).';
comment on column documents.shareable is
  'Whether the QR code''s link and the company website may show the document. New documents start off; those before 0067 stay on.';

create index documents_customer on documents (tenant_id, customer_id) where customer_id is not null;

-- The staff dashboard lists every switch by its description: say what each of
-- the company website's four switches opens, now that they are told apart.
update feature_flags
   set description = 'Company website: find a document by its reference (and customer), and open its PDF. Only documents the company has made shareable. Off until Integr8 switches it on; the company must switch it on too.'
 where key = 'website_files';
update feature_flags
   set description = 'Company website: one job''s status by its id. Off until Integr8 switches it on; the company must switch it on too.'
 where key = 'website_jobs';
update feature_flags
   set description = 'Company website: one issued quote by its id. Off until Integr8 switches it on; the company must switch it on too.'
 where key = 'website_quotes';
update feature_flags
   set description = 'Company website: one issued invoice by its id. Off until Integr8 switches it on; the company must switch it on too.'
 where key = 'website_invoices';
