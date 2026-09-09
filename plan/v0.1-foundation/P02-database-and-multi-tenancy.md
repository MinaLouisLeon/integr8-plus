# P02 — Database and multi-tenancy

**Version:** v0.1 Foundation
**Status:** `NOT STARTED`
**Depends on:** P01

## Goal
A Postgres schema where it is structurally difficult to leak one company's data to
another, and a migration process that is safe to run against production.

## Scope
The tenancy model, the migration toolchain, and the isolation test harness. This is the
most consequential phase in the entire plan.

## Tasks
- [ ] Supabase project created; connection through Supavisor in transaction mode
- [ ] Migration tooling with ordered files and a version table — never ad-hoc schema pushes
- [ ] Core tables: `tenants`, `tenant_users`, `platform_users`, `audit_log`
- [ ] Every tenant-scoped table carries a non-null `tenant_id` with a foreign key
- [ ] Repository layer that injects `tenant_id` into every query; raw query access is lint-banned outside it
- [ ] RLS enabled on every tenant table, policies keyed on a JWT claim, as a backstop behind the repository layer
- [ ] `getTenantDataSource(tenantId)` — returns the shared pool today; the seam P35 later changes
- [ ] Warm LRU connection pool keyed by tenant, sized and bounded
- [ ] Automated tenant-isolation test suite: for every table and endpoint, prove tenant A cannot read or write tenant B
- [ ] Seed script producing two demo companies with overlapping-looking data
- [ ] Automated daily backup plus a written, rehearsed restore procedure
- [ ] Expand/contract migration convention documented with a worked example

## Exit criteria
- [ ] The isolation suite runs in CI and fails the build if any cross-tenant access succeeds
- [ ] Deliberately removing a `tenant_id` filter from one repository method makes the isolation suite fail
- [ ] A migration can be applied and rolled back against a copy of production data
- [ ] A restore from backup has been performed end to end and timed

## Notes
- RLS is the backstop, not the primary control. The repository layer is the primary
  control. Relying on RLS alone makes every future query a security review.
- Run the API on long-lived containers, not serverless functions. Per-tenant connection
  pools and serverless cold starts are incompatible.
