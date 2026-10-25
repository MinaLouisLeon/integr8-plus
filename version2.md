# Current status and remaining work (version 1.1.2)

Version **1.1.2** is the current root package version. The CRM/ERP suite in
this file shipped through PR #81; the AI assistant, business documents and ETA
e-invoicing integration were added afterward (database migrations 0044–0049).
This file tracks remaining pilot work, unproven launch checks and later roadmap
work. A feature being implemented does not mean its real-device or production
readiness checks have passed.

Sources: `docs/crm-erp/README.md` (tracker and follow-ups), `docs/crm-erp/PLAN.md`
(phase L), `plan/ROADMAP.md` and the phase files under `plan/`. When this file
and those disagree, those are right; update this file.

## Shipped scope as of 1.1.2

| Area                                                                  | State as of 1.1.2                                                                                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Field work (forms, jobs, customers and sites, offline phone, billing) | Built and verified in tests; several exit checks need real devices, real services or a real customer (section 3)                       |
| CRM (leads, opportunities, pipelines, activities, Customer 360)       | Done (phases F1–C3, F2, G1)                                                                                                            |
| Sales, finance, general ledger                                        | Done (S1, B1, A1)                                                                                                                      |
| Inventory, purchasing, van stock, serial numbers and batches          | Done (E1, E2, F2, G1)                                                                                                                  |
| Assets and service history                                            | Done (E3)                                                                                                                              |
| HR, expenses, Egyptian payroll, manufacturing                         | Done (H1, M1)                                                                                                                          |
| Company roles, drag-and-drop board, menus, amount history             | Done (G1)                                                                                                                              |
| Arabic                                                                | The whole interface is translated and right to left on web, desktop and phone; the formal Arabic review of P32 is still open           |
| AI assistant                                                          | Help, permission-scoped insights and confirmed actions shipped; configurable and off by default                                        |
| Business documents                                                    | Templates and printable business documents shipped                                                                                     |
| Egyptian e-invoicing                                                  | Offline integration built; live PreProd submission and hardware-token signing remain blocked                                           |
| Still to prove or build                                               | Pilot (L), scheduling (P25–P27), expanded reporting/communications (P28–P29), AI form authoring (P30), calendar (P31), scale (P32–P35) |

## 1. Phase L — the pilot release

From `docs/crm-erp/PLAN.md`, phase L. Done when a real company runs on the
product and the findings are written down.

- [ ] A sample company configured as a field-service business, with a demo dataset and no real customer data.
- [ ] A database upgrade rehearsed from the previous release, and backup and restore drills timed.
- [ ] Load, security and right-to-left tests.
- [ ] The onboarding flow validated end to end by someone who did not build it.
- [ ] Feedback gathered from the existing application logs (no paid analytics).
- [ ] Company data export and company deletion checked against every module added since they were built.
- [ ] Manual support procedures written: who answers, how a company is unstuck, how a release is rolled back.
- [ ] The pilot itself, with real customers, before any new feature surface (overlaps section 4, P21).

## 2. Follow-ups still open in the CRM/ERP plan

From the tracker's "Follow-ups that must not be lost".

### Waiting for an email channel

Email sending (Resend) is wired for invitations and payment reminders; these
need a decision on what the company's own customers receive, and from which
address.

- [ ] Email reminders for overdue CRM follow-ups (a background job).
- [ ] Sending a purchase order to the supplier as a PDF or email; today the record is kept and printed.
- [ ] Sending a quote's link and printed quote to the customer by email; today the office copies the link.

### Documents

- [ ] A PDF made by the server, with embedded fonts, for archiving and attachments; today printing goes through the browser. Shares its foundation with P29.

### Left from G1 (serial numbers and batches)

- [ ] Serial numbers and batches on the location screen and on a sales order's list of deliveries.
- [ ] Choosing which batch comes back when a part is returned from a job (today the batches it used, in order).
- [ ] A link from a serial number's receipt to its purchase order in the serial trace.

### On a real device

- [ ] The phone's serial and batch picking: scan a serial from the van offline, fit it, reconnect, find it on the asset.
- [ ] The phone's F2 screens: My van offline, van refill, a merchant part with a receipt photo in aeroplane mode, receiving goods by scan.

### Housekeeping

- [ ] Update `plan/ROADMAP.md` and the phase files P22–P24 for what the CRM/ERP rounds built.

