# 08 — Operations and self-hosting

What a production deployment of Integr8 needs, which of it can run on the
company's own servers, and what stands in the way. Written for PLAN.md §10.4
in the eighth round (ADR-0012), from the API's configuration
(`apps/api/src/config.ts`) and the deployment files (`deploy/`).

## How production is guarded

`assertProductionReady()` refuses to start the API with `APP_ENV=production`
when any of these is still a development stand-in: no `SENTRY_DSN`,
`MEDIA_STORAGE=local`, `GEOCODER=fake`, `PUSH_SENDER=recording`,
`BILLING_PROVIDER=recording`, `EMAIL_SENDER=recording`. Each stand-in is safe
on a laptop and fails silently in production (files vanish with a container,
sites are placed somewhere invented, nobody is told of a new job, invitations
never leave). The check is deliberate and stays: a self-hosted deployment
answers it with a real service, not by loosening it.

## The services

| Need              | Today in production                                     | Self-hostable?                              | What it would take                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database          | PostgreSQL 16 (`deploy/compose.yml` runs `postgres:16`) | Yes                                         | Nothing: already ours. Backups and restore drills are phase L                                                                                                                                                                                                                                                                                                                                           |
| Identity          | Supabase Auth (GoTrue), `SUPABASE_URL` and service key  | Yes                                         | Run GoTrue (or Supabase) ourselves. It needs a real SMTP channel for confirmation and recovery emails; email verification and recovery are not weakened to avoid that                                                                                                                                                                                                                                   |
| Our access tokens | Signed by the API (`AUTH_SIGNING_KEY`, ours)            | Yes                                         | Nothing: keys are generated and kept by the operator                                                                                                                                                                                                                                                                                                                                                    |
| File storage      | Cloudflare R2, a bucket per company                     | Partly                                      | The client speaks the S3 API with a configurable endpoint (`apps/api/src/media/r2.ts`), so MinIO or another S3 store can serve files. Two things are R2-specific: bucket creation and CORS rules per company, and storage metering through Cloudflare's GraphQL API (`cloudflare-usage.ts`); an S3 adapter would replace both, and needs an env setting for the endpoint (today it is set only in code) |
| Email             | Resend (`EMAIL_SENDER=resend`)                          | Not yet                                     | An SMTP sender behind the same interface as Resend's, with the same "checked at start-up" rule. Needed anyway for self-hosted GoTrue. Out of scope this round (no email work in ADR-0012)                                                                                                                                                                                                               |
| Push              | Expo push service (`PUSH_SENDER=expo`)                  | No, by nature                               | The phones are reached through Apple and Google; Expo relays to them. Direct APNs/FCM sending would remove Expo but not the platform services                                                                                                                                                                                                                                                           |
| Geocoding         | Mapbox (`GEOCODER=mapbox`)                              | Yes, with work                              | An adapter for a self-hosted geocoder (Nominatim or Pelias) behind the existing geocoder interface; accuracy in Egypt to be checked on real addresses                                                                                                                                                                                                                                                   |
| Error reporting   | Sentry (`SENTRY_DSN`)                                   | Yes                                         | A self-hosted Sentry (or a Sentry-compatible collector such as GlitchTip) takes the same DSN; no code change expected (not yet tried)                                                                                                                                                                                                                                                                   |
| Subscriptions     | Stripe (`BILLING_PROVIDER=stripe`)                      | Not needed for a self-hosted single company | Integr8's own billing of companies. A deployment that is not sold per company needs a "no billing" provider that the production check accepts explicitly; companies billed by invoice already exist as a mode (P18). Kept separate from company invoices (ERP-05)                                                                                                                                       |
| Mobile builds     | Expo EAS                                                | Partly                                      | Local builds are possible with the Expo tooling; store signing stays with Apple and Google                                                                                                                                                                                                                                                                                                              |

## What is not an external dependency

Everything the CRM and ERP modules added — leads to ledger, HR, payroll,
manufacturing — runs on PostgreSQL and the API alone. Exports are written by
the API or the browser; payslips, quotes and invoices print from the browser
(server-rendered PDFs are not built, by decision). The HR data key
(`HR_DATA_KEY`) and the platform secret are the operator's.

## Recommended order, when self-hosting is wanted

1. An S3-compatible storage adapter (endpoint from the environment; buckets
   and CORS through the S3 API; metering from our own records).
2. An SMTP email sender, then self-hosted GoTrue using it.
3. An explicit "no billing" provider for single-company deployments.
4. A self-hosted geocoder adapter, checked against real Egyptian addresses.

None of these is built in the eighth round; each would be its own decision.
