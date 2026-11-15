-- Bills of materials, assembly orders and material planning.
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

CREATE FUNCTION public.assign_assembly_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'UPDATE' then
    if new.reference is distinct from old.reference then
      raise exception 'An assembly order keeps its number'
        using errcode = 'check_violation', constraint = 'erp_assembly_orders_reference_fixed';
    end if;
    return new;
  end if;
  insert into public.assembly_reference_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;

CREATE FUNCTION public.erp_assembly_orders_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  bom_item uuid;
begin
  if tg_op = 'DELETE' then
    if coalesce(integr8_purging(old.tenant_id), false) then
      return old;
    end if;
    raise exception 'An assembly order is never deleted; cancel it'
      using errcode = 'check_violation', constraint = 'erp_assembly_orders_frozen';
  end if;
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'An assembly order starts as a draft'
      using errcode = 'check_violation', constraint = 'erp_assembly_orders_frozen';
  end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' then
      raise exception 'A completed or cancelled assembly order does not change'
        using errcode = 'check_violation', constraint = 'erp_assembly_orders_frozen';
    end if;
    if (new.direction, new.created_by, new.created_at, new.plan_id)
       is distinct from (old.direction, old.created_by, old.created_at, old.plan_id) then
      raise exception 'An assembly order keeps its direction and origin'
        using errcode = 'check_violation', constraint = 'erp_assembly_orders_frozen';
    end if;
  end if;
  select item_id into bom_item from erp_boms where tenant_id = new.tenant_id and id = new.bom_id;
  if bom_item is distinct from new.item_id then
    raise exception 'An assembly order uses a bill of its own item'
      using errcode = 'check_violation', constraint = 'erp_assembly_orders_bom_item';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.erp_bom_components_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  bom_item  uuid;
  item_kind text;
begin
  if tg_op <> 'INSERT' then
    if coalesce(integr8_purging(old.tenant_id), false) then
      return coalesce(new, old);
    end if;
    raise exception 'A bill of materials does not change; save a new version'
      using errcode = 'check_violation', constraint = 'erp_boms_frozen';
  end if;
  select item_id into bom_item from erp_boms where tenant_id = new.tenant_id and id = new.bom_id;
  if bom_item = new.item_id then
    raise exception 'An item is not a component of itself'
      using errcode = 'check_violation', constraint = 'erp_bom_components_not_itself';
  end if;
  select kind into item_kind from erp_items where tenant_id = new.tenant_id and id = new.item_id;
  if item_kind not in ('stock_item', 'non_stock_item') then
    raise exception 'A component is a stock or non-stock item'
      using errcode = 'check_violation', constraint = 'erp_bom_components_item_kind';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.erp_boms_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  item_kind text;
begin
  if tg_op = 'DELETE' then
    if coalesce(integr8_purging(old.tenant_id), false) then
      return old;
    end if;
    raise exception 'A bill of materials is never deleted; supersede it'
      using errcode = 'check_violation', constraint = 'erp_boms_frozen';
  end if;
  if tg_op = 'INSERT' then
    select kind into item_kind from erp_items where tenant_id = new.tenant_id and id = new.item_id;
    if item_kind is distinct from 'stock_item' then
      raise exception 'Only a stock item is built from a bill'
        using errcode = 'check_violation', constraint = 'erp_boms_stock_item';
    end if;
    if new.superseded_at is not null then
      raise exception 'A bill starts in use'
        using errcode = 'check_violation', constraint = 'erp_boms_frozen';
    end if;
    return new;
  end if;
  if old.superseded_at is not null
     or (new.item_id, new.version, new.labour_cost, new.overhead_cost, new.note, new.created_by, new.created_at)
        is distinct from
        (old.item_id, old.version, old.labour_cost, old.overhead_cost, old.note, old.created_by, old.created_at) then
    raise exception 'A bill of materials does not change; save a new version'
      using errcode = 'check_violation', constraint = 'erp_boms_frozen';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.erp_mrp_suggestions_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'UPDATE' and (
       old.drafted_id is not null
       or (new.plan_id, new.item_id, new.action, new.level, new.required, new.available, new.on_order,
           new.reorder_minimum, new.quantity, new.need_by, new.order_by, new.lead_time_days,
           new.supplier_id, new.bom_id, new.basis)
          is distinct from
          (old.plan_id, old.item_id, old.action, old.level, old.required, old.available, old.on_order,
           old.reorder_minimum, old.quantity, old.need_by, old.order_by, old.lead_time_days,
           old.supplier_id, old.bom_id, old.basis)) then
    raise exception 'A plan is a snapshot; run planning again'
      using errcode = 'check_violation', constraint = 'erp_mrp_suggestions_frozen';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE assembly_reference_counters (
    tenant_id uuid NOT NULL,
    last_reference integer NOT NULL
);