### Deliberately deferred (a decision before any work)

- [ ] CRM-06 campaigns and automations: no marketing platform or bulk email exists.
- [ ] Manufacturing routings and work centres (M1 built bills of materials, assembly and planning only).
- [ ] Production ETA e-invoicing: offline integration exists, but live PreProd submission and hardware-token signing are not validated. ETA e-receipts, VAT on company invoices, tax returns and any compliance claim remain out of scope until separately reviewed.
- [ ] A legal review of the Egyptian payroll rule sets; today each company confirms the rules it uses.

## 3. Launch checks built but not yet proven (v0.1 – v1.1)

These phases are marked `IN PROGRESS` in `plan/` because their exit checks need
real services, real devices or a real person. The code is there; the proof is
not. Items already delivered since the phase file was written are left out.

### Data and backups (P02, P19)

- [ ] The production database on Supabase through the transaction pooler, or a documented decision to stay on the machine.
- [ ] Automated daily backups and point-in-time recovery, configured and tested.
- [ ] A migration applied and rolled back against a copy of production data.
- [ ] A restore from backup performed end to end and timed, with the time written down.

### Sign-in and the apps (P03, P05)

- [ ] Tokens kept in the operating system's keychain on desktop and secure storage on the phone, verified on real devices.
- [ ] The phone opens and shows cached work after seven days without a network.
- [ ] Every app signs in against the production API and shows the current person and company.
- [ ] An error thrown in each app reaches Sentry tagged with the app's version.

### Forms (P06, P07, P13, P13b)

- [ ] The same form and answers give identical validation results on the server and on a phone.
- [ ] A non-developer builds a ten-field form with two conditions in under fifteen minutes, observed.
- [ ] The builder's phone preview matches what the phone app renders.
- [ ] A twenty-field form with photos completed in aeroplane mode, surviving the app being closed mid-way.
- [ ] Every field type works on the phone, repeating sections included.

### Files on R2 (P09, P15, P16)

- [ ] Stored bytes per company match what Cloudflare reports for its bucket.
- [ ] A client lying about a file's size cannot corrupt the storage count.
- [ ] An abandoned upload leaves nothing behind after the clean-up job.
- [ ] Deleting a company removes its bucket contents as well as its records.

### Field work on the phone (P10, P11, P12, P14, P23)

- [ ] A real engineer works a real day using only the phone, observed, with notes.
- [ ] Site access notes are the first thing seen on the job screen, confirmed by an engineer.
- [ ] Every screen works in aeroplane mode with no network spinner for local data.
- [ ] Signing out leaves no readable company data on the device.
- [ ] A full job (answers, ten photos, two signatures) arrives complete after reconnecting; closing the app during upload loses and duplicates nothing.
- [ ] The same job edited on two phones offline gives a resolvable conflict.
- [ ] A push notification for a new assignment arrives within thirty seconds.
- [ ] Parts used offline by two engineers reconcile when they sync in a different order; a van's stock matches a physical count.

### Subscriptions (P17)

- [ ] Stripe in live mode, end to end (today verified against the recording provider and test mode).
- [ ] Limits on forms and modules by plan.
- [ ] Discount codes, per-company negotiated prices, proration when seats are removed.
- [ ] Tax on Integr8's own invoices and VAT number capture.
- [ ] An upgrade prompt shown when a plan limit is reached.

### Onboarding (P18)

- [ ] The time from first visit to first submitted form measured on real companies against the thirty-minute target. Public sign-up is off by decision, so this now means time from onboarding to first form.

### Production hardening (P19)

- [ ] Rate limits tuned per endpoint against real traffic.
- [ ] Sentry alert rules that tell a new error from a known one.
- [ ] Performance budgets (API response time, phone cold start, job list, sync) measured, with alarms.
- [ ] Database indexes reviewed against real query plans; slow query log watched.
- [ ] End-to-end tests of the critical paths: onboarding, building a form, completing a job offline, syncing.
- [ ] Dependency and secret scanning enforced in CI (licence checking is already in place).
- [ ] An incident runbook: who is called, how to roll back, how to tell customers.
- [ ] Terms of service, privacy policy and a data processing agreement published.
- [ ] The isolation test suite covering every endpoint, enforced by a coverage check.
- [ ] A deliberately broken deploy caught by monitoring before a person notices.
- [ ] A rollback procedure someone else could follow.

