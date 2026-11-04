-- 0075 — what a company's apps show, where its document links point, and
-- searchable fields on uploaded documents. All expand-only.
--
-- 1. `show_company_name`: whether the menu, the dashboard and the sign-in page
--    print the company's name beside its logo. A logo that already spells the
--    name looks doubled with it. On by default, so every company looks as it
--    did; the apps ignore it while there is no logo, so a company never ends
--    up as a single letter. Set on the staff-only branding screen.
--
-- 2. `hidden_nav_sections`: the menu tabs Integr8 staff switched off for this
--    company, by their navigation keys (`@integr8/core` NAV_SECTIONS). The web,
--    desktop and phone apps leave them out and refuse their pages; the data
--    stays reachable, as the module switches are what guard it. Empty by
--    default: every tab the company's modules and roles allow is shown.
--
-- 3. `document_link_pattern`: where a document's QR code and shared link point,
--    an https address with `{code}` in it on the company's own website, such as
--    `https://example.com/documents/{code}`. Null keeps Integr8's own
--    `/d/<code>` page. Codes already printed keep working there either way.
--
-- 4. `document_field_values.lookup_role` may be `search`: a field a person
--    typed on an uploaded document. The website's one-box search finds a
--    document by its key or by any of these, never by the confirming field
--    (the customer name), so typing a customer's name lists nothing.
--
-- 5. The share QR code (0075): a document's own QR code is printed only once the
--    document is shared. `qr_spot`: the document has a place for it (its
--    template has a share QR block, or an uploaded PDF was given a position).
--    `qr_printed`: the file served now carries it. Sharing a document with a
--    spot and no code re-prints it; stopping sharing keeps the code. Every
--    document made before keeps the code it was printed with, so it counts as
--    printed. `printed_design` keeps the design a document was printed from, so
--    a re-print matches it exactly. An uploaded PDF's `qr_placement` is where
--    the code goes (page, position and size as fractions of the page), and
--    `original_file_id` the PDF as uploaded, kept beside the stamped copy.
--
-- The previous release keeps working on this schema: it never reads or writes
-- the new columns, and it never writes the new role.

alter table tenant_settings
  add column show_company_name     boolean not null default true,
  add column hidden_nav_sections   text[]  not null default '{}',
  add column document_link_pattern text,
  add constraint tenant_settings_hidden_nav_sections_size
    check (cardinality(hidden_nav_sections) <= 200),
  add constraint tenant_settings_document_link_pattern_shape
    check (
      document_link_pattern is null
      or (
        document_link_pattern ~ '^https://[^\s/?#]+'
        and position('{code}' in document_link_pattern) > 0
        and char_length(document_link_pattern) <= 500
      )
    );

comment on column tenant_settings.show_company_name is
  'Whether the apps print the company name beside its logo; ignored without a logo (0075).';
comment on column tenant_settings.hidden_nav_sections is
  'Navigation keys of the tabs Integr8 staff switched off for this company (0075).';
comment on column tenant_settings.document_link_pattern is
  'https address with {code} on the company website that document links open; null for Integr8''s /d/ page (0075).';

alter table documents
  add column qr_spot          boolean not null default false,
  add column qr_printed       boolean not null default false,
  add column printed_design   jsonb,
  add column qr_placement     jsonb,
  add column original_file_id uuid,
  add constraint documents_original_file_fk
    foreign key (tenant_id, original_file_id) references files (tenant_id, id) on delete restrict,
  add constraint documents_qr_placement_uploaded
    check (qr_placement is null or source = 'uploaded');

update documents set qr_printed = true;

comment on column documents.qr_spot is
  'The document has a place for its share QR code: printed only once shared (0075).';
comment on column documents.qr_printed is
  'The file served now carries the share QR code (0075).';
comment on column documents.printed_design is
  'The template design the document was printed from, for an identical re-print (0075).';
comment on column documents.qr_placement is
  'Uploaded PDF: where its share QR code is stamped, { page, x, y, size } as page fractions (0075).';
comment on column documents.original_file_id is
  'Uploaded PDF: the file as uploaded, when the served file is a stamped copy (0075).';

alter table document_field_values
  drop constraint document_field_values_lookup_role_known,
  add constraint document_field_values_lookup_role_known
    check (lookup_role is null or lookup_role in ('key', 'confirm', 'search'));
