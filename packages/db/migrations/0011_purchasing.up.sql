-- Suppliers, purchase orders, goods receipts, supplier prices and van requests.
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

CREATE FUNCTION public.assign_purchase_order_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  insert into public.erp_purchase_order_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;

CREATE FUNCTION public.erp_purchase_order_lines_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  order_status text;
begin
  select status into order_status
    from erp_purchase_orders
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.order_id, old.order_id);
  if order_status = 'draft' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and new.order_id = old.order_id and new.position = old.position and new.item_id = old.item_id
     and new.description = old.description and new.quantity_ordered = old.quantity_ordered
     and new.unit_price = old.unit_price and new.tax_rate_bp = old.tax_rate_bp then
    return new;
  end if;
  raise exception 'An approved purchase order''s lines do not change'
    using errcode = 'check_violation', constraint = 'erp_purchase_order_lines_frozen';
end;
$$;

CREATE FUNCTION public.erp_work_order_purchases_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if new.item_id is not null and exists (
    select 1 from erp_items i where i.tenant_id = new.tenant_id and i.id = new.item_id and i.kind = 'stock_item'
  ) then
    raise exception 'A part bought for a job is not a stock item'
      using errcode = 'check_violation', constraint = 'erp_work_order_purchases_not_stock';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE erp_goods_receipt_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    order_line_id uuid NOT NULL,
    quantity numeric(20,4) NOT NULL,
    unit_cost numeric(20,4) NOT NULL,
    returned_quantity numeric(20,4) DEFAULT 0 NOT NULL,
    CONSTRAINT erp_goods_receipt_lines_cost_not_negative CHECK ((unit_cost >= (0)::numeric)),
    CONSTRAINT erp_goods_receipt_lines_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT erp_goods_receipt_lines_returned_range CHECK (((returned_quantity >= (0)::numeric) AND (returned_quantity <= quantity)))
);

CREATE TABLE erp_goods_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    location_id uuid NOT NULL,
    supplier_note text,
    notes text,
    received_by uuid NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_goods_receipts_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 2000))),
    CONSTRAINT erp_goods_receipts_supplier_note_length CHECK (((supplier_note IS NULL) OR (char_length(supplier_note) <= 200)))
);

CREATE TABLE erp_purchase_order_counters (
    tenant_id uuid NOT NULL,
    last_reference integer NOT NULL
);

CREATE TABLE erp_purchase_order_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    "position" integer NOT NULL,
    item_id uuid NOT NULL,
    description text NOT NULL,
    quantity_ordered numeric(20,4) NOT NULL,
    quantity_received numeric(20,4) DEFAULT 0 NOT NULL,
    unit_price numeric(20,4) NOT NULL,
    tax_rate_bp integer DEFAULT 0 NOT NULL,
    CONSTRAINT erp_purchase_order_lines_description_present CHECK (((btrim(description) <> ''::text) AND (char_length(description) <= 500))),
    CONSTRAINT erp_purchase_order_lines_ordered_positive CHECK ((quantity_ordered > (0)::numeric)),
    CONSTRAINT erp_purchase_order_lines_price_not_negative CHECK ((unit_price >= (0)::numeric)),
    CONSTRAINT erp_purchase_order_lines_received_range CHECK (((quantity_received >= (0)::numeric) AND (quantity_received <= quantity_ordered))),
    CONSTRAINT erp_purchase_order_lines_tax_range CHECK (((tax_rate_bp >= 0) AND (tax_rate_bp <= 10000)))
);

