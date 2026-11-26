# The API

`apps/api`: one Fastify service serving `/v1`, in front of Postgres. Every
client (web, desktop, phone, the developer MCP server, company websites) goes
through it. At 2.0.0 it has 446 paths and 553 operations (459 routes need a
company session, 67 a staff session, 31 none). The full request and response
schemas are in the generated `apps/api/openapi.json` (large: query it with a
small script rather than reading it whole). The integration tests in
`apps/api/src/routes/v1/*.integration.test.ts` are the best examples of valid
flows.

## The request pipeline

Cheapest rejection first:

0. **CORS.** An allow-listed origin (`API_CORS_ORIGINS`) gets its headers; any
   other is refused at preflight (`http/cors.ts`).
1. **Context and request id.**
2. **Client version.** A build below `API_MIN_SUPPORTED_CLIENT` gets `503
client_too_old` with where to update (`http/client-version.ts`).
3. **Per-address rate limit**, before any database work.
4. **Validation** (zod, from the route's own schemas). It runs before
   authentication on purpose: a malformed body is not a secret, and the reverse
   order would make schema changes an authentication oracle.
5. **Authentication.** The bearer token's signature, then (after an
   impersonation grant check) that its session is still live, cached 30 s per
   session. Platform routes take a staff token and re-read the session every
   time; a session limited to test companies is checked here
   (`http/session-scope.ts`).
6. **Suspension.** A suspended company is refused, reads included
   (`http/suspension.ts`).
7. **Permission**, from the matrix in `@integr8/core`.
8. **Module switch.** A route that names a `feature` is refused with 403
   `feature_disabled` to a company without that module (`http/features.ts`).
   Hiding a menu entry is never the only thing in the way.
9. **Per-company rate limit**, so one company cannot starve another.
10. **Idempotency**, then the handler.

## One declaration per endpoint

A route is one value (`defineRoute`): method, path, `operationId`, schemas,
`security` (`authenticated`, `platform` or `public`), `permission` (or
`anyPermission`), `feature`, `idempotent`, `platformScopes`, responses and the
handler. Adding it to `apps/api/src/routes/index.ts` registers, documents,
validates, authorises and rate-limits it. The OpenAPI document carries who may
call each route as `x-integr8-permission`, `x-integr8-any-permission`,
`x-integr8-feature`, `x-integr8-idempotency` (`required` or `honoured`) and
`x-integr8-platform-scopes`.

After changing a route:

```bash
pnpm --filter @integr8/api openapi && pnpm --filter @integr8/api-client generate
```

and commit both `openapi.json` and the client; CI fails on drift.

## Headers

