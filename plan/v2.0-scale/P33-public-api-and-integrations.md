# P33 — Public API, webhooks and integrations

**Version:** v2.0 Scale and Enterprise
**Status:** `NOT STARTED`
**Depends on:** P28

## Goal

The product stops being a silo, and integration requests stop being your roadmap.

## Scope

The integration surface. Each item here is also a retention feature.

## Tasks

- [ ] Public REST API per tenant, from the existing OpenAPI spec, with scoped API keys
- [ ] Rate limiting and usage metering per API key
- [ ] Outbound webhooks: job completed, form submitted, stock low, with signed payloads and retries
- [ ] Published API documentation with worked examples
- [ ] Accounting export: QuickBooks, Xero, Zoho
- [ ] Zapier or Make connector, covering the long tail without writing each integration
- [ ] Email-to-job: forward a customer email to an address and a job is created
- [ ] Sandbox environment for integration developers

## Exit criteria

- [ ] A third party builds a working integration using only the published documentation
- [ ] Webhook delivery survives an endpoint being down for an hour, then delivers in order
- [ ] API keys are scopable to read-only and revocable instantly

## Notes

- The API already exists — this phase is about making a subset of it safe to expose, and
  documenting it. Do not build a second API.
