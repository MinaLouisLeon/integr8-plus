# P23 — Van stock and job consumption

**Version:** v1.1 Inventory and Assets
**Status:** `NOT STARTED`
**Depends on:** P22

## Goal

An engineer's van is a stock location that empties as they work and refills when they ask.

## Scope

The mobile side of inventory, and the link between parts and jobs.

## Tasks

- [ ] Van stock visible on the mobile app, offline
- [ ] Parts consumed on a job, deducted from that engineer's van
- [ ] Barcode scanning for every stock movement on mobile
- [ ] Non-stock parts — the one-off item bought at a merchant that morning
- [ ] Van replenishment requests from the phone; warehouse picks and transfers
- [ ] Stock movements queued through the P12 outbox and reconciled on sync
- [ ] Parts usage reporting by engineer, customer, asset and job type
- [ ] Returns from van to warehouse

## Exit criteria

- [ ] Parts consumed offline reconcile correctly when two engineers sync in a different order than they worked
- [ ] Scanning a barcode on the phone records the movement without typing
- [ ] Van stock in the app matches a physical count of the van, verified once in the field

## Notes

- Offline stock movements are the one place where the append-only ledger genuinely saves you.
  Two engineers consuming the same part offline is not a conflict; it is two ledger entries.
