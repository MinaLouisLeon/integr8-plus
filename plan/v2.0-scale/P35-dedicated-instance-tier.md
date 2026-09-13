# P35 — Dedicated-instance tier

**Version:** v2.0 Scale and Enterprise
**Status:** `NOT STARTED`
**Depends on:** P34

## Goal

A single enterprise customer can have their own database, in their own region — sold as a
paid tier, built only once someone has signed for it.

## Scope

Where the `getTenantDataSource(tenantId)` seam built in P02 finally pays off.

## Tasks

- [ ] Connection registry in the control plane, credentials encrypted with a KMS and per-tenant data keys
- [ ] `getTenantDataSource(tenantId)` returns a dedicated pool for tenants marked as such
- [ ] Supabase OAuth integration so a customer authorises provisioning into their own organisation
- [ ] Provisioning state machine: create project, run migrations, verify, register, roll back on failure
- [ ] **Migration orchestrator** — one job per tenant, per-tenant schema version tracking, retries, partial-failure handling
- [ ] Deploy gate refusing to ship an API version until every tenant is at the required schema version
- [ ] Application tolerance for tenants on different schema versions during a rollout
- [ ] Aggregate telemetry pushed from data planes to the control plane, since cross-tenant queries are no longer possible
- [ ] Per-tenant backup and restore verification
- [ ] Region selection at provisioning time
- [ ] Documented support model: what access you hold, and what the customer is responsible for
- [ ] Credential rotation without downtime

## Exit criteria

- [ ] A dedicated tenant and a pooled tenant run the same application code with no feature differences
- [ ] A migration applies across all tenants with per-tenant status visible and a failure isolated to one tenant
- [ ] A dedicated tenant's data never appears in a shared-tenant query, verified by the isolation suite
- [ ] Losing access to a dedicated tenant's database degrades only that tenant

## Notes

- Migrations across N independent databases are the permanent cost of this tier. Price it
  accordingly — three to five times the standard plan is a reasonable starting point.
- Holding a customer's service-role key weakens the "you own your data" claim. Decide, and
  document, whether you hold write access or only migration rights.
