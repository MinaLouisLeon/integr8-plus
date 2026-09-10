# P04 — API skeleton and contract

**Version:** v0.1 Foundation
**Status:** `IN PROGRESS`
**Depends on:** P03

## Goal

A versioned HTTP API that shipped desktop and mobile binaries can keep calling for a
year without breaking.

## Scope

Framework, contract, error model, and generated clients. This phase exists because you
cannot force-update an app on an engineer's phone.

## Tasks

- [x] API service (NestJS or Fastify) with dependency injection and module boundaries
- [x] OpenAPI specification generated from code, published as a build artifact
- [x] Typed clients generated from the spec for web, desktop and mobile
- [x] `/v1` route prefix; a written policy that nothing breaking ships inside a version
- [x] `min_supported_client` response header, and a client-side "please update" path when it is not met
- [x] Uniform error model: machine-readable code, human message, field-level details, request id
- [x] Request context middleware attaching tenant id, user id and request id to every log line
- [x] Idempotency-key support on all mutating endpoints, backed by a dedupe table
- [x] Background job queue with retries, exponential backoff and a dead-letter queue
- [x] Rate limiting per tenant and per IP
- [x] Health and readiness endpoints
- [x] Sentry with release tagging; structured JSON logging

## Exit criteria

- [x] The generated client compiles in all three front-end apps
- [ ] Replaying a mutating request with the same idempotency key produces one effect, not two
- [ ] A client sending an outdated version header receives a clear, actionable response
- [ ] Every log line for a request carries the same request id, and it is returned to the caller

## Notes

- Choose REST + OpenAPI over tRPC here. tRPC's tight coupling is excellent inside a
  single deployable web app and painful when a six-month-old signed binary is still calling you.
- The idempotency table is what makes the mobile outbox in P12 safe. Build it now.

---

## What remains

The first exit criterion is met: `pnpm build` compiles the generated client into
`apps/web`, `apps/desktop` and `apps/mobile`, and an endpoint that changed shape would
stop all three compiling.

The other three are written as integration tests that drive real HTTP through the
assembled server, and none has run, because no Supabase project exists. This is the same
position P02 and P03 are in and it closes the same way:

1. **Finish the P02 runbook** —
   [`docs/database/runbook-supabase-setup.md`](../../docs/database/runbook-supabase-setup.md).
2. **Run the three suites** — `pnpm --filter @integr8/db test:integration`, then
   `@integr8/auth`, then `@integr8/api`. The last one covers all three remaining
   criteria: `server.integration.test.ts` has a `describe` block for each.
3. **Add `TEST_DATABASE_URL_AUTH` to CI** — step 8 of the runbook.

There is one piece of P04's surface deliberately absent rather than pending: **no
platform/super-admin endpoints**. P03 left platform sign-in unbuilt because it needs a
token shape that P15 should settle, so impersonation has no HTTP entry point yet. It is
recorded in P03's file and in `docs/api/README.md`.

## Decisions taken during implementation

- **Fastify with a hand-written composition root, not NestJS.** Module boundaries come
  from imports and from what one function chooses to expose, which is the same discipline
  a container enforces with more machinery. The deciding factor was schemas: zod is
  already the schema language in `@integr8/core`, and NestJS would have added
  class-validator beside it — two ways to describe the same shape, drifting.

- **One route declaration, used twice.** A route is a single value carrying its method,
  path, schemas, who may call it and whether it is idempotent. Fastify registers it and
  the OpenAPI document is generated from the same object, so the published contract
  cannot drift from the code because there is nothing for it to drift from. Decorators
  over handler classes were the alternative; this is more literal, and the whole contract
  for an endpoint is one thing a reviewer reads top to bottom.

- **Zod 4's native JSON Schema conversion, rather than a Fastify OpenAPI plugin.** One
  fewer dependency, no annotation layer to keep in step, and no version-compatibility
  risk between the plugin and the zod already in use. `io: 'input' | 'output'` matters
  more than it looks: a field with a default is optional on the way in and guaranteed on
  the way out, and generating a client from the wrong one either forces callers to send
  defaults or lets them treat a guaranteed field as possibly missing.

- **The spec and the generated client are committed, and CI fails if they drift.** A spec
  change is then a diff in review — which is the moment to notice that a field was
  removed and that removing it is a `/v2` — and the three client apps build without
  standing the API up first. Both are excluded from Prettier: formatting a file that is
  rewritten wholesale would make `pnpm format` and the drift check disagree about what it
  should contain.

- **Validation runs before authentication.** An anonymous caller can therefore learn that
  a body is malformed, which is not a secret. The reverse order would make every schema
  change a potential authentication oracle.

- **Idempotency is declared per route, not inferred from the verb.** The support exists
  for every mutating endpoint; two declare it today — inviting a member, and revoking
  one person's sessions. The auth endpoints deliberately do not: a retried sign-in should
  produce a working session rather than a replay of a token the client may have lost, and
  minting two sessions is two sessions rather than a duplicated effect. Revocations are
  naturally idempotent already, so a dedupe row would buy nothing.

- **The stored response is what makes a replay invisible.** Refusing the second attempt
  would be enough to avoid a duplicated effect and would leave the client with no answer.
  Storing status and body means the retry receives the original response and cannot tell
  it was not the first caller — which is what a phone on a marginal connection needs,
  because from its side "it failed" and "it succeeded and the reply was lost" are the
  same event.

