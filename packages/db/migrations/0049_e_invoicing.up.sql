-- Egyptian e-invoicing with the Tax Authority (ETA): ADR-0014, docs/e-invoicing.
--
--   eta_settings          one row per company: switch, environment, issuer,
--                         sealed credentials, pinned signing certificates
--   eta_receivers         a customer's tax identity and structured address
--   eta_item_codes        an item's GS1 or EGS code
--   eta_unit_types        Integr8 unit -> ETA unit type, per company
--   eta_tax_mappings      tax rate (basis points) -> ETA tax type and subtype
--   eta_documents         immutable snapshots made from issued invoices, and
--                         their state with the ETA
--   eta_attempts          every call to the ETA about a document, with outcome
--   eta_signing_requests  what the signing agent is asked to sign, and when
--   eta_schemas           the ETA's JSON Schema, fetched with the company's
--                         own credentials, per environment
--
-- Nothing here changes an invoice. Credentials are sealed by the API
-- (AES-256-GCM, ETA_CREDENTIALS_KEY) and never readable in the clear here.
-- Every table is company data under the usual isolation policy.

insert into feature_flags (key, description, default_enabled)
values
  ('e_invoicing',
   'E-invoicing: sending the company''s issued invoices to the Egyptian Tax Authority, signed on the company''s own computer. Needs finance. Off until Integr8 switches it on for a company.',
   false);

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table eta_settings (
  tenant_id                uuid        primary key references tenants (id) on delete restrict,
  -- The company's own switch, beside the module flag.
  enabled                  boolean     not null default false,
  environment              text        not null default 'preprod',
  -- The issuer as registered with the ETA.
  issuer_type              text        not null default 'B',
  taxpayer_id              text,
  issuer_name              text,
  branch_id                text,
  activity_code            text,
  address_country          text,
  address_governate        text,
  address_region_city      text,
  address_street           text,
  address_building_number  text,
  address_postal_code      text,
  address_floor            text,
  address_room             text,
  address_landmark         text,
  address_additional       text,
  -- Sealed by the API; never returned. The hint is the client id's last four.
  client_id_sealed         text,
  client_secret_sealed     text,
  credentials_hint         text,
  credentials_version      integer     not null default 0,
  credentials_updated_at   timestamptz,
  credentials_updated_by   uuid,
  -- Only for an intermediary login: the taxpayer acted for.
  intermediary_for         text,
  document_type_version    text        not null default '1.0',
  -- For lines whose item has no code of its own (labour, blank lines).
  default_item_type        text,
  default_item_code        text,
  -- SHA-256 (hex) of each certificate allowed to sign for the company.
  pinned_certificates      text[]      not null default '{}',
  version                  integer     not null default 1,
  updated_by               uuid,
  updated_at               timestamptz not null default now(),

  constraint eta_settings_environment_known check (environment in ('preprod', 'production')),
  constraint eta_settings_issuer_type_known check (issuer_type in ('B', 'P', 'F')),
  constraint eta_settings_credentials_paired check (
    (client_id_sealed is null) = (client_secret_sealed is null)
    and (client_id_sealed is null) = (credentials_hint is null)),
  constraint eta_settings_default_item_paired check ((default_item_type is null) = (default_item_code is null)),
  constraint eta_settings_default_item_type_known check (default_item_type is null or default_item_type in ('GS1', 'EGS')),
  constraint eta_settings_pins_shape check (
    cardinality(pinned_certificates) <= 10
    and array_to_string(pinned_certificates, ',') ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'),
  constraint eta_settings_text_lengths check (
    coalesce(char_length(taxpayer_id), 0) <= 30
    and coalesce(char_length(issuer_name), 0) <= 200
    and coalesce(char_length(branch_id), 0) <= 50
    and coalesce(char_length(activity_code), 0) <= 20
    and coalesce(char_length(address_country), 0) <= 2
    and coalesce(char_length(address_governate), 0) <= 100
    and coalesce(char_length(address_region_city), 0) <= 100
    and coalesce(char_length(address_street), 0) <= 200
    and coalesce(char_length(address_building_number), 0) <= 100
    and coalesce(char_length(address_postal_code), 0) <= 30
    and coalesce(char_length(address_floor), 0) <= 30
    and coalesce(char_length(address_room), 0) <= 30
    and coalesce(char_length(address_landmark), 0) <= 200
    and coalesce(char_length(address_additional), 0) <= 500
    and coalesce(char_length(intermediary_for), 0) <= 30
    and coalesce(char_length(default_item_code), 0) <= 100
    and char_length(document_type_version) between 1 and 10),
  constraint eta_settings_version_positive check (version > 0)
);
comment on table eta_settings is
  'A company''s e-invoicing settings (ADR-0014). Credentials are sealed by the API and never returned.';

create trigger eta_settings_set_updated_at
  before update on eta_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Receivers, item codes, unit and tax mappings
-- ---------------------------------------------------------------------------

create table eta_receivers (
  tenant_id                uuid        not null references tenants (id) on delete restrict,
  customer_id              uuid        not null,
  receiver_type            text        not null,
  -- Registration number (B), national id (P), passport or foreign id (F).
  receiver_id              text,
  address_country          text,
  address_governate        text,
  address_region_city      text,
  address_street           text,
  address_building_number  text,
  address_postal_code      text,
  address_floor            text,
  address_room             text,
  address_landmark         text,
  address_additional       text,
  updated_by               uuid        not null,
  updated_at               timestamptz not null default now(),

  constraint eta_receivers_pkey primary key (tenant_id, customer_id),
  constraint eta_receivers_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint eta_receivers_type_known check (receiver_type in ('B', 'P', 'F')),
  constraint eta_receivers_text_lengths check (
    coalesce(char_length(receiver_id), 0) <= 30
    and coalesce(char_length(address_country), 0) <= 2
    and coalesce(char_length(address_governate), 0) <= 100
    and coalesce(char_length(address_region_city), 0) <= 100
    and coalesce(char_length(address_street), 0) <= 200
    and coalesce(char_length(address_building_number), 0) <= 100
    and coalesce(char_length(address_postal_code), 0) <= 30
    and coalesce(char_length(address_floor), 0) <= 30
    and coalesce(char_length(address_room), 0) <= 30
    and coalesce(char_length(address_landmark), 0) <= 200
    and coalesce(char_length(address_additional), 0) <= 500)
);
comment on table eta_receivers is 'A customer''s tax identity for e-invoices (ADR-0014).';

create table eta_item_codes (
  tenant_id   uuid        not null references tenants (id) on delete restrict,
  item_id     uuid        not null,
  item_type   text        not null,
  item_code   text        not null,
  updated_by  uuid        not null,
  updated_at  timestamptz not null default now(),

  constraint eta_item_codes_pkey primary key (tenant_id, item_id),
  constraint eta_item_codes_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint eta_item_codes_type_known check (item_type in ('GS1', 'EGS')),
  constraint eta_item_codes_code_shape check (char_length(item_code) between 1 and 100)
);
comment on table eta_item_codes is 'An item''s ETA code (GS1 or EGS), as the company registered it (ADR-0014).';

create table eta_unit_types (
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  unit           text        not null,
  eta_unit_type  text        not null,
  updated_by     uuid        not null,
  updated_at     timestamptz not null default now(),

  constraint eta_unit_types_pkey primary key (tenant_id, unit),
  constraint eta_unit_types_unit_known
    check (unit in ('each', 'pair', 'set', 'box', 'pack', 'roll', 'm', 'm2', 'm3', 'l', 'kg', 'g', 'hour')),
  constraint eta_unit_types_code_shape check (char_length(eta_unit_type) between 1 and 30)
);
comment on table eta_unit_types is 'An Integr8 unit and the ETA unit type the company chose for it (ADR-0014). Never guessed.';

create table eta_tax_mappings (
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  tax_rate_bp  integer     not null,
  tax_type     text        not null,
  sub_type     text        not null,
  updated_by   uuid        not null,
  updated_at   timestamptz not null default now(),

  constraint eta_tax_mappings_pkey primary key (tenant_id, tax_rate_bp),
  constraint eta_tax_mappings_rate_range check (tax_rate_bp between 0 and 10000),
  constraint eta_tax_mappings_codes_shape
    check (char_length(tax_type) between 1 and 30 and char_length(sub_type) between 1 and 30)
);
comment on table eta_tax_mappings is 'A tax rate on invoice lines and the ETA tax type and subtype the company chose for it (ADR-0014).';

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

create table eta_documents (
  id                  uuid        primary key,
  tenant_id           uuid        not null references tenants (id) on delete restrict,
  document_kind       text        not null default 'invoice',
  invoice_id          uuid        not null,
  -- Each preparation of the same invoice: 1, 2, …
  sequence            integer     not null,
  environment         text        not null,
  internal_id         text        not null,
  state               text        not null default 'ready',
  -- The unsigned document as sent to the signer, exactly; and its canonical digest.
  unsigned_json       text        not null,
  canonical_sha256    text        not null,
  -- The signed document exactly as submitted, once signed.
  signed_json         text,
  signer_certificate  text,
  signed_by           uuid,
  signed_at           timestamptz,
  -- EGP per unit of the invoice's currency, when it is not EGP.
  exchange_rate       text,
  -- For lists: what the document adds up to, as written in it.
  total_amount        text        not null,
  currency_code       text        not null,
  -- From the ETA.
  eta_uuid            text,
  eta_long_id         text,
  submission_id       text,
  eta_status          text,
  errors              jsonb       not null default '[]',
  last_error_code     text,
  prepared_by         uuid        not null,
  prepared_at         timestamptz not null default now(),
  submitted_by        uuid,
  submitted_at        timestamptz,
  final_at            timestamptz,
  next_check_at       timestamptz,
  checks              integer     not null default 0,
  version             integer     not null default 1,
  updated_at          timestamptz not null default now(),

  constraint eta_documents_tenant_id_unique unique (tenant_id, id),
  constraint eta_documents_sequence_unique unique (tenant_id, invoice_id, sequence),
  constraint eta_documents_invoice_fk
    foreign key (tenant_id, invoice_id) references erp_invoices (tenant_id, id) on delete restrict,
  constraint eta_documents_kind_known check (document_kind in ('invoice')),
  constraint eta_documents_environment_known check (environment in ('preprod', 'production')),
  constraint eta_documents_state_known check (state in (
    'ready', 'pending_signature', 'signed', 'submitting', 'submitted', 'valid', 'invalid',
    'rejected', 'cancelled', 'failed', 'unknown', 'superseded')),
  constraint eta_documents_digest_shape check (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  constraint eta_documents_signer_shape check (signer_certificate is null or signer_certificate ~ '^[0-9a-f]{64}$'),
  constraint eta_documents_signed_complete check (
    (signed_json is null) = (signed_at is null)
    and (signed_json is null) = (signer_certificate is null)
    and (signed_json is null) = (signed_by is null)),
  -- Nothing past signing without a signed document (ADR-0014 D6).
  constraint eta_documents_signed_before_submission check (
    state in ('ready', 'pending_signature', 'superseded') or signed_json is not null),
  constraint eta_documents_errors_list check (jsonb_typeof(errors) = 'array'),
  constraint eta_documents_sequence_positive check (sequence > 0),
  constraint eta_documents_version_positive check (version > 0)
);
comment on table eta_documents is
  'Immutable ETA documents made from issued invoices, and their state with the ETA (ADR-0014). The invoice is never changed.';

-- One live document per invoice: everything else is superseded or finished badly.
create unique index eta_documents_one_live
  on eta_documents (tenant_id, invoice_id)
  where state not in ('superseded', 'invalid', 'rejected', 'cancelled');
create index eta_documents_by_state on eta_documents (tenant_id, state, prepared_at desc);
create index eta_documents_due_check on eta_documents (next_check_at) where state = 'submitted';

create trigger eta_documents_set_updated_at
  before update on eta_documents
  for each row execute function set_updated_at();

-- The snapshot never changes; the signed text is written once.
create function eta_documents_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if new.unsigned_json is distinct from old.unsigned_json
     or new.canonical_sha256 is distinct from old.canonical_sha256
     or new.invoice_id is distinct from old.invoice_id
     or new.document_kind is distinct from old.document_kind
     or new.environment is distinct from old.environment
     or new.internal_id is distinct from old.internal_id
     or new.sequence is distinct from old.sequence
     or new.total_amount is distinct from old.total_amount
     or new.currency_code is distinct from old.currency_code
     or new.exchange_rate is distinct from old.exchange_rate then
    raise exception 'An ETA document''s snapshot does not change'
      using errcode = 'check_violation', constraint = 'eta_documents_snapshot_fixed';
  end if;
  if old.signed_json is not null and new.signed_json is distinct from old.signed_json then
    raise exception 'A signed ETA document keeps its signature'
      using errcode = 'check_violation', constraint = 'eta_documents_signature_fixed';
  end if;
  return new;
end;
$$;

create trigger eta_documents_guard
  before update on eta_documents
  for each row execute function eta_documents_guard();

create table eta_attempts (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete restrict,
  document_id      uuid,
  kind             text        not null,
  outcome          text        not null,
  http_status      integer,
  error_code       text,
  -- A short, redacted message: never a token, a secret or a document body.
  message          text,
  correlation_id   text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz not null default now(),
  actor_id         uuid,

  constraint eta_attempts_document_fk
    foreign key (tenant_id, document_id) references eta_documents (tenant_id, id) on delete cascade,
  constraint eta_attempts_kind_known check (kind in ('token', 'submit', 'status', 'cancel', 'pdf', 'schema')),
  constraint eta_attempts_outcome_known check (outcome in ('ok', 'accepted', 'rejected', 'error', 'unknown')),
  constraint eta_attempts_text_lengths check (
    coalesce(char_length(error_code), 0) <= 200
    and coalesce(char_length(message), 0) <= 1000
    and coalesce(char_length(correlation_id), 0) <= 100)
);
comment on table eta_attempts is 'Every call to the ETA, with its outcome (ADR-0014). Redacted: no tokens, secrets or document bodies.';

create index eta_attempts_by_document on eta_attempts (tenant_id, document_id, started_at desc);
create index eta_attempts_recent on eta_attempts (tenant_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Signing requests
-- ---------------------------------------------------------------------------

create table eta_signing_requests (
  id            uuid        primary key,
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  document_id   uuid        not null,
  -- The canonical digest the signature must cover, copied from the document.
  digest        text        not null,
  -- 32 random bytes, hex: returned with the signature, used once.
  nonce         text        not null,
  status        text        not null default 'open',
  requested_by  uuid        not null,
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  claimed_by    uuid,
  claimed_at    timestamptz,
  finished_at   timestamptz,
  failure       text,

  constraint eta_signing_requests_tenant_id_unique unique (tenant_id, id),
  constraint eta_signing_requests_document_fk
    foreign key (tenant_id, document_id) references eta_documents (tenant_id, id) on delete cascade,
  constraint eta_signing_requests_status_known
    check (status in ('open', 'claimed', 'completed', 'cancelled', 'expired')),
  constraint eta_signing_requests_digest_shape check (digest ~ '^[0-9a-f]{64}$'),
  constraint eta_signing_requests_nonce_shape check (nonce ~ '^[0-9a-f]{64}$'),
  constraint eta_signing_requests_claim_complete check ((claimed_by is null) = (claimed_at is null)),
  constraint eta_signing_requests_expiry_after check (expires_at > requested_at),
  constraint eta_signing_requests_failure_length check (coalesce(char_length(failure), 0) <= 200)
);
comment on table eta_signing_requests is 'What the company''s signing agent is asked to sign (ADR-0014, PLAN §4).';

create unique index eta_signing_requests_one_open
  on eta_signing_requests (tenant_id, document_id) where status in ('open', 'claimed');
create index eta_signing_requests_queue on eta_signing_requests (tenant_id, status, requested_at);

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------

create table eta_schemas (
  tenant_id         uuid        not null references tenants (id) on delete restrict,
  environment       text        not null,
  document_type     text        not null,
  type_version      text        not null,
  -- The ETA's ids for the type and the version, as its API listed them.
  eta_type_id       text        not null,
  eta_version_id    text        not null,
  schema_text       text        not null,
  schema_sha256     text        not null,
  fetched_by        uuid        not null,
  fetched_at        timestamptz not null default now(),

  constraint eta_schemas_pkey primary key (tenant_id, environment, document_type, type_version),
  constraint eta_schemas_environment_known check (environment in ('preprod', 'production')),
  constraint eta_schemas_sha_shape check (schema_sha256 ~ '^[0-9a-f]{64}$'),
  constraint eta_schemas_size check (octet_length(schema_text) <= 2000000)
);
comment on table eta_schemas is 'The ETA''s JSON Schema for a document type version, fetched with the company''s own credentials (ADR-0014 D6).';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on eta_settings to integr8_app;
grant select, insert, update, delete on eta_receivers to integr8_app;
grant select, insert, update, delete on eta_item_codes to integr8_app;
grant select, insert, update, delete on eta_unit_types to integr8_app;
grant select, insert, update, delete on eta_tax_mappings to integr8_app;
grant select, insert, update on eta_documents to integr8_app;
grant select, insert on eta_attempts to integr8_app;
grant select, insert, update on eta_signing_requests to integr8_app;
grant select, insert, update, delete on eta_schemas to integr8_app;

alter table eta_settings enable row level security;
alter table eta_receivers enable row level security;
alter table eta_item_codes enable row level security;
alter table eta_unit_types enable row level security;
alter table eta_tax_mappings enable row level security;
alter table eta_documents enable row level security;
alter table eta_attempts enable row level security;
alter table eta_signing_requests enable row level security;
alter table eta_schemas enable row level security;

create policy eta_settings_isolation on eta_settings for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy eta_receivers_isolation on eta_receivers for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy eta_item_codes_isolation on eta_item_codes for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy eta_unit_types_isolation on eta_unit_types for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy eta_tax_mappings_isolation on eta_tax_mappings for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy eta_documents_isolation on eta_documents for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy eta_attempts_isolation on eta_attempts for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy eta_signing_requests_isolation on eta_signing_requests for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
create policy eta_schemas_isolation on eta_schemas for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