CREATE TABLE erp_purchase_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    supplier_id uuid NOT NULL,
    supplier_name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    currency_code text NOT NULL,
    expected_date date,
    delivery_location_id uuid,
    notes text,
    approved_by uuid,
    approved_at timestamp with time zone,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_purchase_orders_approved_pairing CHECK ((((status = ANY (ARRAY['approved'::text, 'partially_received'::text, 'received'::text])) = (approved_at IS NOT NULL)) AND ((approved_at IS NULL) = (approved_by IS NULL)))),
    CONSTRAINT erp_purchase_orders_cancel_reason_length CHECK (((cancel_reason IS NULL) OR (char_length(cancel_reason) <= 1000))),
    CONSTRAINT erp_purchase_orders_cancelled_pairing CHECK ((((status = 'cancelled'::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)))),
    CONSTRAINT erp_purchase_orders_currency_shape CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT erp_purchase_orders_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 10000))),
    CONSTRAINT erp_purchase_orders_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'partially_received'::text, 'received'::text, 'cancelled'::text]))),
    CONSTRAINT erp_purchase_orders_supplier_name_present CHECK ((btrim(supplier_name) <> ''::text)),
    CONSTRAINT erp_purchase_orders_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_supplier_prices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    supplier_id uuid NOT NULL,
    item_id uuid NOT NULL,
    currency_code text NOT NULL,
    min_quantity numeric(20,4) DEFAULT 1 NOT NULL,
    unit_price numeric(20,4) NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_supplier_prices_currency_format CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT erp_supplier_prices_dates_ordered CHECK (((valid_to IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT erp_supplier_prices_min_positive CHECK ((min_quantity > (0)::numeric)),
    CONSTRAINT erp_supplier_prices_price_not_negative CHECK ((unit_price >= (0)::numeric))
);

CREATE TABLE erp_suppliers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    contact_name text,
    email text,
    phone text,
    tax_reference text,
    payment_terms text,
    lead_time_days integer,
    address_line1 text,
    address_line2 text,
    city text,
    region text,
    postcode text,
    country_code text,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((((((COALESCE(name, ''::text) || ' '::text) || COALESCE(contact_name, ''::text)) || ' '::text) || COALESCE(email, ''::text)) || ' '::text) || COALESCE(phone, ''::text)))) STORED,
    CONSTRAINT erp_suppliers_country_shape CHECK (((country_code IS NULL) OR (country_code ~ '^[A-Z]{2}$'::text))),
    CONSTRAINT erp_suppliers_lead_time_sane CHECK (((lead_time_days IS NULL) OR ((lead_time_days >= 0) AND (lead_time_days <= 3650)))),
    CONSTRAINT erp_suppliers_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 200))),
    CONSTRAINT erp_suppliers_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 10000))),
    CONSTRAINT erp_suppliers_status_known CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text]))),
    CONSTRAINT erp_suppliers_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_van_request_lines (
    tenant_id uuid NOT NULL,
    request_id uuid NOT NULL,
    item_id uuid NOT NULL,
    quantity_requested numeric(20,4) NOT NULL,
    quantity_picked numeric(20,4),
    CONSTRAINT erp_van_request_lines_picked_sane CHECK (((quantity_picked IS NULL) OR ((quantity_picked >= (0)::numeric) AND (quantity_picked <= quantity_requested)))),
    CONSTRAINT erp_van_request_lines_requested_positive CHECK ((quantity_requested > (0)::numeric))
);

