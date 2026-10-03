# Roadmap — the version ladder

Each version answers one question. Do not start the next until the current one's
question is answered honestly.

| Version                 | Question it answers                            | Rough size |
| ----------------------- | ---------------------------------------------- | ---------- |
| **v0.1 Foundation**     | Can we build safely on this?                   | 3–4 weeks  |
| **v0.2 Form Engine**    | Can a non-developer build a form that works?   | 4–6 weeks  |
| **v0.3 Field Loop**     | Does it work in a basement with no signal?     | 6–8 weeks  |
| **v1.0 Launch**         | Will someone pay for it?                       | 6–8 weeks  |
| **v1.1 Inventory**      | Can they stop using their spreadsheet?         | 3–4 weeks  |
| **v1.2 Scheduling**     | Can the dispatcher run their whole day here?   | 3–4 weeks  |
| **v1.3 Reporting & AI** | Why would they renew?                          | 4–6 weeks  |
| **v2.0 Scale**          | Can we sell to a company with a security team? | open-ended |

Sizes assume one experienced full-stack developer working steadily. They are for
sequencing, not for promising dates to anyone.

---

## Why this order

**Foundation is not optional and cannot be retrofitted.** Multi-tenant isolation, API
versioning and migration discipline are load-bearing. Every hour skipped here is repaid
with interest during a production incident.

**The form engine comes before the field app.** It is the hardest correctness problem in
the product and the thing competitors cannot easily copy. Version immutability in
particular must be right on the first attempt: publish freezes a version, and every
submission records which version it answered. Get that wrong and editing a form silently
corrupts historical data — the single most common way form-builder products die.

**Offline sync is its own version.** It is where the hard bugs live: idempotency, ordering,
conflict resolution, resumable uploads that survive an app being killed. Attempting it in
parallel with feature work guarantees both are done badly.

**Billing comes late, but before the first customer.** Building payments before anyone
wants to pay is a common way to waste two months.

**Inventory and scheduling come after launch deliberately.** They are large, well-understood
modules with no technical risk. Real customer feedback should shape them, and shipping
without them proves whether the core loop is actually valuable.

**Arabic and RTL are split across two points.** The _plumbing_ — the i18n framework,
logical CSS properties, RTL-safe layout primitives, locale-aware formatting — lands in
**P05**, at the start of UI work. The _translation and RTL QA pass_ is **P32**. Retrofitting
RTL into a codebase built with hardcoded left/right is significantly harder than doing it
right from the first screen, so the plumbing is not allowed to slip.

**The dedicated-instance tier is last, on purpose.** The `getTenantDataSource(tenantId)`
seam is built in P02 and returns the same shared pool for everyone. When an enterprise
buyer demands their own database, P35 changes what that function returns. Building the
isolation before a signed contract means paying the full cost with none of the revenue.

---

## Version exit criteria

A version is done when all its phases are complete **and** its exit criteria hold.

### v0.1 Foundation

- A new company can be created and its users cannot see any other company's data,
  proven by an automated test suite running in CI.
- A migration can be written, reviewed and applied through CI, not by hand.
- All four applications build, boot, and report errors to Sentry with a release tag.

### v0.2 Form Engine

- An admin builds a ten-field form with conditional logic and publishes it, without
  a developer.
- Editing and republishing that form does not alter any existing submission.
- The same validation rules produce identical results on the client and on the server.

### v0.3 Field Loop

- An engineer completes a full job in aeroplane mode — including photos and a
  signature — and everything arrives intact after signal returns.
- Killing the app mid-upload loses nothing.
- The same job edited on two devices offline produces a resolvable conflict, not
  silent data loss.

### v1.0 Launch

- A company signs up unaided, pays, and onboards without you touching a terminal.
- You can see that company's exact storage usage in your dashboard.
- A restore from backup has been rehearsed, not merely configured.
- Desktop and mobile builds are signed, notarised and distributable.

### v1.1 – v1.3

- Each version's modules are in daily use by at least one paying company before the
  next version starts.

### v2.0

- The product passes an external penetration test and a customer security questionnaire.
