-- Quotes, sales orders and deliveries.
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

CREATE FUNCTION public.assign_sales_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  insert into public.sales_document_counters as counter (tenant_id, kind, last_reference)
  values (new.tenant_id, tg_argv[0], 1)
  on conflict (tenant_id, kind) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;

CREATE FUNCTION public.crm_quote_lines_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  quote_status text;
begin
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
  select status into quote_status
    from crm_quotes
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.quote_id, old.quote_id);
  if quote_status = 'draft' then
    return coalesce(new, old);
  end if;
  raise exception 'An issued quote''s lines do not change'
    using errcode = 'check_violation', constraint = 'crm_quote_lines_frozen';
end;
$$;

CREATE FUNCTION public.erp_assign_line_scale() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_table_name = 'crm_quote_lines' then
    new.money_scale := coalesce(
      (select l.money_scale from crm_quote_lines l
        where l.tenant_id = new.tenant_id and l.quote_id = new.quote_id and l.id <> new.id limit 1),
      (select erp_currency_minor_unit(q.currency_code) from crm_quotes q
        where q.tenant_id = new.tenant_id and q.id = new.quote_id),
      2);
  elsif tg_table_name = 'erp_sales_order_lines' then
    new.money_scale := coalesce(
      (select l.money_scale from erp_sales_order_lines l
        where l.tenant_id = new.tenant_id and l.order_id = new.order_id and l.id <> new.id limit 1),
      (select erp_currency_minor_unit(o.currency_code) from erp_sales_orders o
        where o.tenant_id = new.tenant_id and o.id = new.order_id),
      2);
  elsif tg_table_name = 'erp_invoice_lines' then
    new.money_scale := coalesce(
      (select l.money_scale from erp_invoice_lines l
        where l.tenant_id = new.tenant_id and l.invoice_id = new.invoice_id and l.id <> new.id limit 1),
      (select erp_currency_minor_unit(i.currency_code) from erp_invoices i
        where i.tenant_id = new.tenant_id and i.id = new.invoice_id),
      2);
  else
    -- A credit note follows its invoice, so crediting an old one matches it.
    new.money_scale := coalesce(
      (select l.money_scale from erp_credit_note_lines l
        where l.tenant_id = new.tenant_id and l.credit_note_id = new.credit_note_id and l.id <> new.id limit 1),
      (select il.money_scale from erp_credit_notes c
         join erp_invoice_lines il on il.tenant_id = c.tenant_id and il.invoice_id = c.invoice_id
        where c.tenant_id = new.tenant_id and c.id = new.credit_note_id limit 1),
      (select erp_currency_minor_unit(i.currency_code) from erp_credit_notes c
         join erp_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
        where c.tenant_id = new.tenant_id and c.id = new.credit_note_id),
      2);
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.erp_currency_minor_unit(p_currency text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select case
    when p_currency in ('BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF',
                        'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF') then 0
    when p_currency in ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND') then 3
    else 2
  end;
$$;

CREATE FUNCTION public.erp_sales_order_lines_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  order_status text;
begin
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
  select status into order_status
    from erp_sales_orders
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.order_id, old.order_id);
  if order_status = 'draft' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and new.order_id = old.order_id and new.position = old.position
     and new.item_id is not distinct from old.item_id
     and new.description = old.description and new.quantity = old.quantity and new.unit = old.unit
     and new.unit_price = old.unit_price and new.discount_bp = old.discount_bp
     and new.tax_rate_bp = old.tax_rate_bp then
    return new;
  end if;
  raise exception 'A confirmed sales order''s lines do not change'
    using errcode = 'check_violation', constraint = 'erp_sales_order_lines_frozen';
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE crm_quote_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    quote_id uuid NOT NULL,
    "position" integer NOT NULL,
    item_id uuid,
    description text NOT NULL,
    quantity numeric(20,4) NOT NULL,
    unit text DEFAULT 'each'::text NOT NULL,
    unit_price numeric(20,4) NOT NULL,
    discount_bp integer DEFAULT 0 NOT NULL,
    tax_rate_bp integer DEFAULT 0 NOT NULL,
    money_scale smallint DEFAULT 4 NOT NULL,
    CONSTRAINT crm_quote_lines_description_present CHECK (((btrim(description) <> ''::text) AND (char_length(description) <= 500))),
    CONSTRAINT crm_quote_lines_discount_range CHECK (((discount_bp >= 0) AND (discount_bp <= 10000))),
    CONSTRAINT crm_quote_lines_money_scale_range CHECK (((money_scale >= 0) AND (money_scale <= 4))),
    CONSTRAINT crm_quote_lines_price_not_negative CHECK ((unit_price >= (0)::numeric)),
    CONSTRAINT crm_quote_lines_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT crm_quote_lines_tax_range CHECK (((tax_rate_bp >= 0) AND (tax_rate_bp <= 10000))),
    CONSTRAINT crm_quote_lines_unit_known CHECK ((unit = ANY (ARRAY['each'::text, 'pair'::text, 'set'::text, 'box'::text, 'pack'::text, 'roll'::text, 'm'::text, 'm2'::text, 'm3'::text, 'l'::text, 'kg'::text, 'g'::text, 'hour'::text])))
);

