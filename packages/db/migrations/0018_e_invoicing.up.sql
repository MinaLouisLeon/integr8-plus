-- Egyptian Tax Authority e-invoicing.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.eta_documents_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE eta_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    document_id uuid,
    kind text NOT NULL,
    outcome text NOT NULL,
    http_status integer,
    error_code text,
    message text,
    correlation_id text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id uuid,
    CONSTRAINT eta_attempts_kind_known CHECK ((kind = ANY (ARRAY['token'::text, 'submit'::text, 'status'::text, 'cancel'::text, 'pdf'::text, 'schema'::text]))),
    CONSTRAINT eta_attempts_outcome_known CHECK ((outcome = ANY (ARRAY['ok'::text, 'accepted'::text, 'rejected'::text, 'error'::text, 'unknown'::text]))),
    CONSTRAINT eta_attempts_text_lengths CHECK (((COALESCE(char_length(error_code), 0) <= 200) AND (COALESCE(char_length(message), 0) <= 1000) AND (COALESCE(char_length(correlation_id), 0) <= 100)))
)
PARTITION BY RANGE (started_at);

CREATE TABLE eta_documents (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    document_kind text DEFAULT 'invoice'::text NOT NULL,
    invoice_id uuid NOT NULL,
    sequence integer NOT NULL,
    environment text NOT NULL,
    internal_id text NOT NULL,
    state text DEFAULT 'ready'::text NOT NULL,
    unsigned_json text NOT NULL,
    canonical_sha256 text NOT NULL,
    signed_json text,
    signer_certificate text,
    signed_by uuid,
    signed_at timestamp with time zone,
    exchange_rate text,
    total_amount text NOT NULL,
    currency_code text NOT NULL,
    eta_uuid text,
    eta_long_id text,
    submission_id text,
    eta_status text,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_error_code text,
    prepared_by uuid NOT NULL,
    prepared_at timestamp with time zone DEFAULT now() NOT NULL,
    submitted_by uuid,
    submitted_at timestamp with time zone,
    final_at timestamp with time zone,
    next_check_at timestamp with time zone,
    checks integer DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eta_documents_digest_shape CHECK ((canonical_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT eta_documents_environment_known CHECK ((environment = ANY (ARRAY['preprod'::text, 'production'::text]))),
    CONSTRAINT eta_documents_errors_list CHECK ((jsonb_typeof(errors) = 'array'::text)),
    CONSTRAINT eta_documents_kind_known CHECK ((document_kind = 'invoice'::text)),
    CONSTRAINT eta_documents_sequence_positive CHECK ((sequence > 0)),
    CONSTRAINT eta_documents_signed_before_submission CHECK (((state = ANY (ARRAY['ready'::text, 'pending_signature'::text, 'superseded'::text])) OR (signed_json IS NOT NULL))),
    CONSTRAINT eta_documents_signed_complete CHECK ((((signed_json IS NULL) = (signed_at IS NULL)) AND ((signed_json IS NULL) = (signer_certificate IS NULL)) AND ((signed_json IS NULL) = (signed_by IS NULL)))),
    CONSTRAINT eta_documents_signer_shape CHECK (((signer_certificate IS NULL) OR (signer_certificate ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT eta_documents_state_known CHECK ((state = ANY (ARRAY['ready'::text, 'pending_signature'::text, 'signed'::text, 'submitting'::text, 'submitted'::text, 'valid'::text, 'invalid'::text, 'rejected'::text, 'cancelled'::text, 'failed'::text, 'unknown'::text, 'superseded'::text]))),
    CONSTRAINT eta_documents_version_positive CHECK ((version > 0))
);

CREATE TABLE eta_item_codes (
    tenant_id uuid NOT NULL,
    item_id uuid NOT NULL,
    item_type text NOT NULL,
    item_code text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eta_item_codes_code_shape CHECK (((char_length(item_code) >= 1) AND (char_length(item_code) <= 100))),
    CONSTRAINT eta_item_codes_type_known CHECK ((item_type = ANY (ARRAY['GS1'::text, 'EGS'::text])))
);

CREATE TABLE eta_receivers (
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    receiver_type text NOT NULL,
    receiver_id text,
    address_country text,
    address_governate text,
    address_region_city text,
    address_street text,
    address_building_number text,
    address_postal_code text,
    address_floor text,
    address_room text,
    address_landmark text,
    address_additional text,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eta_receivers_text_lengths CHECK (((COALESCE(char_length(receiver_id), 0) <= 30) AND (COALESCE(char_length(address_country), 0) <= 2) AND (COALESCE(char_length(address_governate), 0) <= 100) AND (COALESCE(char_length(address_region_city), 0) <= 100) AND (COALESCE(char_length(address_street), 0) <= 200) AND (COALESCE(char_length(address_building_number), 0) <= 100) AND (COALESCE(char_length(address_postal_code), 0) <= 30) AND (COALESCE(char_length(address_floor), 0) <= 30) AND (COALESCE(char_length(address_room), 0) <= 30) AND (COALESCE(char_length(address_landmark), 0) <= 200) AND (COALESCE(char_length(address_additional), 0) <= 500))),
    CONSTRAINT eta_receivers_type_known CHECK ((receiver_type = ANY (ARRAY['B'::text, 'P'::text, 'F'::text])))
);

CREATE TABLE eta_schemas (
    tenant_id uuid NOT NULL,
    environment text NOT NULL,
    document_type text NOT NULL,
    type_version text NOT NULL,
    eta_type_id text NOT NULL,
    eta_version_id text NOT NULL,
    schema_text text NOT NULL,
    schema_sha256 text NOT NULL,
    fetched_by uuid NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eta_schemas_environment_known CHECK ((environment = ANY (ARRAY['preprod'::text, 'production'::text]))),
    CONSTRAINT eta_schemas_sha_shape CHECK ((schema_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT eta_schemas_size CHECK ((octet_length(schema_text) <= 2000000))
);

CREATE TABLE eta_settings (
    tenant_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    environment text DEFAULT 'preprod'::text NOT NULL,
    issuer_type text DEFAULT 'B'::text NOT NULL,
    taxpayer_id text,
    issuer_name text,
    branch_id text,
    activity_code text,
    address_country text,
    address_governate text,
    address_region_city text,
    address_street text,
    address_building_number text,
    address_postal_code text,
    address_floor text,
    address_room text,
    address_landmark text,
    address_additional text,
    client_id_sealed text,
    client_secret_sealed text,
    credentials_hint text,
    credentials_version integer DEFAULT 0 NOT NULL,
    credentials_updated_at timestamp with time zone,
    credentials_updated_by uuid,
    intermediary_for text,
    document_type_version text DEFAULT '1.0'::text NOT NULL,
    default_item_type text,
    default_item_code text,
    pinned_certificates text[] DEFAULT '{}'::text[] NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eta_settings_credentials_paired CHECK ((((client_id_sealed IS NULL) = (client_secret_sealed IS NULL)) AND ((client_id_sealed IS NULL) = (credentials_hint IS NULL)))),
    CONSTRAINT eta_settings_default_item_paired CHECK (((default_item_type IS NULL) = (default_item_code IS NULL))),
    CONSTRAINT eta_settings_default_item_type_known CHECK (((default_item_type IS NULL) OR (default_item_type = ANY (ARRAY['GS1'::text, 'EGS'::text])))),
    CONSTRAINT eta_settings_environment_known CHECK ((environment = ANY (ARRAY['preprod'::text, 'production'::text]))),
    CONSTRAINT eta_settings_issuer_type_known CHECK ((issuer_type = ANY (ARRAY['B'::text, 'P'::text, 'F'::text]))),
    CONSTRAINT eta_settings_pins_shape CHECK (((cardinality(pinned_certificates) <= 10) AND (array_to_string(pinned_certificates, ','::text) ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'::text))),
    CONSTRAINT eta_settings_text_lengths CHECK (((COALESCE(char_length(taxpayer_id), 0) <= 30) AND (COALESCE(char_length(issuer_name), 0) <= 200) AND (COALESCE(char_length(branch_id), 0) <= 50) AND (COALESCE(char_length(activity_code), 0) <= 20) AND (COALESCE(char_length(address_country), 0) <= 2) AND (COALESCE(char_length(address_governate), 0) <= 100) AND (COALESCE(char_length(address_region_city), 0) <= 100) AND (COALESCE(char_length(address_street), 0) <= 200) AND (COALESCE(char_length(address_building_number), 0) <= 100) AND (COALESCE(char_length(address_postal_code), 0) <= 30) AND (COALESCE(char_length(address_floor), 0) <= 30) AND (COALESCE(char_length(address_room), 0) <= 30) AND (COALESCE(char_length(address_landmark), 0) <= 200) AND (COALESCE(char_length(address_additional), 0) <= 500) AND (COALESCE(char_length(intermediary_for), 0) <= 30) AND (COALESCE(char_length(default_item_code), 0) <= 100) AND ((char_length(document_type_version) >= 1) AND (char_length(document_type_version) <= 10)))),
    CONSTRAINT eta_settings_version_positive CHECK ((version > 0))
);

CREATE TABLE eta_signing_requests (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    document_id uuid NOT NULL,
    digest text NOT NULL,
    nonce text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    requested_by uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    claimed_by uuid,
    claimed_at timestamp with time zone,
    finished_at timestamp with time zone,
    failure text,
    CONSTRAINT eta_signing_requests_claim_complete CHECK (((claimed_by IS NULL) = (claimed_at IS NULL))),
    CONSTRAINT eta_signing_requests_digest_shape CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT eta_signing_requests_expiry_after CHECK ((expires_at > requested_at)),
    CONSTRAINT eta_signing_requests_failure_length CHECK ((COALESCE(char_length(failure), 0) <= 200)),
    CONSTRAINT eta_signing_requests_nonce_shape CHECK ((nonce ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT eta_signing_requests_status_known CHECK ((status = ANY (ARRAY['open'::text, 'claimed'::text, 'completed'::text, 'cancelled'::text, 'expired'::text])))
);

CREATE TABLE eta_tax_mappings (
    tenant_id uuid NOT NULL,
    tax_rate_bp integer NOT NULL,
    tax_type text NOT NULL,
    sub_type text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eta_tax_mappings_codes_shape CHECK ((((char_length(tax_type) >= 1) AND (char_length(tax_type) <= 30)) AND ((char_length(sub_type) >= 1) AND (char_length(sub_type) <= 30)))),
    CONSTRAINT eta_tax_mappings_rate_range CHECK (((tax_rate_bp >= 0) AND (tax_rate_bp <= 10000)))
);

CREATE TABLE eta_unit_types (
    tenant_id uuid NOT NULL,
    unit text NOT NULL,
    eta_unit_type text NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eta_unit_types_code_shape CHECK (((char_length(eta_unit_type) >= 1) AND (char_length(eta_unit_type) <= 30))),
    CONSTRAINT eta_unit_types_unit_known CHECK ((unit = ANY (ARRAY['each'::text, 'pair'::text, 'set'::text, 'box'::text, 'pack'::text, 'roll'::text, 'm'::text, 'm2'::text, 'm3'::text, 'l'::text, 'kg'::text, 'g'::text, 'hour'::text])))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE eta_attempts
    ADD CONSTRAINT eta_attempts_pkey PRIMARY KEY (tenant_id, id, started_at);

ALTER TABLE ONLY eta_documents
    ADD CONSTRAINT eta_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY eta_documents
    ADD CONSTRAINT eta_documents_sequence_unique UNIQUE (tenant_id, invoice_id, sequence);

ALTER TABLE ONLY eta_documents
    ADD CONSTRAINT eta_documents_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY eta_item_codes
    ADD CONSTRAINT eta_item_codes_pkey PRIMARY KEY (tenant_id, item_id);

ALTER TABLE ONLY eta_receivers
    ADD CONSTRAINT eta_receivers_pkey PRIMARY KEY (tenant_id, customer_id);

ALTER TABLE ONLY eta_schemas
    ADD CONSTRAINT eta_schemas_pkey PRIMARY KEY (tenant_id, environment, document_type, type_version);

ALTER TABLE ONLY eta_settings
    ADD CONSTRAINT eta_settings_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY eta_signing_requests
    ADD CONSTRAINT eta_signing_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY eta_signing_requests
    ADD CONSTRAINT eta_signing_requests_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY eta_tax_mappings
    ADD CONSTRAINT eta_tax_mappings_pkey PRIMARY KEY (tenant_id, tax_rate_bp);

ALTER TABLE ONLY eta_unit_types
    ADD CONSTRAINT eta_unit_types_pkey PRIMARY KEY (tenant_id, unit);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX eta_attempts_by_document ON eta_attempts USING btree (tenant_id, document_id, started_at DESC);

CREATE INDEX eta_attempts_recent ON eta_attempts USING btree (tenant_id, started_at DESC);

CREATE INDEX eta_documents_by_state ON eta_documents USING btree (tenant_id, state, prepared_at DESC);

CREATE INDEX eta_documents_due_check ON eta_documents USING btree (next_check_at) WHERE (state = 'submitted'::text);

CREATE UNIQUE INDEX eta_documents_one_live ON eta_documents USING btree (tenant_id, invoice_id) WHERE (state <> ALL (ARRAY['superseded'::text, 'invalid'::text, 'rejected'::text, 'cancelled'::text]));

CREATE UNIQUE INDEX eta_signing_requests_one_open ON eta_signing_requests USING btree (tenant_id, document_id) WHERE (status = ANY (ARRAY['open'::text, 'claimed'::text]));

CREATE INDEX eta_signing_requests_queue ON eta_signing_requests USING btree (tenant_id, status, requested_at);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE eta_attempts
    ADD CONSTRAINT eta_attempts_document_fk FOREIGN KEY (tenant_id, document_id) REFERENCES eta_documents(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE eta_attempts
    ADD CONSTRAINT eta_attempts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_documents
    ADD CONSTRAINT eta_documents_invoice_fk FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp_invoices(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_documents
    ADD CONSTRAINT eta_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_item_codes
    ADD CONSTRAINT eta_item_codes_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_item_codes
    ADD CONSTRAINT eta_item_codes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_receivers
    ADD CONSTRAINT eta_receivers_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_receivers
    ADD CONSTRAINT eta_receivers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_schemas
    ADD CONSTRAINT eta_schemas_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_settings
    ADD CONSTRAINT eta_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_signing_requests
    ADD CONSTRAINT eta_signing_requests_document_fk FOREIGN KEY (tenant_id, document_id) REFERENCES eta_documents(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY eta_signing_requests
    ADD CONSTRAINT eta_signing_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_tax_mappings
    ADD CONSTRAINT eta_tax_mappings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY eta_unit_types
    ADD CONSTRAINT eta_unit_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER eta_documents_guard BEFORE UPDATE ON eta_documents FOR EACH ROW EXECUTE FUNCTION eta_documents_guard();

CREATE TRIGGER eta_documents_set_updated_at BEFORE UPDATE ON eta_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER eta_settings_set_updated_at BEFORE UPDATE ON eta_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE eta_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE eta_documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE eta_item_codes ENABLE ROW LEVEL SECURITY;

ALTER TABLE eta_receivers ENABLE ROW LEVEL SECURITY;

ALTER TABLE eta_schemas ENABLE ROW LEVEL SECURITY;

ALTER TABLE eta_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE eta_signing_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE eta_tax_mappings ENABLE ROW LEVEL SECURITY;

ALTER TABLE eta_unit_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY eta_attempts_isolation ON eta_attempts TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY eta_documents_isolation ON eta_documents TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY eta_item_codes_isolation ON eta_item_codes TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY eta_receivers_isolation ON eta_receivers TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY eta_schemas_isolation ON eta_schemas TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY eta_settings_isolation ON eta_settings TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY eta_signing_requests_isolation ON eta_signing_requests TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY eta_tax_mappings_isolation ON eta_tax_mappings TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY eta_unit_types_isolation ON eta_unit_types TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON TABLE eta_attempts IS 'Every call to the ETA, with its outcome (ADR-0014). Redacted: no tokens, secrets or document bodies.';

COMMENT ON TABLE eta_documents IS 'Immutable ETA documents made from issued invoices, and their state with the ETA (ADR-0014). The invoice is never changed.';

COMMENT ON TABLE eta_item_codes IS 'An item''s ETA code (GS1 or EGS), as the company registered it (ADR-0014).';

COMMENT ON TABLE eta_receivers IS 'A customer''s tax identity for e-invoices (ADR-0014).';

COMMENT ON TABLE eta_schemas IS 'The ETA''s JSON Schema for a document type version, fetched with the company''s own credentials (ADR-0014 D6).';

COMMENT ON TABLE eta_settings IS 'A company''s e-invoicing settings (ADR-0014). Credentials are sealed by the API and never returned.';

COMMENT ON TABLE eta_signing_requests IS 'What the company''s signing agent is asked to sign (ADR-0014, PLAN §4).';

COMMENT ON TABLE eta_tax_mappings IS 'A tax rate on invoice lines and the ETA tax type and subtype the company chose for it (ADR-0014).';

COMMENT ON TABLE eta_unit_types IS 'An Integr8 unit and the ETA unit type the company chose for it (ADR-0014). Never guessed.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT ON TABLE eta_attempts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_attempts TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE eta_documents TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_documents TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_item_codes TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_item_codes TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_receivers TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_receivers TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_schemas TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_schemas TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_settings TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_settings TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE eta_signing_requests TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_signing_requests TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_tax_mappings TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_tax_mappings TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_unit_types TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE eta_unit_types TO integr8_platform;

-- ---------------------------------------------------------------------------
-- Year partitions for the tables above (see 0001)
-- ---------------------------------------------------------------------------

SELECT ensure_year_partitions();