CREATE TABLE erp_assembly_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    direction text DEFAULT 'assemble'::text NOT NULL,
    item_id uuid NOT NULL,
    bom_id uuid NOT NULL,
    location_id uuid NOT NULL,
    quantity numeric(20,4) NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    planned_for date,
    plan_id uuid,
    note text,
    unit_cost numeric(20,4),
    labour_cost numeric(20,4),
    overhead_cost numeric(20,4),
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_by uuid,
    completed_at timestamp with time zone,
    cancelled_by uuid,
    cancelled_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_assembly_orders_cancel_pairing CHECK ((((status = 'cancelled'::text) = (cancelled_at IS NOT NULL)) AND ((cancelled_at IS NULL) = (cancelled_by IS NULL)))),
    CONSTRAINT erp_assembly_orders_completion_pairing CHECK ((((status = 'completed'::text) = (completed_at IS NOT NULL)) AND ((completed_at IS NULL) = (completed_by IS NULL)) AND ((completed_at IS NULL) = (unit_cost IS NULL)) AND (((status = 'completed'::text) AND (direction = 'assemble'::text)) = (labour_cost IS NOT NULL)) AND ((labour_cost IS NULL) = (overhead_cost IS NULL)))),
    CONSTRAINT erp_assembly_orders_costs_not_negative CHECK ((((unit_cost IS NULL) OR (unit_cost >= (0)::numeric)) AND ((labour_cost IS NULL) OR (labour_cost >= (0)::numeric)) AND ((overhead_cost IS NULL) OR (overhead_cost >= (0)::numeric)))),
    CONSTRAINT erp_assembly_orders_direction_known CHECK ((direction = ANY (ARRAY['assemble'::text, 'disassemble'::text]))),
    CONSTRAINT erp_assembly_orders_note_length CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT erp_assembly_orders_quantity_positive CHECK ((quantity > (0)::numeric)),
    CONSTRAINT erp_assembly_orders_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'completed'::text, 'cancelled'::text]))),
    CONSTRAINT erp_assembly_orders_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_bom_components (
    tenant_id uuid NOT NULL,
    bom_id uuid NOT NULL,
    line_no integer NOT NULL,
    item_id uuid NOT NULL,
    quantity numeric(20,4) NOT NULL,
    CONSTRAINT erp_bom_components_line_positive CHECK ((line_no > 0)),
    CONSTRAINT erp_bom_components_quantity_positive CHECK ((quantity > (0)::numeric))
);