CREATE TABLE crm_quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    customer_id uuid NOT NULL,
    site_id uuid,
    contact_id uuid,
    opportunity_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    title text NOT NULL,
    currency_code text NOT NULL,
    valid_until date,
    introduction text,
    terms text,
    internal_notes text,
    customer_name text,
    customer_address jsonb,
    contact_name text,
    contact_email text,
    contact_phone text,
    issued_by uuid,
    issued_at timestamp with time zone,
    access_token_hash text,
    answered_at timestamp with time zone,
    answered_by uuid,
    answered_via text,
    answered_name text,
    answered_from text,
    rejection_reason text,
    converted_order_id uuid,
    converted_at timestamp with time zone,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_quotes_answered_pairing CHECK ((((status <> ALL (ARRAY['accepted'::text, 'rejected'::text, 'converted'::text])) OR (answered_at IS NOT NULL)) AND ((answered_at IS NULL) = (answered_via IS NULL)))),
    CONSTRAINT crm_quotes_answered_via_known CHECK (((answered_via IS NULL) OR (answered_via = ANY (ARRAY['office'::text, 'link'::text])))),
    CONSTRAINT crm_quotes_cancelled_pairing CHECK ((((status = 'cancelled'::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)))),
    CONSTRAINT crm_quotes_converted_pairing CHECK ((((status = 'converted'::text) = (converted_order_id IS NOT NULL)) AND ((converted_order_id IS NULL) = (converted_at IS NULL)))),
    CONSTRAINT crm_quotes_currency_shape CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT crm_quotes_issued_pairing CHECK ((((status = ANY (ARRAY['draft'::text, 'cancelled'::text])) OR (issued_at IS NOT NULL)) AND ((status <> 'draft'::text) OR (issued_at IS NULL)) AND ((issued_at IS NULL) = (issued_by IS NULL)) AND ((issued_at IS NULL) = (customer_name IS NULL)))),
    CONSTRAINT crm_quotes_revision_positive CHECK ((revision > 0)),
    CONSTRAINT crm_quotes_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'accepted'::text, 'rejected'::text, 'converted'::text, 'cancelled'::text]))),
    CONSTRAINT crm_quotes_text_lengths CHECK ((((introduction IS NULL) OR (char_length(introduction) <= 4000)) AND ((terms IS NULL) OR (char_length(terms) <= 10000)) AND ((internal_notes IS NULL) OR (char_length(internal_notes) <= 10000)) AND ((rejection_reason IS NULL) OR (char_length(rejection_reason) <= 1000)) AND ((cancel_reason IS NULL) OR (char_length(cancel_reason) <= 1000)))),
    CONSTRAINT crm_quotes_title_present CHECK (((btrim(title) <> ''::text) AND (char_length(title) <= 200))),
    CONSTRAINT crm_quotes_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_sales_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    order_id uuid NOT NULL,
    location_id uuid NOT NULL,
    notes text,
    delivered_by uuid NOT NULL,
    delivered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_sales_deliveries_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 2000)))
);

CREATE TABLE erp_sales_delivery_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    order_line_id uuid NOT NULL,
    quantity numeric(20,4) NOT NULL,
    unit_cost numeric(20,4),
    CONSTRAINT erp_sales_delivery_lines_quantity_positive CHECK ((quantity > (0)::numeric))
);

