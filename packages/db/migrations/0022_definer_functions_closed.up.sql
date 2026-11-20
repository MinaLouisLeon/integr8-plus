-- SEC-002: functions that run as their owner are closed to everyone but the
-- role that calls them, and the ledger's ask which company is calling.
--
-- A SECURITY DEFINER function runs with the schema owner's rights, so row-level
-- security does not stop it. Postgres lets every role execute a new function
-- unless told otherwise, and only a few of these had been closed. The ledger
-- functions also took a company id without checking it against the caller's
-- company, so any role that could connect (the runtime role, the pre-auth role,
-- the Auth container's role) could post or queue entries in any company's
-- ledger. The API never did; this is the backstop.
--
-- 1. The four ledger functions keep their bodies under an `_unchecked` name,
--    closed to every role; the original names become short wrappers that
--    refuse another company's id when called on the runtime role's connection
--    (the same rule as `erp_stock_lock_balance`), then call the body. Callers
--    inside the database, which already run as the owner, are unchanged.
-- 2. Every security-definer function is closed to PUBLIC and opened only to
--    the role that calls it. Trigger functions need no grant: Postgres does not
--    check EXECUTE when a trigger fires.
-- 3. Functions this owner creates from now on start closed to PUBLIC; a
--    migration that adds one grants EXECUTE to the role that needs it.

-- One rule for every ledger wrapper: on the runtime role's connection, the
-- company named must be the transaction's own company.
CREATE FUNCTION public.erp_ledger_assert_company(p_tenant uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  scoped uuid := app_current_tenant_id();
begin
  if session_user <> 'integr8_app' then
    return;
  end if;
  if scoped is null then
    raise exception 'No company is set for this transaction'
      using errcode = 'insufficient_privilege';
  end if;
  if p_tenant is distinct from scoped then
    raise exception 'This ledger belongs to another company'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;

ALTER FUNCTION public.erp_ledger_capture(uuid, text, uuid, date, text, uuid) RENAME TO erp_ledger_capture_unchecked;
ALTER FUNCTION public.erp_ledger_try_post(uuid, uuid, boolean) RENAME TO erp_ledger_try_post_unchecked;
ALTER FUNCTION public.erp_ledger_backfill(uuid) RENAME TO erp_ledger_backfill_unchecked;
ALTER FUNCTION public.erp_ledger_backfill_more(uuid, date, text) RENAME TO erp_ledger_backfill_more_unchecked;

CREATE FUNCTION public.erp_ledger_capture(p_tenant uuid, p_kind text, p_source uuid, p_date date, p_currency text, p_actor uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  perform erp_ledger_assert_company(p_tenant);
  perform erp_ledger_capture_unchecked(p_tenant, p_kind, p_source, p_date, p_currency, p_actor);
end;
$$;

CREATE FUNCTION public.erp_ledger_try_post(p_posting uuid, p_actor uuid, p_force boolean DEFAULT false) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  owner_tenant uuid;
begin
  select tenant_id into owner_tenant from erp_ledger_postings where id = p_posting;
  if found then
    perform erp_ledger_assert_company(owner_tenant);
  end if;
  return erp_ledger_try_post_unchecked(p_posting, p_actor, p_force);
end;
$$;

CREATE FUNCTION public.erp_ledger_backfill(p_tenant uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  perform erp_ledger_assert_company(p_tenant);
  return erp_ledger_backfill_unchecked(p_tenant);
end;
$$;

CREATE FUNCTION public.erp_ledger_backfill_more(p_tenant uuid, p_start date, p_tz text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  perform erp_ledger_assert_company(p_tenant);
  return erp_ledger_backfill_more_unchecked(p_tenant, p_start, p_tz);
end;
$$;

COMMENT ON FUNCTION erp_ledger_assert_company(uuid) IS 'Refuses, on the runtime role''s connection, a company other than the transaction''s own (SEC-002).';
COMMENT ON FUNCTION erp_ledger_capture(uuid, text, uuid, date, text, uuid) IS 'Queues a document for the ledger and tries to post it, for the caller''s own company only (SEC-002). Security definer: the runtime role cannot write the queue.';
COMMENT ON FUNCTION erp_ledger_try_post(uuid, uuid, boolean) IS 'Posts one queued document, of the caller''s own company only (SEC-002).';
COMMENT ON FUNCTION erp_ledger_backfill(uuid) IS 'Queues a company''s documents since its ledger start date, for the caller''s own company only (SEC-002).';
COMMENT ON FUNCTION erp_ledger_backfill_more(uuid, date, text) IS 'Queues documents of kinds added after 0034, for the caller''s own company only (SEC-002).';

-- Closed to everyone, then opened to the role that calls each.
REVOKE ALL ON FUNCTION reject_platform_user_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_submission_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_submission_file_uses() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_file_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_work_order_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_work_order_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_work_order_assignment() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_work_order_visit_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_work_order_visit_assignee() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_qualification_override() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_service_contract_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_maintenance_occurrence() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_coverage_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_deadline_miss() FROM PUBLIC;
REVOKE ALL ON FUNCTION record_submitted_after_close() FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_sync() FROM PUBLIC;
REVOKE ALL ON FUNCTION prune_sync_touches(uuid, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_stock_apply_movement() FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_stock_lock_balance(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_stock_apply_lot_movement() FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_stock_lock_lot_balance(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION crm_opportunity_record_amount() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_purchase_order_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_sales_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_finance_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_payment_allocations_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_payment_reversals_apply() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_asset_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_journal_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_expense_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION assign_assembly_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION create_year_partition(regclass, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ensure_year_partitions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_ledger_capture(uuid, text, uuid, date, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_ledger_try_post(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_ledger_backfill(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_ledger_backfill_more(uuid, date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_ledger_capture_unchecked(uuid, text, uuid, date, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_ledger_try_post_unchecked(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_ledger_backfill_unchecked(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION erp_ledger_backfill_more_unchecked(uuid, date, text) FROM PUBLIC;

-- The runtime role: the ledger (directly, and through the invoice, credit note,
-- payment, stock, expense and payroll triggers, which run as the caller), the
-- stock balance locks and pruning its own sync log.
GRANT EXECUTE ON FUNCTION erp_ledger_capture(uuid, text, uuid, date, text, uuid), erp_ledger_try_post(uuid, uuid, boolean), erp_ledger_backfill(uuid), prune_sync_touches(uuid, interval), erp_stock_lock_balance(uuid, uuid, uuid), erp_stock_lock_lot_balance(uuid, uuid, uuid) TO integr8_app;

-- The platform role (BYPASSRLS already, so this widens nothing): the purge, the
-- year partitions, and the same functions for work it does across companies.
GRANT EXECUTE ON FUNCTION purge_tenant(uuid), ensure_year_partitions(integer), erp_ledger_capture(uuid, text, uuid, date, text, uuid), erp_ledger_try_post(uuid, uuid, boolean), erp_ledger_backfill(uuid), prune_sync_touches(uuid, interval), erp_stock_lock_balance(uuid, uuid, uuid), erp_stock_lock_lot_balance(uuid, uuid, uuid) TO integr8_platform;

-- Functions this owner creates from now on start closed to PUBLIC.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