CREATE TABLE erp_boms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    item_id uuid NOT NULL,
    version integer NOT NULL,
    labour_cost numeric(20,4) DEFAULT 0 NOT NULL,
    overhead_cost numeric(20,4) DEFAULT 0 NOT NULL,
    note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_at timestamp with time zone,
    superseded_by uuid,
    CONSTRAINT erp_boms_costs_not_negative CHECK (((labour_cost >= (0)::numeric) AND (overhead_cost >= (0)::numeric))),
    CONSTRAINT erp_boms_note_length CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT erp_boms_superseded_pairing CHECK (((superseded_at IS NULL) = (superseded_by IS NULL))),
    CONSTRAINT erp_boms_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_mrp_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    horizon_end date NOT NULL,
    run_by uuid NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE erp_mrp_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    item_id uuid NOT NULL,
    action text NOT NULL,
    level integer NOT NULL,
    required numeric(20,4) NOT NULL,
    available numeric(20,4) NOT NULL,
    on_order numeric(20,4) NOT NULL,
    reorder_minimum numeric(20,4) NOT NULL,
    quantity numeric(20,4) NOT NULL,
    need_by date NOT NULL,
    order_by date NOT NULL,
    lead_time_days integer NOT NULL,
    supplier_id uuid,
    bom_id uuid,
    basis text NOT NULL,
    drafted_kind text,
    drafted_id uuid,
    drafted_at timestamp with time zone,
    CONSTRAINT erp_mrp_suggestions_action_known CHECK ((action = ANY (ARRAY['build'::text, 'buy'::text]))),
    CONSTRAINT erp_mrp_suggestions_basis_length CHECK ((char_length(basis) <= 2000)),
    CONSTRAINT erp_mrp_suggestions_build_has_bill CHECK (((action = 'build'::text) = (bom_id IS NOT NULL))),
    CONSTRAINT erp_mrp_suggestions_dates CHECK ((order_by <= need_by)),
    CONSTRAINT erp_mrp_suggestions_drafted_known CHECK (((drafted_kind IS NULL) OR (drafted_kind = ANY (ARRAY['assembly_order'::text, 'purchase_order'::text])))),
    CONSTRAINT erp_mrp_suggestions_drafted_pairing CHECK ((((drafted_kind IS NULL) = (drafted_id IS NULL)) AND ((drafted_id IS NULL) = (drafted_at IS NULL)))),
    CONSTRAINT erp_mrp_suggestions_quantities CHECK (((required >= (0)::numeric) AND (on_order >= (0)::numeric) AND (reorder_minimum >= (0)::numeric) AND (quantity > (0)::numeric) AND (level >= 0)))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY assembly_reference_counters
    ADD CONSTRAINT assembly_reference_counters_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY erp_assembly_orders
    ADD CONSTRAINT erp_assembly_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_assembly_orders
    ADD CONSTRAINT erp_assembly_orders_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_assembly_orders
    ADD CONSTRAINT erp_assembly_orders_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_bom_components
    ADD CONSTRAINT erp_bom_components_item_unique UNIQUE (tenant_id, bom_id, item_id);

ALTER TABLE ONLY erp_bom_components
    ADD CONSTRAINT erp_bom_components_pkey PRIMARY KEY (tenant_id, bom_id, line_no);

ALTER TABLE ONLY erp_boms
    ADD CONSTRAINT erp_boms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_boms
    ADD CONSTRAINT erp_boms_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_boms
    ADD CONSTRAINT erp_boms_version_unique UNIQUE (tenant_id, item_id, version);

ALTER TABLE ONLY erp_mrp_plans
    ADD CONSTRAINT erp_mrp_plans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_mrp_plans
    ADD CONSTRAINT erp_mrp_plans_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_mrp_suggestions
    ADD CONSTRAINT erp_mrp_suggestions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_mrp_suggestions
    ADD CONSTRAINT erp_mrp_suggestions_tenant_id_unique UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX erp_assembly_orders_item ON erp_assembly_orders USING btree (tenant_id, item_id);

CREATE INDEX erp_assembly_orders_open ON erp_assembly_orders USING btree (tenant_id, status, created_at DESC);

CREATE UNIQUE INDEX erp_boms_active_unique ON erp_boms USING btree (tenant_id, item_id) WHERE (superseded_at IS NULL);

CREATE INDEX erp_mrp_suggestions_plan ON erp_mrp_suggestions USING btree (tenant_id, plan_id, level, item_id);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY assembly_reference_counters
    ADD CONSTRAINT assembly_reference_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_assembly_orders
    ADD CONSTRAINT erp_assembly_orders_bom_fk FOREIGN KEY (tenant_id, bom_id) REFERENCES erp_boms(tenant_id, id);

ALTER TABLE ONLY erp_assembly_orders
    ADD CONSTRAINT erp_assembly_orders_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id);

ALTER TABLE ONLY erp_assembly_orders
    ADD CONSTRAINT erp_assembly_orders_location_fk FOREIGN KEY (tenant_id, location_id) REFERENCES erp_stock_locations(tenant_id, id);

