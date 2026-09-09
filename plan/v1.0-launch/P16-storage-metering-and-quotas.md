# P16 — Storage metering and quotas

**Version:** v1.0 Launch
**Status:** `NOT STARTED`
**Depends on:** P09, P15

## Goal
You can see exactly how much R2 storage each company uses, trust the number, and act on it.

## Scope
The reporting and enforcement layer over the P09 ledger. This is the feature that
originally justified one bucket per company.

## Tasks
- [ ] Usage view per company: total bytes, object count, and a breakdown by images, video, PDFs and other
- [ ] Thirty and ninety day growth trend per company, plotted against the plan allowance
- [ ] Cloudflare GraphQL Analytics client reading `r2StorageAdaptiveGroups` per bucket
- [ ] Nightly reconciliation job comparing the ledger total against Cloudflare's reported bucket size
- [ ] Drift alert when the two disagree beyond a threshold, naming the company
- [ ] R2 operations and transfer per company (Class A and Class B), so expensive tenants are visible early
- [ ] Quota enforcement: warn at eighty percent, block or bill at one hundred, per plan
- [ ] In-app warning to the company before they hit their limit, not after
- [ ] Company-facing usage view, showing them the same numbers you see
- [ ] Platform-wide totals and projected monthly Cloudflare cost
- [ ] Retention policy job deleting media past the plan's retention window

## Exit criteria
- [ ] For every company, the dashboard figure matches Cloudflare's reported bucket size within one percent
- [ ] Uploading past a company's quota is refused with a clear, actionable message
- [ ] The reconciliation job runs nightly, and a deliberately introduced drift raises an alert
- [ ] A company approaching their limit is warned automatically, without you noticing first

## Notes
- Two numbers exist and both matter. The ledger is what you **bill** from, because it is
  attributable to a company, a file and a job. Cloudflare is what you **audit** against.
  When they disagree, the ledger is wrong until proven otherwise — investigate the sweeper.
- At volume, replace the nightly job with R2 event notifications into a queue so usage
  updates within seconds. That is tracked separately as a Scale item.
