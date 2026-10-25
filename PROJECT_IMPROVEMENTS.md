# Project improvement ideas

Based on the current source and the project’s own status/runbook notes:

1. **Finish pilot readiness before widening scope — deferred for later review.** The CRM/ERP tracker marks the pilot phase as not started, and ETA e-invoicing is explicitly not production-ready. Complete a real PreProd submission and hardware-token signing path, accountant review, and a backup/restore rehearsal.
2. **Close the email-dependent workflow gaps — deferred.** Add CRM overdue follow-up reminders and supplier purchase-order delivery once the email channel is configured; both are recorded as pending in `docs/crm-erp/README.md`.
3. **Add end-to-end field workflow checks — schedule before production.** Cover an engineer completing a job offline, retrying media uploads, syncing after reconnect, and resolving a two-device conflict, plus role/tenant boundaries. Unit and API integration coverage exists; these cross-app release journeys provide a useful final safety net.
4. **Make integration tests reliable as one root command — deferred.** The AI implementation status records `pnpm test:integration` failing when DB, auth and API suites share a database concurrently. Isolate or serialize their fixtures so local runs match CI expectations.
5. **Keep project documentation aligned with shipped code — updated.** The README/roadmap omitted newer AI, CRM/ERP, document and ETA modules; the root README said 1.1.0 while `package.json` is 1.1.2. The overview, current-status note and original-roadmap context have now been synchronized.

**Current scope gaps called out by project docs:** CRM email reminders, sending purchase orders by email, CRM campaigns/automations (deferred), and production-ready ETA signing/submission. Some platform features are gated by tenant module, plan and permission settings, so their presence in source does not mean every company can use them.

## Suggested feature (proposal only)

**Customer self-service portal:** give each company's customers a secure branded place to track jobs, accept quotes, view invoices and download service reports. The product already has quote acceptance links and printable records, while customer-facing invoice access and communications are documented as gaps. This could reduce office follow-up and give customers one consistent view of their service history.
