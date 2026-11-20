-- Undoes 0022: the ledger functions take back their bodies and every
-- security-definer function is executable by PUBLIC again, except those 0001,
-- 0003, 0008 and 0010 closed.

ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

DROP FUNCTION public.erp_ledger_capture(uuid, text, uuid, date, text, uuid);
DROP FUNCTION public.erp_ledger_try_post(uuid, uuid, boolean);
DROP FUNCTION public.erp_ledger_backfill(uuid);
DROP FUNCTION public.erp_ledger_backfill_more(uuid, date, text);
DROP FUNCTION public.erp_ledger_assert_company(uuid);

ALTER FUNCTION public.erp_ledger_capture_unchecked(uuid, text, uuid, date, text, uuid) RENAME TO erp_ledger_capture;
ALTER FUNCTION public.erp_ledger_try_post_unchecked(uuid, uuid, boolean) RENAME TO erp_ledger_try_post;
ALTER FUNCTION public.erp_ledger_backfill_unchecked(uuid) RENAME TO erp_ledger_backfill;
ALTER FUNCTION public.erp_ledger_backfill_more_unchecked(uuid, date, text) RENAME TO erp_ledger_backfill_more;

COMMENT ON FUNCTION erp_ledger_backfill_more(uuid, date, text) IS 'Queues documents of kinds added after 0034 for review. Security definer: the runtime role cannot write the queue.';

REVOKE EXECUTE ON FUNCTION erp_ledger_capture(uuid, text, uuid, date, text, uuid), erp_ledger_try_post(uuid, uuid, boolean), erp_ledger_backfill(uuid), prune_sync_touches(uuid, interval) FROM integr8_platform, integr8_app;
REVOKE EXECUTE ON FUNCTION erp_stock_lock_balance(uuid, uuid, uuid), erp_stock_lock_lot_balance(uuid, uuid, uuid) FROM integr8_platform;

GRANT EXECUTE ON FUNCTION reject_platform_user_membership() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_submission_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_submission_file_uses() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_file_usage() TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_work_order_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_work_order_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_work_order_assignment() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_work_order_visit_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_work_order_visit_assignee() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_qualification_override() TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_service_contract_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_maintenance_occurrence() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_coverage_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_deadline_miss() TO PUBLIC;
GRANT EXECUTE ON FUNCTION record_submitted_after_close() TO PUBLIC;
GRANT EXECUTE ON FUNCTION touch_sync() TO PUBLIC;
GRANT EXECUTE ON FUNCTION prune_sync_touches(uuid, interval) TO PUBLIC;
GRANT EXECUTE ON FUNCTION erp_stock_apply_movement() TO PUBLIC;
GRANT EXECUTE ON FUNCTION erp_stock_apply_lot_movement() TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_purchase_order_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_sales_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_finance_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION erp_payment_allocations_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION erp_payment_reversals_apply() TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_asset_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_journal_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION erp_ledger_capture(uuid, text, uuid, date, text, uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION erp_ledger_try_post(uuid, uuid, boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION erp_ledger_backfill(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_expense_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION assign_assembly_reference() TO PUBLIC;
GRANT EXECUTE ON FUNCTION erp_ledger_backfill_more(uuid, date, text) TO PUBLIC;
