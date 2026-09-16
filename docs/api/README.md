# The API

One HTTP service in front of Postgres. Clients never query Supabase directly.

| Document                                  | When you need it                      |
| ----------------------------------------- | ------------------------------------- |
| [versioning.md](./versioning.md)          | Before changing any endpoint's shape  |
| [`docs/auth/`](../auth/README.md)         | Tokens, roles, sessions               |
| [`docs/database/`](../database/README.md) | Tenant isolation underneath all of it |

---

## The request pipeline

Ordered so the cheapest rejection happens first and nothing expensive runs for a
request that was never going to be served.

1. **Context and request id** — so everything after it can be traced.
2. **Client version** — an unsupported build is told once, clearly.
3. **Per-IP rate limit** — before any database work.
4. **Validation** — zod, against the schema in the route definition.
5. **Authentication** — verify the bearer token. A `platform` route takes a
   super admin's token instead (P15), and re-reads its session from the
   database, so signing a dashboard out takes effect at once rather than when
   its token lapses.
6. **Suspension** — a suspended company is refused here, reads included.
7. **Permission** — the matrix in `@integr8/core`.
8. **Per-tenant rate limit** — one noisy company must not starve another.
9. **Idempotency** — claim the key, then run the handler.

Validation runs _before_ authentication. That means an anonymous caller can
learn that a body is malformed, which is not a secret; the reverse order would
make every schema change a potential authentication oracle.

## One declaration per endpoint

A route is a single value — method, path, schemas, who may call it, whether it
is idempotent, and the handler. Fastify registers it and the OpenAPI document is
generated from the same object, so the published contract cannot drift from the
code because there is nothing for it to drift from.

```ts
export const inviteMemberRoute = defineRoute({
  method: 'post',
  path: '/v1/members/invitations',
  operationId: 'inviteMember',
  summary: 'Invite somebody to this company',
  tags: ['workspace'],
  security: 'authenticated',
  permission: 'member.invite',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({ email: z.string(), role: roleSchema }),
  responses: { 201: { description: '…', schema: invitationSchema } },
  handler: async ({ body }, context) => {
    /* … */
  },
});
```

Add it to `routes/index.ts` and it is registered, documented, validated,
authorised and rate-limited. There is no second place to remember.

## The error model

Every failure, without exception:

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

- `code` is for the client's code, and is part of the contract.
- `message` is for a person, and never contains anything a stranger should not
  read.
- `details` is field-level, so a form highlights the input rather than showing
  one message above everything.
- `requestId` is the same id on every server log line for that request.

An unexpected exception becomes a 500 with no detail. Its message was written
for us, not for a stranger; it is logged in full and sent to Sentry.

## Background jobs

A `jobs` table, a worker process, and no Redis. Retries use exponential backoff
with **full jitter** — doubling alone synchronises retries, so everything that
failed during a two-minute outage retries together the moment it ends, which is
how a recovering dependency gets knocked over a second time.

A job that exhausts its attempts becomes `dead` rather than disappearing,
keeping its payload and its last error for whoever looks at it. Requeuing one
after a fix is an update, not a migration between tables.

```bash
pnpm --filter @integr8/api worker
```

The worker is a separate process from the API. A job that pins a core or leaks
memory then degrades background work rather than every request, and the two
scale independently: a queue backlog is a reason to add workers, not web
containers.

Claiming is the one queue operation that cannot be tenant-scoped — a worker
polls for whatever work exists, and that spans companies. It runs on the owner
connection, and each claimed job is then executed inside a tenant transaction
for its own `tenant_id`, so the privilege stops at the claim.

## Rate limiting

Postgres-backed fixed windows, with an in-memory short circuit: once a bucket is
known to be over its limit, the decision is served from memory until that window
ends. The common case costs one cheap upsert; the abusive case costs nothing.

It **fails open**. A rate limiter that rejects everything when its store is
unreachable turns a degraded dependency into a full outage, and what it guards
against is abuse rather than correctness.

If it becomes a contention point the answer is Redis, and that is a P19
conversation. It is one class behind one method, which is what keeps that swap
small.

## Running it

```bash
cp apps/api/.env.example apps/api/.env      # plus packages/db and packages/auth
pnpm --filter @integr8/api dev

curl -s localhost:3000/health
curl -s localhost:3000/health/ready
```

```bash
pnpm --filter @integr8/api openapi           # regenerate openapi.json
pnpm --filter @integr8/api-client generate   # regenerate the typed client

pnpm test                                    # unit, no database
pnpm test:integration                        # needs a disposable Postgres
```

## What is deliberately not here yet

- **Product endpoints.** Customers, sites, work orders and forms are P06 and
  P10. What exists is the skeleton and one real surface — sessions, members and
  invitations — which is what makes the idempotency and error-model claims
  testable rather than theoretical.
