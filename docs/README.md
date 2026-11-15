# Integr8 Plus documentation

Written for release **2.0.0** (2026-11-15), after the backend and database
restructure (the database starts again from one migration per module, and the
tables that grow forever are split by year). Every page describes the code as it
is now. History lives in git: the documentation and plans before 2.0.0 were
removed in one commit, and `git log -- docs plan` brings any of it back.

## What the product is

A multi-tenant field-operations and business platform that Integr8 sells to
service companies (maintenance, installation, inspection), mainly in Egypt (EGP,
Egyptian payroll, Egyptian Tax Authority e-invoicing), in English and Arabic
(right to left). Integr8 staff onboard every company from the staff desktop app,
and invoice it; there is no public sign-up. Since P42 there is no web workspace:
the office works in its company's own desktop app.

| Who                          | Uses                                             | To                                                                    |
| ---------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Integr8 staff (super admins) | The staff desktop app                            | Run companies, plans and billing; build each company's forms and look |
| A company's office           | The company's own desktop app                    | Customers, jobs, dispatch, forms, and the business modules they have  |
| A company's engineers        | The company's own phone app, which works offline | Their jobs, forms, photos, parts, expenses and timesheets             |
| A company's customers        | Links the company sends, on the public site      | Accept a quote, open a certificate                                    |

## The pages

| Page                                                                                     | Read it for                                                                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [architecture.md](./architecture.md)                                                     | The monorepo, how a request travels, the boundaries, the stand-in services       |
| [apps/](./apps/README.md)                                                                | The web, desktop and phone apps: what each draws and how they differ             |
| [apps/mobile.md](./apps/mobile.md)                                                       | The phone: local database, offline sync, encryption, company builds              |
| [api/](./api/README.md)                                                                  | Calling and changing the `/v1` API: pipeline, headers, idempotency, versioning   |
| [auth/](./auth/README.md)                                                                | Sign-in, tokens, sessions, roles and permissions, impersonation                  |
| [auth/offline-access.md](./auth/offline-access.md)                                       | The phone's seven-day offline grant and its trade-off                            |
| [database/](./database/README.md)                                                        | Tenant isolation, the roles, the 19 module migrations, year partitions, transfer |
| [database/migrations.md](./database/migrations.md)                                       | Writing a migration; where the 1.x migration numbers went                        |
| [database/runbook-backup-and-restore.md](./database/runbook-backup-and-restore.md)       | Nightly dumps, the off-machine copy, restore drills                              |
| [modules/](./modules/README.md)                                                          | Every business module: what it does, its switch, tables, routes, permissions     |
| [form-engine/](./form-engine/README.md)                                                  | Forms: definitions, rules, versions, the builder, submissions, form actions      |
| [form-engine/package-format.md](./form-engine/package-format.md)                         | The `.integr8form` file                                                          |
| [documents/](./documents/README.md)                                                      | PDF templates, business PDFs, uploaded documents, sharing, the website lookup    |
| [media/](./media/README.md)                                                              | Files: buckets, uploads, who may read, metering, retention                       |
| [ai/](./ai/README.md)                                                                    | The assistant: help library, providers, limits, turning it on and off            |
| [e-invoicing/](./e-invoicing/README.md)                                                  | Egyptian Tax Authority e-invoicing (test only)                                   |
| [platform/](./platform/README.md)                                                        | The staff dashboard: onboarding, plans and billing, test companies, closing      |
| [deployment/](./deployment/README.md)                                                    | The server, compose services, settings, releases, company app builds             |
| [deployment/setup-checklist.md](./deployment/setup-checklist.md)                         | The operator's step-by-step guide (also as `.html`)                              |
| [contributing/](./contributing/README.md)                                                | Branches, commits, checks, releases, the rules lint and tests enforce            |
| [contributing/developer-tools.md](./contributing/developer-tools.md)                     | Integr8 Forms for AI, the developer MCP server, change requests                  |
| [contributing/planning-a-change-request.md](./contributing/planning-a-change-request.md) | Turning a change request into a plan                                             |
| [legal/](./legal/README.md)                                                              | The legal pages and what must happen before launch                               |

The plan (what is built, what is next, the owner's open decisions) is
[`plan/README.md`](../plan/README.md). The project's working memory, for coding
agents, is [`MEMORY.md`](../MEMORY.md).

## Words used throughout

| Word                      | Means                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Company, tenant           | One customer of Integr8. Every company-owned row carries its `tenant_id`                                     |
| Staff, super admin        | Integr8's own people (`platform_users`); never members of a company                                          |
| Member, seat              | A person in a company with one role (`tenant_users`)                                                         |
| Module                    | A switchable part of the product (CRM, sales, finance, …), off by default per company                        |
| Impersonation             | Staff working inside a company through an audited, time-limited grant                                        |
| Job, work order           | One piece of field work; a visit is one trip for it                                                          |
| Form, version, submission | A form has immutable published versions; a submission is one filling of one version                          |
| Test company              | A company made for trying things (`tenants.is_test`); left out of billing, its mail and push go to an outbox |
| Change request            | A wish for the platform recorded while building forms, kept in `plan/requests/`                              |
