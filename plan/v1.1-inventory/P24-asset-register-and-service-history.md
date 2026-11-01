# P24 — Asset register and service history

**Version:** v1.1 Inventory and Assets
**Status:** `IN PROGRESS` — built as CRM/ERP plan phase E3 (see `docs/crm-erp/README.md`; ADR-0008). The last exit check, on real equipment and label stock, is a manual check before the pilot.
**Depends on:** P23

## Goal

Scanning a tag on a machine shows everything that has ever been done to it.

## Scope

The feature that turns a job list into a service history, and the one engineers demo to
their own managers.

## Tasks

- [x] Asset register per site: make, model, serial, install date, warranty expiry, location within the site
- [x] QR or NFC tag per asset, generated and printable from the desktop app
- [x] Scan on arrival to open the asset, from the mobile app, offline
- [x] Complete service timeline per asset: jobs, form submissions, parts fitted, photos
- [x] Asset condition and status tracking
- [x] Warranty expiry alerts
- [x] Prefill a form from the previous submission against the same asset
- [x] Asset import from CSV

## Exit criteria

- [x] Scanning an asset tag with no signal opens its full local history
- [x] Every job, submission and part fitted appears on the asset's timeline in order
- [ ] Printed tags scan reliably in poor light, tested on real equipment — the
      code is printed at error-correction level Q with its quiet zone, black on
      white; the check itself is on real label stock before the pilot
      (`docs/crm-erp/09-testing-and-qa.md`)

## Notes

- Print durability matters. A paper label in a plant room lasts weeks; specify the
  material before a customer tags four hundred machines.
- Delivered as QR codes holding a web link (`/a/<code>`); NFC is left for later
  (ADR-0008). A scan with the phone's own camera opens the web page; the app's
  scanner opens the phone's copy with no signal.
