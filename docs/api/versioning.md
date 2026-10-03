# The API versioning policy

**Nothing breaking ships inside a version.**

This is the rule P04 exists to establish, and it is not a style preference. A
signed desktop binary and an App Store build cannot be force-updated. At any
moment some fraction of traffic comes from software written months ago, still
installed, still under support — and it will keep calling whatever it was
compiled against.

---

## What may change inside `/v1`

Additive changes only. A client compiled against an older version of the spec
must keep working, unmodified, against a newer server.

| Change                                    | Allowed inside a version                               |
| ----------------------------------------- | ------------------------------------------------------ |
| Adding an endpoint                        | Yes                                                    |
| Adding an optional request field          | Yes                                                    |
| Adding a response field                   | Yes                                                    |
| Adding a value to a response enum         | Yes, with care — see below                             |
| Adding a new error `code`                 | Yes                                                    |
| Relaxing a validation rule                | Yes                                                    |
| Removing an endpoint                      | No                                                     |
| Removing or renaming a response field     | No                                                     |
| Making an optional request field required | No                                                     |
| Narrowing a type or a validation rule     | No                                                     |
| Changing what an error `code` means       | No                                                     |
| Changing a default value                  | No                                                     |
| Changing the meaning of an existing field | No — this is the worst one, because nothing catches it |

### Adding an enum value is additive but not free

A client that switches exhaustively over a response enum will fall through when
it meets a value that did not exist when it was compiled. Adding a value is
allowed, and every client must handle an unknown one — which means a default
branch, not an exhaustive switch, on anything that arrives from the server.

Request enums are the reverse: a client sending a value the server has never
heard of gets a 422, which is correct, so removing a request enum value is
breaking and adding one is not.

## How a breaking change actually ships

Not by breaking `/v1`.

1. **Add the new shape beside the old one.** A new field, a new endpoint, a new
   parameter. Both work.
2. **Deploy, and let clients adopt it.** Web is immediate. Desktop follows the
   updater. Mobile follows the app stores, which is weeks, and some devices
   never update at all.
3. **Raise `API_MIN_SUPPORTED_CLIENT`** once the remaining traffic below it is
   small enough to cut off deliberately. Those clients then get a clear message
   with somewhere to go, instead of a confusing failure.
4. **Remove the old shape** — which, if steps 1 to 3 were done, is no longer a
   breaking change, because nothing still calls it.

`/v2` exists for a redesign that cannot be expressed additively at all. It is a
second surface served alongside `/v1`, not a replacement for it, and it is a
large piece of work rather than an escape hatch for a rename.

## The headers that make this work

| Header                 | Direction | Meaning                                                             |
| ---------------------- | --------- | ------------------------------------------------------------------- |
| `x-client-version`     | Request   | The client build, e.g. `1.4.2`. Pre-release suffixes are ignored.   |
| `x-client-app`         | Request   | `web`, `desktop` or `mobile`.                                       |
| `min-supported-client` | Response  | The oldest build this deployment serves. On **every** response.     |
| `x-request-id`         | Response  | On every response, and on every log line for that request.          |
| `x-api-release`        | Response  | The build serving the request.                                      |
| `Idempotency-Key`      | Request   | On endpoints that declare it. See below.                            |
| `idempotent-replay`    | Response  | `true` when the response was replayed rather than freshly computed. |

A client that sends no version is served. `curl`, a health check and a partner
integration all have good reasons not to send one, and refusing them would turn
this header into a de-facto authentication mechanism it was never designed to
be. The clients that matter here — the ones that cannot be updated — are exactly
the ones that do send it.

## Idempotency

Endpoints marked idempotent in the spec accept `Idempotency-Key`. Replaying a
request with the same key returns the original status and body and repeats no
effect.

The rules a client needs to know:

- **Generate one key per logical operation**, not per attempt. Retrying reuses
  the key; a new operation gets a new key. A UUID is fine.
- **Reusing a key with a different body is a 409**, not a replay. That is a
  client bug, and answering it with the first request's response would hide the
  bug and discard the second request.
- **Two simultaneous requests with one key** produce one 409 and one real
  response. Retry the 409 shortly.
- **A failed request releases its key**, so the same key can be retried.
- **Keys are remembered for `API_IDEMPOTENCY_TTL_SECONDS`** — a day by default,
  which covers a phone that spent the night in a basement.

This is what makes the mobile outbox in P12 safe. From a phone, "the request
failed" and "the request succeeded and the reply was lost" are the same event.

## The spec is generated, and committed

`apps/api/openapi.json` is produced from the route registry in
`apps/api/src/routes/`. It is committed on purpose:

- a spec change shows up as a **diff in review**, which is the moment to notice
  that a field was removed and that removing it is a `/v2`;
- the three client apps build without standing the API up first.

CI regenerates it and fails if the result differs from what was committed, so
the published contract cannot drift from the code.

```bash
pnpm --filter @integr8/api openapi        # regenerate the spec
pnpm --filter @integr8/api-client generate # regenerate the typed client
```

## Deprecating a field

Mark it in the route's schema description, keep serving it, and log when it is
read so you can tell whether anybody still is. Remove it only after raising
`API_MIN_SUPPORTED_CLIENT` past every build that used it.

"Nobody should still be using that" is not evidence. The log line is.
