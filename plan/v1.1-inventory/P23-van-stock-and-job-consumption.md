# P23 — Van stock and job consumption

**Version:** v1.1 Inventory and Assets
**Status:** `IN PROGRESS` — built as phase E2 of the CRM/ERP plan, with phone consumption per
[`docs/crm-erp/decisions/ADR-0005`](../../docs/crm-erp/decisions/ADR-0005-phone-parts-consumption.md).
Tracked in [`docs/crm-erp/README.md`](../../docs/crm-erp/README.md).
**Depends on:** P22

## Goal

An engineer's van is a stock location that empties as they work and refills when they ask.

## Scope

The mobile side of inventory, and the link between parts and jobs.

## Tasks

- [x] Van stock visible on the mobile app, offline (E2: the first pull page carries the van's stock; the picker shows a forecast net of unsent uses)
- [x] Parts consumed on a job, deducted from that engineer's van (E2; a short van refuses and flags, never goes negative)
- [ ] Barcode scanning for every stock movement on mobile (receiving, lot picking and assets scan; the part picker and van refill do not yet)
- [x] Non-stock parts — the one-off item bought at a merchant that morning (F2: `work-order-purchases.ts`)
- [x] Van replenishment requests from the phone; warehouse picks and transfers (F2: `van-requests.ts`)
- [x] Stock movements queued through the P12 outbox and reconciled on sync (E2: `work_order.material`, posted once per phone action)
- [ ] Parts usage reporting by engineer, customer, asset and job type (by engineer, customer and job type today, `analytics.ts`; not by asset)
- [x] Returns from van to warehouse (E2: transfers from the web and desktop; returns of unused parts from the job)

## Exit criteria

- [ ] Parts consumed offline reconcile correctly when two engineers sync in a different order than they worked
- [ ] Scanning a barcode on the phone records the movement without typing
- [ ] Van stock in the app matches a physical count of the van, verified once in the field

## Notes

- Offline stock movements are the one place where the append-only ledger genuinely saves you.
  Two engineers consuming the same part offline is not a conflict; it is two ledger entries.