- **The same key with a different body is a 409, not a replay.** That is a client bug, and
  replaying the first response would hide the bug and silently discard the second
  request. The fingerprint sorts object keys, so a client that rebuilt its payload
  between retries is not mistaken for one that changed the request.

- **A failed request releases its key.** Holding it would turn one transient error into a
  day of rejections for that client. Server errors are not recorded as completed either:
  a 500 is ours, it may be transient, and a retry deserves a real attempt.

- **A `jobs` table rather than pg-boss or Redis.** pg-boss runs its own migrations at
  startup into its own schema, which sits outside the discipline P02 established, and it
  has no concept of tenants. Redis is a second datastore to provision, secure, back up
  and pay for before there is a customer. The cost is about three hundred lines of queue
  code and throughput this workload is nowhere near needing.

- **Jobs are tenant-scoped; claiming them is not.** A worker polls for whatever work
  exists, and that spans companies — a question the tenancy model cannot answer.
  Enqueuing happens on the tenant connection with RLS armed; claiming runs on the owner
  connection; each claimed job is then executed inside a tenant transaction for its own
  `tenant_id`. The privilege stops at the claim, and it is one function.

- **The job lock is a lease, not a lock.** A worker killed mid-job would otherwise leave
  its rows claimed forever. The lease lapsing is what lets another worker pick them up.

- **Full jitter on retries.** Doubling alone synchronises them: everything that failed
  during a two-minute outage retries together the moment it ends, which is how a
  recovering dependency gets knocked over a second time. Full jitter — a random point in
  `[0, delay]` — spreads the earliest retries widest, and those are the ones that arrive
  while the dependency is still fragile.

- **The dead-letter queue is a status, not a second table.** A dead job keeps its
  payload, attempt count and last error, which is what somebody looking at it needs, and
  requeuing after a fix is an update rather than a migration between tables.

- **Rate limiting is Postgres-backed with an in-memory short circuit.** The counter has to
  be shared or the effective limit multiplies by the number of containers; an upsert per
  request is also a write an attacker can force. So once a bucket is known to be over its
  limit, the decision is served from memory until that window ends. It also **fails
  open**: a limiter that rejects everything when its store is unreachable turns a degraded
  dependency into a full outage, and what it guards against is abuse rather than
  correctness.

- **A fourth database role was not needed, but a fourth object was.**
  `rate_limit_buckets` is not tenant-scoped — an unauthenticated request has no tenant —
  so it is reached by `integr8_auth`, the pre-authentication role from P03. That role now
  reaches four objects rather than three, and the schema-invariant suite asserts the new
  list exactly.

- **Liveness and readiness answer different questions.** Liveness touches nothing else,
  because an orchestrator uses it to decide whether to _restart_ a container, and
  restarting a healthy API because its database is briefly unreachable turns a blip into
  an outage. Readiness checks that the schema matches this build, so a container that
  cannot serve is kept out of the load balancer rather than serving errors.

- **An unexpected exception becomes a 500 with no detail.** Its message was written for us
  and not for a stranger. It is logged in full and reported to Sentry with the request id
  attached, so the log search and the Sentry event meet.

- **Accepting an invitation does not return tokens.** It signs the person in, but the
  invitation token travels by email and may sit in a mailbox, a proxy log or a
  screenshot; handing back a live session in exchange would make every one of those a way
  in. The client signs in normally afterwards.

- **The worker is a separate process.** A job that pins a core or leaks memory then
  degrades background work rather than every request, and the two scale independently — a
  queue backlog is a reason to add workers, not web containers.

## Verified so far

| Claim                                     | How it was proven                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace builds and passes               | `pnpm build`, `lint`, `typecheck`, `test`, `format:check` — all green across 10 packages; 264 unit tests                               |
| The generated client compiles everywhere  | `openapi.json` → `openapi-typescript` → imported and constructed in `apps/web`, `apps/desktop` and `apps/mobile`; all three type-check |
| The spec is generated, not hand-written   | 15 operations across 14 paths, produced from the route registry; CI regenerates and fails on any diff                                  |
| The contract documents its own rules      | Versioning policy, headers and idempotency semantics are in the `info.description`, asserted by a test                                 |
| Version negotiation is not decorative     | 14 unit tests: pre-release suffixes tolerated, `1.10.0` correctly newer than `1.9.0`, a malformed minimum fails open                   |
| The error model is uniform                | 13 unit tests: one shape for every failure, field-level details prefixed by request part, `Retry-After` never zero                     |
| Request fingerprints are stable           | 11 unit tests: key order ignored at any depth, array order significant, absent distinguished from explicit null                        |
| Nothing logs a credential                 | 13 unit tests, including redaction at depth and of fields inherited from a parent logger                                               |
| Retry backoff will not stampede           | 6 unit tests, including that 200 samples of one attempt span the full jitter range                                                     |
| The client handles a second 401 correctly | 16 unit tests; writing them found a real gap — a retried request that failed again returned a raw result instead of throwing           |
| Against a live database                   | **Not yet run.** `server.integration.test.ts` covers the three remaining exit criteria; see "What remains"                             |
