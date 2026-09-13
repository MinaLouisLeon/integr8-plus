# P12 — Offline sync engine

**Version:** v0.3 Field Loop
**Status:** `NOT STARTED`
**Depends on:** P11

## Goal

Work done without signal arrives at the server intact, exactly once, in order — and the
engineer can see that it did.

## Scope

The hardest phase in the plan. Give it the time it needs; every shortcut here becomes a
data-loss incident later.

## Tasks

- [ ] Outbox table: every mutation recorded as a durable, ordered, retryable record
- [ ] Client-generated UUIDv7 idempotency key on every mutation, deduped by the server table from P04
- [ ] Delta pull with a change cursor, **scoped to this engineer's assignments only** — never a whole tenant
- [ ] Push loop with exponential backoff, retry limits, and a permanent-failure state that surfaces to the user
- [ ] Per-entity version numbers; server is the authority
- [ ] Conflict detection and a resolution screen showing both versions in human terms
- [ ] Attachment queue, separate from the mutation queue: chunked, resumable, surviving app kill
- [ ] Sync status UI: items pending, last successful sync, current activity, manual force-sync
- [ ] Background sync respecting battery and network type
- [ ] Clock-skew handling — device time cannot be trusted for ordering
- [ ] Instrumentation: sync duration, queue depth, failure rate, reported to the server
- [ ] Test harness that simulates flaky networks, mid-upload kills, and clock skew

## Exit criteria

- [ ] A full job completed in aeroplane mode — answers, ten photos, two signatures — arrives complete after reconnection
- [ ] Killing the app during upload and reopening it resumes without duplicating or losing anything
- [ ] The same job edited on two devices offline produces a resolvable conflict, never silent data loss
- [ ] Replaying the entire outbox twice produces identical server state
- [ ] An engineer can tell at a glance whether it is safe to leave site

## Notes

- Attachments are the number one sync failure source. Keep their queue separate from the
  mutation queue so a stuck 40MB video never blocks a completed job from arriving.
- Submissions are append-only, so they rarely conflict. Job assignment and status are
  where conflicts actually happen — design the resolution screen around those.