### Packaging, signing and release (P20)

- [ ] Apple developer account, certificates and notarisation for the macOS desktop app.
- [ ] A Windows code-signing certificate (organisation validation takes weeks).
- [ ] The desktop app's self-updater: signing keys, an update address, a tested rollback.
- [ ] Linux packages kept or explicitly dropped.
- [ ] iOS phone builds (today Android only, until an Apple account is connected).
- [ ] Store listings for each company's app (screenshots, descriptions, privacy declarations), with a demo account seeded for the stores' reviewers.
- [ ] Background location justified, or removed, before submission.
- [ ] Release channels (internal, beta, stable) for desktop and phone.
- [ ] The minimum supported app version enforced end to end, with a tested update prompt.
- [ ] A release checklist and changelog process.

## 4. The first customer (P21)

- [ ] Import their customers, sites and assets.
- [ ] Build their real forms with them in one session; set up their job types, roles, company roles and working hours.
- [ ] Switch on the modules they bought; set up their stock, chart of accounts and payroll rules if they use them.
- [ ] Train the office on the desktop and web apps, and the engineers on their own phones, in person.
- [ ] A pilot week alongside their current process, a daily check-in, every complaint logged word for word.
- [ ] Cut over fully, with a rollback plan.
- [ ] Record what they use and what they never open; write the findings up to shape the rest of version 2.
- [ ] Done when: a full week of real work in the product, engineers prefer it (asked directly), every complaint triaged, and they pay a second month without being chased.

## 5. v1.2 Scheduling and dispatch (not started)

### P25 — Calendar and dispatch board

- [ ] Day, week and month calendars, per engineer and combined.
- [ ] A dispatch board: engineers as columns, time down the page, jobs dragged between them.
- [ ] An unassigned queue by age and priority; inline job preview; bulk reschedule and reassign; keyboard shortcuts.
- [ ] Changes pushed to the engineer's phone at once; time zones per company and site; each dispatcher's view remembered.
- [ ] Done when: twenty jobs rescheduled in under five minutes; the board stays fast with two hundred jobs and thirty engineers; a phone reflects a change within thirty seconds.

### P26 — Availability, skills and conflicts