CREATE TABLE erp_sales_order_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    "position" integer NOT NULL,
    item_id uuid,
    description text NOT NULL,
    quantity numeric(20,4) NOT NULL,
    unit text DEFAULT 'each'::text NOT NULL,
    unit_price numeric(20,4) NOT NULL,
    discount_bp integer DEFAULT 0 NOT NULL,
    tax_rate_bp integer DEFAULT 0 NOT NULL,
    quantity_reserved numeric(20,4) DEFAULT 0 NOT NULL,
    reserve_location_id uuid,
    quantity_fulfilled numeric(20,4) DEFAULT 0 NOT NULL,
    money_scale smallint DEFAULT 4 NOT NULL,
    CONSTRAINT erp_sales_order_lines_description_present CHECK (((btrim(description) <> ''::text) AND (char_length(description) <= 500))),
    CONSTRAINT erp_sales_order_lines_discount_range CHECK (((discount_bp >= 0) AND (discount_bp <= 10000))),
    CONSTRAINT erp_sales_order_lines_fulfilled_range CHECK (((quantity_fulfilled >= (0)::numeric) AND (quantity_fulfilled <= quantity))),
    CONSTRAINT erp_sales_order_lines_money_scale_range CHECK (((money_scale >= 0) AND (money_scale <= 4))),
    CONSTRAINT erp_sales_order_lines_price_not_negative CHECK ((unit_price >= (0)::numeric)),
    CONSTRAINT erp_sales_order_lines_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT erp_sales_order_lines_reserved_placed CHECK (((quantity_reserved = (0)::numeric) OR (reserve_location_id IS NOT NULL))),
    CONSTRAINT erp_sales_order_lines_reserved_range CHECK (((quantity_reserved >= (0)::numeric) AND (quantity_reserved <= quantity))),
    CONSTRAINT erp_sales_order_lines_tax_range CHECK (((tax_rate_bp >= 0) AND (tax_rate_bp <= 10000))),
    CONSTRAINT erp_sales_order_lines_unit_known CHECK ((unit = ANY (ARRAY['each'::text, 'pair'::text, 'set'::text, 'box'::text, 'pack'::text, 'roll'::text, 'm'::text, 'm2'::text, 'm3'::text, 'l'::text, 'kg'::text, 'g'::text, 'hour'::text])))
);

CREATE TABLE erp_sales_order_work_orders (
    tenant_id uuid NOT NULL,
    order_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    linked_by uuid NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE erp_sales_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    quote_id uuid,
    customer_id uuid NOT NULL,
    site_id uuid,
    contact_id uuid,
    status text DEFAULT 'draft'::text NOT NULL,
    title text NOT NULL,
    currency_code text NOT NULL,
    notes text,
    internal_notes text,
    reserve_location_id uuid,
    customer_name text,
    customer_address jsonb,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    fulfilled_at timestamp with time zone,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_sales_orders_cancelled_pairing CHECK ((((status = 'cancelled'::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)))),
    CONSTRAINT erp_sales_orders_confirmed_pairing CHECK ((((status = ANY (ARRAY['draft'::text, 'cancelled'::text])) OR (confirmed_at IS NOT NULL)) AND ((status <> 'draft'::text) OR (confirmed_at IS NULL)) AND ((confirmed_at IS NULL) = (confirmed_by IS NULL)) AND ((confirmed_at IS NULL) = (customer_name IS NULL)))),
    CONSTRAINT erp_sales_orders_currency_shape CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT erp_sales_orders_fulfilled_pairing CHECK (((status = 'fulfilled'::text) = (fulfilled_at IS NOT NULL))),
    CONSTRAINT erp_sales_orders_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'confirmed'::text, 'partially_fulfilled'::text, 'fulfilled'::text, 'cancelled'::text]))),
    CONSTRAINT erp_sales_orders_text_lengths CHECK ((((notes IS NULL) OR (char_length(notes) <= 10000)) AND ((internal_notes IS NULL) OR (char_length(internal_notes) <= 10000)) AND ((cancel_reason IS NULL) OR (char_length(cancel_reason) <= 1000)))),
    CONSTRAINT erp_sales_orders_title_present CHECK (((btrim(title) <> ''::text) AND (char_length(title) <= 200))),
    CONSTRAINT erp_sales_orders_version_positive CHECK ((version > 0))
);

