# P04 — API skeleton and contract

**Version:** v0.1 Foundation
**Status:** `NOT STARTED`
**Depends on:** P03

## Goal
A versioned HTTP API that shipped desktop and mobile binaries can keep calling for a
year without breaking.

## Scope
Framework, contract, error model, and generated clients. This phase exists because you
cannot force-update an app on an engineer's phone.

## Tasks
- [ ] API service (NestJS or Fastify) with dependency injection and module boundaries
- [ ] OpenAPI specification generated from code, published as a build artifact
- [ ] Typed clients generated from the spec for web, desktop and mobile
- [ ] `/v1` route prefix; a written policy that nothing breaking ships inside a version
- [ ] `min_supported_client` response header, and a client-side "please update" path when it is not met
- [ ] Uniform error model: machine-readable code, human message, field-level details, request id
- [ ] Request context middleware attaching tenant id, user id and request id to every log line
- [ ] Idempotency-key support on all mutating endpoints, backed by a dedupe table
- [ ] Background job queue with retries, exponential backoff and a dead-letter queue
- [ ] Rate limiting per tenant and per IP
- [ ] Health and readiness endpoints
- [ ] Sentry with release tagging; structured JSON logging

## Exit criteria
- [ ] The generated client compiles in all three front-end apps
- [ ] Replaying a mutating request with the same idempotency key produces one effect, not two
- [ ] A client sending an outdated version header receives a clear, actionable response
- [ ] Every log line for a request carries the same request id, and it is returned to the caller

## Notes
- Choose REST + OpenAPI over tRPC here. tRPC's tight coupling is excellent inside a
  single deployable web app and painful when a six-month-old signed binary is still calling you.
- The idempotency table is what makes the mobile outbox in P12 safe. Build it now.
