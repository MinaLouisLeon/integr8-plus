# P22 — Item catalogue and stock ledger

**Version:** v1.1 Inventory and Assets
**Status:** `DONE` (core) — built as phase E1 of the CRM/ERP plan; the accepted model is
[`docs/crm-erp/decisions/ADR-0003`](../../docs/crm-erp/decisions/ADR-0003-inventory-ledger.md) and
[`docs/crm-erp/07-finance-and-inventory-invariants.md`](../../docs/crm-erp/07-finance-and-inventory-invariants.md).
Tracked in [`docs/crm-erp/README.md`](../../docs/crm-erp/README.md).
**Depends on:** P21

## Goal

Stock levels that are always correct because they are derived, never stored.

## Scope

The catalogue and the movement ledger. Everything in v1.1 rests on getting this model right.

## Tasks

- [x] Item catalogue: SKU, name, description, category, unit of measure, barcode, cost and sale price (supplier link arrives with E2)
- [x] Stock locations: warehouse, each engineer's van, customer sites
- [x] **Immutable movement ledger** — receive, issue, transfer, adjust, return, consume, scrap. Quantities are always derived from it, never written directly
- [x] Derived stock level views, materialised where performance requires (`erp_stock_balances`, trigger-maintained, replay-checked)
- [ ] Serial number and batch tracking
- [x] Reorder levels per location with low-stock alerts (in-app list; no email yet)
- [x] Stock takes and cycle counts, with a variance report and an approval step for write-offs (posting is the approval, by a seat with `inventory.move`)
- [ ] Suppliers directory with lead times and supplier part numbers
- [ ] Item images and attached datasheets
- [ ] Stock movement history, filterable and exportable

## Exit criteria

- [x] There is no code path anywhere that updates a quantity directly
- [x] Replaying the full ledger from zero reproduces current stock levels exactly
- [x] A stock take variance produces an auditable adjustment naming who approved it
- [x] Stock level queries over a hundred thousand movements return in under 300ms (tested)

## Notes

- The temptation to keep a mutable `quantity` column "for speed" is the single most common
  way inventory modules become permanently untrustworthy. Materialise a view instead.