CREATE TABLE erp_van_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    van_location_id uuid NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    notes text,
    requested_by uuid NOT NULL,
    from_location_id uuid,
    picked_by uuid,
    picked_at timestamp with time zone,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_van_requests_cancelled_pairing CHECK (((status = 'cancelled'::text) = ((cancelled_at IS NOT NULL) AND (cancelled_by IS NOT NULL)))),
    CONSTRAINT erp_van_requests_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 1000))),
    CONSTRAINT erp_van_requests_picked_pairing CHECK (((status = 'picked'::text) = ((picked_at IS NOT NULL) AND (picked_by IS NOT NULL) AND (from_location_id IS NOT NULL)))),
    CONSTRAINT erp_van_requests_status_known CHECK ((status = ANY (ARRAY['open'::text, 'picked'::text, 'cancelled'::text]))),
    CONSTRAINT erp_van_requests_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_work_order_purchases (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    item_id uuid,
    description text NOT NULL,
    merchant text,
    quantity numeric(20,4) NOT NULL,
    unit_price numeric(20,4) NOT NULL,
    note text,
    recorded_by uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    CONSTRAINT erp_work_order_purchases_cancelled_pairing CHECK (((cancelled_at IS NULL) = (cancelled_by IS NULL))),
    CONSTRAINT erp_work_order_purchases_description_present CHECK (((btrim(description) <> ''::text) AND (char_length(description) <= 300))),
    CONSTRAINT erp_work_order_purchases_merchant_length CHECK (((merchant IS NULL) OR (char_length(merchant) <= 200))),
    CONSTRAINT erp_work_order_purchases_note_length CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT erp_work_order_purchases_price_not_negative CHECK ((unit_price >= (0)::numeric)),
    CONSTRAINT erp_work_order_purchases_quantity_positive CHECK ((quantity > (0)::numeric))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY erp_goods_receipt_lines
    ADD CONSTRAINT erp_goods_receipt_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_goods_receipt_lines
    ADD CONSTRAINT erp_goods_receipt_lines_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_goods_receipts
    ADD CONSTRAINT erp_goods_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_goods_receipts
    ADD CONSTRAINT erp_goods_receipts_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_purchase_order_counters
    ADD CONSTRAINT erp_purchase_order_counters_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY erp_purchase_order_lines
    ADD CONSTRAINT erp_purchase_order_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_purchase_order_lines
    ADD CONSTRAINT erp_purchase_order_lines_position_unique UNIQUE (tenant_id, order_id, "position");

ALTER TABLE ONLY erp_purchase_order_lines
    ADD CONSTRAINT erp_purchase_order_lines_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_purchase_orders
    ADD CONSTRAINT erp_purchase_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_purchase_orders
    ADD CONSTRAINT erp_purchase_orders_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_purchase_orders
    ADD CONSTRAINT erp_purchase_orders_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_supplier_prices
    ADD CONSTRAINT erp_supplier_prices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_supplier_prices
    ADD CONSTRAINT erp_supplier_prices_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_suppliers
    ADD CONSTRAINT erp_suppliers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_suppliers
    ADD CONSTRAINT erp_suppliers_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_van_request_lines
    ADD CONSTRAINT erp_van_request_lines_pkey PRIMARY KEY (tenant_id, request_id, item_id);

ALTER TABLE ONLY erp_van_requests
    ADD CONSTRAINT erp_van_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_van_requests
    ADD CONSTRAINT erp_van_requests_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_work_order_purchases
    ADD CONSTRAINT erp_work_order_purchases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_work_order_purchases
    ADD CONSTRAINT erp_work_order_purchases_tenant_id_unique UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX erp_goods_receipt_lines_order_line_idx ON erp_goods_receipt_lines USING btree (tenant_id, order_line_id);

CREATE INDEX erp_goods_receipt_lines_receipt_idx ON erp_goods_receipt_lines USING btree (tenant_id, receipt_id);

CREATE INDEX erp_goods_receipts_order_idx ON erp_goods_receipts USING btree (tenant_id, order_id, received_at DESC);

CREATE INDEX erp_purchase_order_lines_order_idx ON erp_purchase_order_lines USING btree (tenant_id, order_id, "position");

CREATE INDEX erp_purchase_orders_list_idx ON erp_purchase_orders USING btree (tenant_id, created_at DESC, id);

CREATE INDEX erp_purchase_orders_status_idx ON erp_purchase_orders USING btree (tenant_id, status);

CREATE INDEX erp_purchase_orders_supplier_idx ON erp_purchase_orders USING btree (tenant_id, supplier_id, status);

CREATE INDEX erp_supplier_prices_item_idx ON erp_supplier_prices USING btree (tenant_id, item_id, supplier_id);

CREATE INDEX erp_supplier_prices_supplier_idx ON erp_supplier_prices USING btree (tenant_id, supplier_id);

CREATE UNIQUE INDEX erp_suppliers_name_unique ON erp_suppliers USING btree (tenant_id, lower(name));

CREATE INDEX erp_suppliers_search_idx ON erp_suppliers USING gin (search);

CREATE INDEX erp_van_requests_open_idx ON erp_van_requests USING btree (tenant_id, created_at) WHERE (status = 'open'::text);

CREATE INDEX erp_van_requests_van_idx ON erp_van_requests USING btree (tenant_id, van_location_id, created_at DESC);

CREATE INDEX erp_work_order_purchases_job_idx ON erp_work_order_purchases USING btree (tenant_id, work_order_id);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_work_order_purchase_fk FOREIGN KEY (tenant_id, work_order_purchase_id) REFERENCES erp_work_order_purchases(tenant_id, id);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_purchase_order_fk FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES erp_purchase_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_goods_receipt_lines
    ADD CONSTRAINT erp_goods_receipt_lines_order_line_fk FOREIGN KEY (tenant_id, order_line_id) REFERENCES erp_purchase_order_lines(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_goods_receipt_lines
    ADD CONSTRAINT erp_goods_receipt_lines_receipt_fk FOREIGN KEY (tenant_id, receipt_id) REFERENCES erp_goods_receipts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_goods_receipt_lines
    ADD CONSTRAINT erp_goods_receipt_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_goods_receipts
    ADD CONSTRAINT erp_goods_receipts_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_goods_receipts
    ADD CONSTRAINT erp_goods_receipts_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES erp_purchase_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_goods_receipts
    ADD CONSTRAINT erp_goods_receipts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_items
    ADD CONSTRAINT erp_items_supplier_fk FOREIGN KEY (tenant_id, preferred_supplier_id) REFERENCES erp_suppliers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_purchase_order_counters
    ADD CONSTRAINT erp_purchase_order_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_purchase_order_lines
    ADD CONSTRAINT erp_purchase_order_lines_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_purchase_order_lines
    ADD CONSTRAINT erp_purchase_order_lines_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES erp_purchase_orders(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY erp_purchase_order_lines
    ADD CONSTRAINT erp_purchase_order_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_purchase_orders
    ADD CONSTRAINT erp_purchase_orders_location_fk FOREIGN KEY (tenant_id, delivery_location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_purchase_orders
    ADD CONSTRAINT erp_purchase_orders_supplier_fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES erp_suppliers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_purchase_orders
    ADD CONSTRAINT erp_purchase_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_supplier_prices
    ADD CONSTRAINT erp_supplier_prices_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_supplier_prices
    ADD CONSTRAINT erp_supplier_prices_supplier_fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES erp_suppliers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_supplier_prices
    ADD CONSTRAINT erp_supplier_prices_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_suppliers
    ADD CONSTRAINT erp_suppliers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_van_request_lines
    ADD CONSTRAINT erp_van_request_lines_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_van_request_lines
    ADD CONSTRAINT erp_van_request_lines_request_fk FOREIGN KEY (tenant_id, request_id) REFERENCES erp_van_requests(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_van_request_lines
    ADD CONSTRAINT erp_van_request_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_van_requests
    ADD CONSTRAINT erp_van_requests_from_fk FOREIGN KEY (tenant_id, from_location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_van_requests
    ADD CONSTRAINT erp_van_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_van_requests
    ADD CONSTRAINT erp_van_requests_van_fk FOREIGN KEY (tenant_id, van_location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_purchases
    ADD CONSTRAINT erp_work_order_purchases_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_purchases
    ADD CONSTRAINT erp_work_order_purchases_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_purchases
    ADD CONSTRAINT erp_work_order_purchases_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER erp_purchase_order_lines_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_purchase_order_lines FOR EACH ROW EXECUTE FUNCTION erp_purchase_order_lines_guard();

CREATE TRIGGER erp_purchase_orders_assign_reference BEFORE INSERT ON erp_purchase_orders FOR EACH ROW EXECUTE FUNCTION assign_purchase_order_reference();

CREATE TRIGGER erp_purchase_orders_set_updated_at BEFORE UPDATE ON erp_purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_supplier_prices_set_updated_at BEFORE UPDATE ON erp_supplier_prices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_suppliers_set_updated_at BEFORE UPDATE ON erp_suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_van_requests_set_updated_at BEFORE UPDATE ON erp_van_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_work_order_purchases_guard BEFORE INSERT OR UPDATE ON erp_work_order_purchases FOR EACH ROW EXECUTE FUNCTION erp_work_order_purchases_guard();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE erp_goods_receipt_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_goods_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_purchase_order_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_purchase_order_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_purchase_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_supplier_prices ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_suppliers ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_van_request_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_van_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_work_order_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY erp_goods_receipt_lines_isolation ON erp_goods_receipt_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_goods_receipts_isolation ON erp_goods_receipts TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_purchase_order_counters_isolation ON erp_purchase_order_counters FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_purchase_order_lines_isolation ON erp_purchase_order_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_purchase_orders_isolation ON erp_purchase_orders TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_supplier_prices_isolation ON erp_supplier_prices TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_suppliers_isolation ON erp_suppliers TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_van_request_lines_isolation ON erp_van_request_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_van_requests_isolation ON erp_van_requests TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_work_order_purchases_isolation ON erp_work_order_purchases TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION assign_purchase_order_reference() IS 'Gives a new purchase order the next reference for its company. Security definer: the runtime role cannot write the counter.';

COMMENT ON TABLE erp_purchase_order_counters IS 'The last purchase order reference handed out per company. Written only by assign_purchase_order_reference.';

COMMENT ON TABLE erp_purchase_orders IS 'What the company ordered from a supplier. Drafted, approved by an owner or admin, then received against. Totals are derived from the lines.';

COMMENT ON TABLE erp_supplier_prices IS 'What a supplier charges for an item, in its currency, between two days, from a quantity on (ADR-0012).';

COMMENT ON TABLE erp_van_requests IS 'An engineer asking for stock for their van; a store person picks it from a warehouse, which transfers it (ADR-0012). Online only.';

COMMENT ON TABLE erp_work_order_purchases IS 'Parts bought from a merchant for a job, with the price paid (ADR-0012). On the job and its cost; never in stock.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,UPDATE ON TABLE erp_goods_receipt_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_goods_receipt_lines TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_goods_receipts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_goods_receipts TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_purchase_order_counters TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_purchase_order_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_purchase_order_lines TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_purchase_orders TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_purchase_orders TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_supplier_prices TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_supplier_prices TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_suppliers TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_suppliers TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_van_request_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_van_request_lines TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_van_requests TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_van_requests TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_work_order_purchases TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_work_order_purchases TO integr8_platform;