| Header                 | Direction | Meaning                                                            |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| `x-client-app`         | Request   | `web`, `desktop` or `mobile`. Required                             |
| `x-client-version`     | Request   | The client build, e.g. `2.0.0`. Required                           |
| `Authorization`        | Request   | `Bearer <access token>` (the web's server adds it from its cookie) |
| `Idempotency-Key`      | Request   | On writes that declare it                                          |
| `min-supported-client` | Response  | The oldest build this deployment serves, on every response         |
| `x-request-id`         | Response  | Also on every log line for the request                             |
| `x-api-release`        | Response  | The build serving the request                                      |
| `idempotent-replay`    | Response  | `true` when the answer was replayed                                |

## Errors

Every failure has one shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body is not valid.",
    "details": [{ "field": "body.email", "code": "too_small", "message": "…" }],
    "requestId": "018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071"
  }
}
```

`code` is the contract; `message` is for developers and never shown to a person
(each app translates the code); `details` are per field; `requestId` matches the
logs. An unexpected exception is a 500 with no detail, logged in full and sent
to Sentry. Some routes answer `204` with no body.

## Idempotency

A write sent with `Idempotency-Key` is recorded in `idempotency_keys` with a
fingerprint of the request: a retry with the same key replays the first answer,
and the same key with a different request answers 409 `idempotency_key_reused`.
The fingerprint is an HMAC-SHA256 (key derived from `PLATFORM_SECRET_KEY`) over
the method, path and body **without its secret fields** (names containing
`password` or `secret`, names ending in `token`, and `code`/`otp` under
`/v1/auth/` and `/v1/me/`). Records last `API_IDEMPOTENCY_TTL_SECONDS` (24 hours),
or `SYNC_REPLAY_DAYS` (90) for a phone's change; the worker's housekeeping
deletes spent ones. `legacyFingerprint` in `http/idempotency.ts` still matches
the 1.x form of the fingerprint; no such record exists on a 2.0.0 database, so
it can be removed.

## Rate limits

Postgres-backed fixed windows with an in-memory short circuit once a bucket is
over: per address (`API_IP_RATE_LIMIT`), per company (`API_TENANT_RATE_LIMIT`),
and their own for the website lookup (`WEBSITE_LOOKUP_RATE_LIMIT`). The limiter
**fails open**: one that refused everything when its store was down would turn a
degraded dependency into an outage. The per-address sign-in limit counts
failures only, and the web server passes on the visitor's address.

## Background jobs

A `jobs` table and the worker process; no Redis. Retries back off exponentially
with full jitter; a job that exhausts its attempts becomes `dead`, keeping its
payload and last error. Claiming spans companies (the platform connection); each
claimed job then runs inside a tenant transaction for its own `tenant_id`. The
worker's scheduled tasks are listed in [architecture.md](../architecture.md#the-worker).

## Versioning: nothing breaking inside `/v1`

Shipped desktop and phone builds cannot be forced to update, so inside `/v1`
only additive changes are allowed:

| Allowed                                                              | Not allowed                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| A new endpoint, optional request field, response field or error code | Removing or renaming an endpoint or a response field |
| A new value in a response enum (clients keep a default branch)       | Making an optional request field required            |
| Relaxing a validation rule                                           | Narrowing a type or a rule, changing a default       |
|                                                                      | Changing what a field or an error code means         |

A change that cannot be additive ships as a new endpoint beside the old one.
The old one is removed only once no supported build calls it, by raising
`API_MIN_SUPPORTED_CLIENT`; an older build then gets `503 client_too_old` with a
sentence it can show and an `update_url` (`API_UPDATE_URL`, or by default Integr8
Plus's page on the Integr8 Media website).

## Facts worth knowing before calling it

- Work-order transitions need `expectedRevision`. A completed, reviewed or
  cancelled job refuses starting a form and submitting a draft on it
  (`submission_job_closed`). INSPECT and INSTALL job types require certificates.
- Company `workingDays` are ISO numbers 1–7 (Monday = 1).
- Passwords must not contain the email's local part
  (`packages/auth/src/password-policy.ts`).
- Platform routes declare `platformScopes`; without one, a session limited to
  test companies gets 403 `session_scope`.

## Areas, by path

| Prefix                                                                                                   | Area                                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `/v1/auth`, `/v1/me`, `/v1/sessions`, `/v1/invitations`                                                  | Sign-in and the signed-in person                            |
| `/v1/members`, `/v1/roles`                                                                               | People and company roles                                    |
| `/v1/settings`, `/v1/onboarding`, `/v1/billing`, `/v1/plans`, `/v1/signup`                               | The company and its plan                                    |
| `/v1/customers`, `/v1/sites`, `/v1/customer-tags`, `/v1/attachments`                                     | Customers and sites                                         |
| `/v1/work-orders`, `/v1/visits`, `/v1/schedule`, `/v1/timesheets`, `/v1/job-types`, `/v1/saved-views`    | Field work                                                  |
| `/v1/qualification-types`, `/v1/qualification-settings`, `/v1/qualifications`                            | Skills and certificates                                     |
| `/v1/contracts`, `/v1/maintenance-plans`, `/v1/maintenance`, `/v1/deadline-rules`, `/v1/deadline-report` | Contracts and deadlines                                     |
| `/v1/forms`, `/v1/form-templates`, `/v1/submissions`                                                     | Forms                                                       |
| `/v1/document-templates`, `/v1/documents`, `/v1/business-documents`                                      | Documents                                                   |
| `/v1/media`, `/v1/storage`                                                                               | Files                                                       |
| `/v1/sync`                                                                                               | The phone                                                   |
| `/v1/imports`                                                                                            | CSV imports                                                 |
| `/v1/crm`, `/v1/analytics`                                                                               | CRM and its reports                                         |
| `/v1/sales`, `/v1/finance`, `/v1/ledger`                                                                 | Sales, invoices and payments, the ledger                    |
| `/v1/inventory`, `/v1/purchasing`, `/v1/assets`, `/v1/manufacturing`                                     | Stock, buying, assets, manufacturing                        |
| `/v1/hr`, `/v1/expenses`, `/v1/payroll`                                                                  | HR, expenses, payroll                                       |
| `/v1/eta`                                                                                                | E-invoicing                                                 |
| `/v1/ai`                                                                                                 | The assistant                                               |
| `/v1/public`, `/v1/website`, `/v1/build`                                                                 | No session: brand, quote links, company websites, CI builds |
| `/v1/platform`                                                                                           | Staff only                                                  |

`/health` and `/health/ready` are not reachable from the internet: Caddy keeps
them private ([deployment/](../deployment/README.md)).