- [ ] Working patterns, shifts, leave and sickness per engineer (HR's employee profiles are the natural home).
- [ ] Skills and certifications with expiry; job types needing a skill; expiry alerts.
- [ ] Conflict detection: double booking, overtime, impossible travel; a map of jobs and engineers' last positions; travel time estimates.
- [ ] Reminders to engineer and customer before a job.
- [ ] Done when: an unqualified assignment is blocked or clearly warned, a lapsed certification removes eligibility, double booking cannot happen by accident.

### P27 — Preventive maintenance and reminders

- [ ] Recurring work on an asset, site or contract, generating jobs on a rolling horizon.
- [ ] Contracts and entitlements per customer; service level timers, warnings, breaches recorded and reported.
- [ ] Follow-up jobs carrying context; a capacity view; a self-booking link for customers.
- [ ] Done when: a quarterly rule is right across a daylight-saving change, editing a rule never disturbs completed jobs, a breach is recorded and reportable.

## 6. v1.3 Reporting, communications and AI-assisted form authoring (planned)

### P28 — Reporting and dashboards

Part of this exists (CRM and sales figures, value by stage, parts usage, ledger reports, CSV exports).

- [ ] An operations dashboard: open, overdue and completed jobs, engineer utilisation, jobs by status.
- [ ] Submission reports over form fields, exported to CSV and Excel; a custom report builder.
- [ ] Engineer performance: jobs per day, time on site, first-time fix rate.
- [ ] Service level compliance; inventory valuation, shrinkage and slow-moving stock.
- [ ] Period comparisons, shared saved views, scheduled reports by email.
- [ ] Done when: a year of the largest company's submissions reports in under three seconds; every figure drills down to a job; scheduled reports are right in a non-UTC time zone.

### P29 — Branded PDF reports and customer notifications

- [ ] A report designer mapping form answers onto a branded layout, with certificate numbering, photos, signatures and location.
- [ ] Automatic generation on job completion and email to the customer's contact.
- [ ] Customer notifications: on the way, arrived, completed, report attached; SMS for reminders.
- [ ] An in-app notification centre, per-person preferences, escalation of unacknowledged urgent jobs, digests for owners.
- [ ] Done when: a completed job produces and emails its PDF with no manual step; twenty photos and two signatures render; a customer's opt-out is respected everywhere.

### P30 — AI form generation

- [ ] A form drafted from a sentence, checked against the form schema, always landing as an editable draft.
- [ ] Field suggestions while building; improvements suggested for an existing form.
- [ ] Cost controls per company; graceful failure; drafts clearly labelled as generated.
- [ ] Forms are built by Integr8's staff today, so the first user is Integr8, not the company.
- [ ] Done when: "Quarterly HVAC inspection checklist" gives a draft that is edited rather than thrown away; nothing malformed reaches the builder; cost per form is measured and bounded.

### P31 — Meetings and calendar sync

- [ ] Meetings with attendees, agenda, place or video link, reminders, recurrence.
- [ ] Notes and action items becoming tasks with an owner and a due date.
- [ ] Two-way Google Calendar and Outlook sync for jobs and meetings; invitations for outside attendees; attendance tracking; room booking.
- [ ] Done when: a meeting appears in the attendee's calendar, an outside change returns without a duplicate, an action item becomes a real task.

## 7. v2.0 Scale and enterprise (not started)

### P32 — Arabic and right to left (most of it already done)

The interface is fully translated and right to left on all three apps. Left:

- [ ] Arabic typography decided per locale: font, line height, Arabic-Indic or Western numerals.
- [ ] Form labels in more than one language, shown in the filler's language; a language per person independent of the company.
- [ ] Mixed-direction text everywhere (an English part number inside an Arabic sentence); Arabic PDFs (with P29).
- [ ] A translation workflow so no new text ships untranslated (the parity tests already enforce English and Arabic together).
- [ ] A native Arabic speaker reviews the whole product and signs it off.

### P33 — Public API and integrations

- [ ] A public API per company with scoped, revocable keys, rate limits and metering; published documentation and a sandbox.
- [ ] Outbound webhooks (job completed, form submitted, stock low) with signed payloads and retries.
- [ ] Accounting exports (QuickBooks, Xero, Zoho), a Zapier or Make connector, email-to-job.
- [ ] Done when: a third party builds an integration from the documentation alone; webhooks survive an hour of downtime and deliver in order.

### P34 — Enterprise access and security

Company roles (G1) already give permissions beyond the built-in roles.

- [ ] SSO and SAML with SCIM provisioning; two-factor sign-in enforced per company; IP allow-lists.
- [ ] Hiding sensitive values inside a submission by role.
- [ ] Data residency options, documented sub-processors, retention policies per plan enforced automatically.
- [ ] Export and erasure of one person's data on request (company-wide export already exists).
- [ ] An external penetration test with findings fixed and retested; a security questionnaire pack and trust page; SOC 2 readiness.
- [ ] Done when: a customer's IT department completes its review without a blocking finding.

### P35 — Dedicated-instance tier

Built only once a customer signs for it.

- [ ] A company's own database in its own region: connection registry with encrypted credentials, provisioning that rolls back on failure.
- [ ] Migrations run per company with status per company; a release waits until every company's schema is ready.
- [ ] Per-company backups and restore checks; aggregate figures sent to the control plane; credential rotation without downtime.
- [ ] Done when: a dedicated and a shared company run the same code with no differences, and losing one dedicated database affects only that company.

## Suggested order for version 2

1. **Housekeeping and the G1 leftovers** (section 2): small, and they clear the tracker.
2. **Production readiness** (section 3: backups, monitoring, legal pages, signing): needed before anyone's business depends on the product.
3. **Phase L and the first customer** (sections 1 and 4): the pilot decides what comes next.
4. **The email channel and server PDFs** (section 2 and P29): many waiting items share them.
5. **Scheduling** (v1.2), then **reporting** (v1.3), in the order the pilot's findings rank them.
6. **v2.0** when a customer asks for it, P35 only after a signed contract.

## Decisions needed before version 2 starts

- Which email address and provider the companies' own customers receive mail from (quotes, purchase orders, reminders, reports).
- Whether invoices must meet the Egyptian Tax Authority's e-invoicing requirements, and when.
- Whether payroll rule sets get a legal review, and by whom.
- Which pilot customer, which modules they will use, and what they pay during the pilot.
- Whether the database moves to Supabase before the pilot or stays on the machine with nightly backups.
- Apple and Google developer accounts and code-signing certificates: who owns them, and the budget.
