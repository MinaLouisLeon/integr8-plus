# P24 — Asset register and service history

**Version:** v1.1 Inventory and Assets
**Status:** `NOT STARTED`
**Depends on:** P23

## Goal

Scanning a tag on a machine shows everything that has ever been done to it.

## Scope

The feature that turns a job list into a service history, and the one engineers demo to
their own managers.

## Tasks

- [ ] Asset register per site: make, model, serial, install date, warranty expiry, location within the site
- [ ] QR or NFC tag per asset, generated and printable from the desktop app
- [ ] Scan on arrival to open the asset, from the mobile app, offline
- [ ] Complete service timeline per asset: jobs, form submissions, parts fitted, photos
- [ ] Asset condition and status tracking
- [ ] Warranty expiry alerts
- [ ] Prefill a form from the previous submission against the same asset
- [ ] Asset import from CSV

## Exit criteria

- [ ] Scanning an asset tag with no signal opens its full local history
- [ ] Every job, submission and part fitted appears on the asset's timeline in order
- [ ] Printed tags scan reliably in poor light, tested on real equipment

## Notes

- Print durability matters. A paper label in a plant room lasts weeks; specify the
  material before a customer tags four hundred machines.