ALTER TABLE ONLY erp_assembly_orders
    ADD CONSTRAINT erp_assembly_orders_plan_fk FOREIGN KEY (tenant_id, plan_id) REFERENCES erp_mrp_plans(tenant_id, id);

ALTER TABLE ONLY erp_assembly_orders
    ADD CONSTRAINT erp_assembly_orders_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_bom_components
    ADD CONSTRAINT erp_bom_components_bom_fk FOREIGN KEY (tenant_id, bom_id) REFERENCES erp_boms(tenant_id, id);

ALTER TABLE ONLY erp_bom_components
    ADD CONSTRAINT erp_bom_components_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id);

ALTER TABLE ONLY erp_bom_components
    ADD CONSTRAINT erp_bom_components_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_boms
    ADD CONSTRAINT erp_boms_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id);

ALTER TABLE ONLY erp_boms
    ADD CONSTRAINT erp_boms_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_mrp_plans
    ADD CONSTRAINT erp_mrp_plans_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_mrp_suggestions
    ADD CONSTRAINT erp_mrp_suggestions_bom_fk FOREIGN KEY (tenant_id, bom_id) REFERENCES erp_boms(tenant_id, id);

ALTER TABLE ONLY erp_mrp_suggestions
    ADD CONSTRAINT erp_mrp_suggestions_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id);

ALTER TABLE ONLY erp_mrp_suggestions
    ADD CONSTRAINT erp_mrp_suggestions_plan_fk FOREIGN KEY (tenant_id, plan_id) REFERENCES erp_mrp_plans(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY erp_mrp_suggestions
    ADD CONSTRAINT erp_mrp_suggestions_supplier_fk FOREIGN KEY (tenant_id, supplier_id) REFERENCES erp_suppliers(tenant_id, id);

ALTER TABLE ONLY erp_mrp_suggestions
    ADD CONSTRAINT erp_mrp_suggestions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER erp_assembly_orders_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_assembly_orders FOR EACH ROW EXECUTE FUNCTION erp_assembly_orders_guard();

CREATE TRIGGER erp_assembly_orders_number BEFORE INSERT OR UPDATE ON erp_assembly_orders FOR EACH ROW EXECUTE FUNCTION assign_assembly_reference();

CREATE TRIGGER erp_assembly_orders_set_updated_at BEFORE UPDATE ON erp_assembly_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_bom_components_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_bom_components FOR EACH ROW EXECUTE FUNCTION erp_bom_components_guard();

CREATE TRIGGER erp_boms_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_boms FOR EACH ROW EXECUTE FUNCTION erp_boms_guard();

CREATE TRIGGER erp_mrp_suggestions_guard BEFORE UPDATE ON erp_mrp_suggestions FOR EACH ROW EXECUTE FUNCTION erp_mrp_suggestions_guard();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE assembly_reference_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_assembly_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_bom_components ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_boms ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_mrp_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_mrp_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY assembly_reference_counters_isolation ON assembly_reference_counters FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_assembly_orders_isolation ON erp_assembly_orders TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_bom_components_isolation ON erp_bom_components TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_boms_isolation ON erp_boms TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_mrp_plans_isolation ON erp_mrp_plans TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_mrp_suggestions_isolation ON erp_mrp_suggestions TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION assign_assembly_reference() IS 'Numbers an assembly order when it is drafted, and keeps the number. Security definer: the runtime role cannot write the counter.';

COMMENT ON TABLE assembly_reference_counters IS 'The last assembly order number handed out per company. Written only by assign_assembly_reference.';

COMMENT ON TABLE erp_boms IS 'Bill of materials versions (ADR-0011). Never changed: a change is a new version, and the old one is superseded.';

COMMENT ON TABLE erp_mrp_plans IS 'A planning run (ADR-0011): a snapshot of what to build and buy, not a schedule.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT ON TABLE assembly_reference_counters TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE assembly_reference_counters TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_assembly_orders TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_assembly_orders TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_bom_components TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_bom_components TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_boms TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_boms TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_mrp_plans TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_mrp_plans TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_mrp_suggestions TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_mrp_suggestions TO integr8_platform;