CREATE TABLE sales_document_counters (
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    last_reference integer NOT NULL,
    CONSTRAINT sales_document_counters_kind_known CHECK ((kind = ANY (ARRAY['quote'::text, 'sales_order'::text, 'delivery'::text])))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY crm_quote_lines
    ADD CONSTRAINT crm_quote_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_quote_lines
    ADD CONSTRAINT crm_quote_lines_position_unique UNIQUE (tenant_id, quote_id, "position");

ALTER TABLE ONLY crm_quote_lines
    ADD CONSTRAINT crm_quote_lines_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_sales_deliveries
    ADD CONSTRAINT erp_sales_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_sales_deliveries
    ADD CONSTRAINT erp_sales_deliveries_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_sales_deliveries
    ADD CONSTRAINT erp_sales_deliveries_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_sales_delivery_lines
    ADD CONSTRAINT erp_sales_delivery_lines_line_unique UNIQUE (tenant_id, delivery_id, order_line_id);

ALTER TABLE ONLY erp_sales_delivery_lines
    ADD CONSTRAINT erp_sales_delivery_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_sales_delivery_lines
    ADD CONSTRAINT erp_sales_delivery_lines_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_sales_order_lines
    ADD CONSTRAINT erp_sales_order_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_sales_order_lines
    ADD CONSTRAINT erp_sales_order_lines_position_unique UNIQUE (tenant_id, order_id, "position");

ALTER TABLE ONLY erp_sales_order_lines
    ADD CONSTRAINT erp_sales_order_lines_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_sales_order_work_orders
    ADD CONSTRAINT erp_sales_order_work_orders_pkey PRIMARY KEY (tenant_id, order_id, work_order_id);

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_quote_unique UNIQUE (tenant_id, quote_id);

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY sales_document_counters
    ADD CONSTRAINT sales_document_counters_pkey PRIMARY KEY (tenant_id, kind);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX crm_quote_lines_by_quote ON crm_quote_lines USING btree (tenant_id, quote_id, "position");

CREATE INDEX crm_quotes_by_customer ON crm_quotes USING btree (tenant_id, customer_id, created_at DESC);

CREATE INDEX crm_quotes_by_opportunity ON crm_quotes USING btree (tenant_id, opportunity_id) WHERE (opportunity_id IS NOT NULL);

CREATE INDEX crm_quotes_by_status ON crm_quotes USING btree (tenant_id, status, created_at DESC);

CREATE UNIQUE INDEX crm_quotes_token_unique ON crm_quotes USING btree (access_token_hash) WHERE (access_token_hash IS NOT NULL);

CREATE INDEX erp_sales_deliveries_order_idx ON erp_sales_deliveries USING btree (tenant_id, order_id);

CREATE INDEX erp_sales_order_lines_by_order ON erp_sales_order_lines USING btree (tenant_id, order_id, "position");

CREATE INDEX erp_sales_order_lines_reserved ON erp_sales_order_lines USING btree (tenant_id, item_id, reserve_location_id) WHERE (quantity_reserved > (0)::numeric);

CREATE INDEX erp_sales_order_work_orders_by_job ON erp_sales_order_work_orders USING btree (tenant_id, work_order_id);

CREATE INDEX erp_sales_orders_by_customer ON erp_sales_orders USING btree (tenant_id, customer_id, created_at DESC);

CREATE INDEX erp_sales_orders_by_status ON erp_sales_orders USING btree (tenant_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY crm_quote_lines
    ADD CONSTRAINT crm_quote_lines_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_quote_lines
    ADD CONSTRAINT crm_quote_lines_quote_fk FOREIGN KEY (tenant_id, quote_id) REFERENCES crm_quotes(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY crm_quote_lines
    ADD CONSTRAINT crm_quote_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES customer_contacts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_converted_order_fk FOREIGN KEY (tenant_id, converted_order_id) REFERENCES erp_sales_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_opportunity_fk FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm_opportunities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_quotes
    ADD CONSTRAINT crm_quotes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_quote_fk FOREIGN KEY (tenant_id, quote_id) REFERENCES crm_quotes(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_deliveries
    ADD CONSTRAINT erp_sales_deliveries_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_deliveries
    ADD CONSTRAINT erp_sales_deliveries_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES erp_sales_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_deliveries
    ADD CONSTRAINT erp_sales_deliveries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_delivery_lines
    ADD CONSTRAINT erp_sales_delivery_lines_delivery_fk FOREIGN KEY (tenant_id, delivery_id) REFERENCES erp_sales_deliveries(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_delivery_lines
    ADD CONSTRAINT erp_sales_delivery_lines_order_line_fk FOREIGN KEY (tenant_id, order_line_id) REFERENCES erp_sales_order_lines(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_delivery_lines
    ADD CONSTRAINT erp_sales_delivery_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_order_lines
    ADD CONSTRAINT erp_sales_order_lines_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_order_lines
    ADD CONSTRAINT erp_sales_order_lines_location_fk FOREIGN KEY (tenant_id, reserve_location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_order_lines
    ADD CONSTRAINT erp_sales_order_lines_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES erp_sales_orders(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY erp_sales_order_lines
    ADD CONSTRAINT erp_sales_order_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_order_work_orders
    ADD CONSTRAINT erp_sales_order_work_orders_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES erp_sales_orders(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY erp_sales_order_work_orders
    ADD CONSTRAINT erp_sales_order_work_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_order_work_orders
    ADD CONSTRAINT erp_sales_order_work_orders_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_contact_fk FOREIGN KEY (tenant_id, contact_id) REFERENCES customer_contacts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_location_fk FOREIGN KEY (tenant_id, reserve_location_id) REFERENCES erp_stock_locations(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_quote_fk FOREIGN KEY (tenant_id, quote_id) REFERENCES crm_quotes(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_sales_orders
    ADD CONSTRAINT erp_sales_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY sales_document_counters
    ADD CONSTRAINT sales_document_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER crm_quote_lines_guard BEFORE INSERT OR DELETE OR UPDATE ON crm_quote_lines FOR EACH ROW EXECUTE FUNCTION crm_quote_lines_guard();

CREATE TRIGGER crm_quote_lines_money_scale BEFORE INSERT ON crm_quote_lines FOR EACH ROW EXECUTE FUNCTION erp_assign_line_scale();

CREATE TRIGGER crm_quotes_assign_reference BEFORE INSERT ON crm_quotes FOR EACH ROW EXECUTE FUNCTION assign_sales_reference('quote');

CREATE TRIGGER crm_quotes_set_updated_at BEFORE UPDATE ON crm_quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_sales_deliveries_assign_reference BEFORE INSERT ON erp_sales_deliveries FOR EACH ROW EXECUTE FUNCTION assign_sales_reference('delivery');

CREATE TRIGGER erp_sales_order_lines_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_sales_order_lines FOR EACH ROW EXECUTE FUNCTION erp_sales_order_lines_guard();

CREATE TRIGGER erp_sales_order_lines_money_scale BEFORE INSERT ON erp_sales_order_lines FOR EACH ROW EXECUTE FUNCTION erp_assign_line_scale();

CREATE TRIGGER erp_sales_orders_assign_reference BEFORE INSERT ON erp_sales_orders FOR EACH ROW EXECUTE FUNCTION assign_sales_reference('sales_order');

CREATE TRIGGER erp_sales_orders_set_updated_at BEFORE UPDATE ON erp_sales_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE crm_quote_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_quotes ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_sales_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_sales_delivery_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_sales_order_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_sales_order_work_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_sales_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE sales_document_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY crm_quote_lines_isolation ON crm_quote_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_quotes_isolation ON crm_quotes TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_sales_deliveries_isolation ON erp_sales_deliveries TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_sales_delivery_lines_isolation ON erp_sales_delivery_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_sales_order_lines_isolation ON erp_sales_order_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_sales_order_work_orders_isolation ON erp_sales_order_work_orders TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_sales_orders_isolation ON erp_sales_orders TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY sales_document_counters_isolation ON sales_document_counters FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION assign_sales_reference() IS 'Gives a new quote or sales order the next reference for its company; tg_argv[0] names which. Security definer: the runtime role cannot write the counter.';

COMMENT ON FUNCTION erp_assign_line_scale() IS 'Sets a new sales or finance line''s money_scale: its document''s other lines'', else its currency''s minor unit (0064).';

COMMENT ON TABLE erp_sales_deliveries IS 'Goods handed over on a sales order from a location, by whoever manages orders (ADR-0012). Never changed.';

COMMENT ON TABLE sales_document_counters IS 'The last quote and sales order reference handed out per company. Written only by assign_sales_reference.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_quote_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_quote_lines TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE crm_quotes TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_quotes TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_sales_deliveries TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_sales_deliveries TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_sales_delivery_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_sales_delivery_lines TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_sales_order_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_sales_order_lines TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE erp_sales_order_work_orders TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_sales_order_work_orders TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_sales_orders TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_sales_orders TO integr8_platform;

GRANT SELECT ON TABLE sales_document_counters TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sales_document_counters TO integr8_platform;
