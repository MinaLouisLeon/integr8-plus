# P22 — Item catalogue and stock ledger

**Version:** v1.1 Inventory and Assets
**Status:** `NOT STARTED`
**Depends on:** P21

## Goal

Stock levels that are always correct because they are derived, never stored.

## Scope

The catalogue and the movement ledger. Everything in v1.1 rests on getting this model right.

## Tasks

- [ ] Item catalogue: SKU, name, description, category, unit of measure, barcode, supplier, cost and sale price
- [ ] Stock locations: warehouse, each engineer's van, customer sites
- [ ] **Immutable movement ledger** — receive, issue, transfer, adjust, return, consume, scrap. Quantities are always derived from it, never written directly
- [ ] Derived stock level views, materialised where performance requires
- [ ] Serial number and batch tracking
- [ ] Reorder levels per location with low-stock alerts
- [ ] Stock takes and cycle counts, with a variance report and an approval step for write-offs
- [ ] Suppliers directory with lead times and supplier part numbers
- [ ] Item images and attached datasheets
- [ ] Stock movement history, filterable and exportable

## Exit criteria

- [ ] There is no code path anywhere that updates a quantity directly
- [ ] Replaying the full ledger from zero reproduces current stock levels exactly
- [ ] A stock take variance produces an auditable adjustment naming who approved it
- [ ] Stock level queries over a hundred thousand movements return in under 300ms

## Notes

- The temptation to keep a mutable `quantity` column "for speed" is the single most common
  way inventory modules become permanently untrustworthy. Materialise a view instead.
