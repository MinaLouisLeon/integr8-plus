# Integr8 Plus — codebase note

**What it is:** a multi-tenant field-operations and business platform for service companies. Office users work in the web or desktop app; engineers use the offline-capable phone app. Integr8 staff manage tenant setup and platform policy.

## Apps and architecture

- `apps/web`: Next.js public site, tenant workspace and Integr8 platform dashboard.
- `apps/desktop`: React app packaged with Tauri for staff and company-branded installs.
- `apps/mobile`: Expo/React Native field app with local SQLite, queued sync and conflict handling.
- `apps/api`: Fastify `/v1` service, typed route registry/OpenAPI, background jobs and platform/storage tools.
- `packages/`: shared domain/permissions (`core`), Postgres access (`db`), auth/client, form engine and renderers, offline sync, shared operations screens, document/ETA support, localization and design tokens.

The API is the application boundary for clients. Postgres tenant isolation is enforced through tenant-scoped repositories and RLS. Web and desktop share form and operations UI packages; the phone uses shared domain/form logic with native screens.

## Feature areas visible in the implementation

- **Field work:** customers, sites and access notes; job types; work orders, dispatch and job execution; visits and the scheduling board; engineer skills and certificates; service contracts, maintenance plans and response deadlines; crew, comments, attachments, checklists, photos and customer sign-off; timesheets; CSV import and reporting.
- **Forms:** visual authoring, reusable templates, 18 input types, pages/sections, repeat groups, calculations, validation, conditional visibility/requiredness and dependent choices. Publishing versions is immutable; submissions are autosaved, validated, reportable, exportable and corrected with an audited reason/history.
- **Offline field app:** assigned jobs, navigation, forms, photos/signatures, parts, expenses, asset scans, receiving/van stock, payslips and assistant screens. Local-first work syncs in order; conflicts have a resolution flow. App also includes push, biometric lock and update support.
- **CRM and sales:** leads and conversion, customer 360/timeline, configurable pipelines and stages, opportunities, activities/follow-ups, quotes and acceptance links, orders, stock reservations, deliveries, CRM reports and CSV exports.
- **Assets and inventory:** asset register, tags/scan, warranty and service history; item catalogue/media, serial and batch tracking, locations, movements, stock counts, supplier price lists, purchasing/receipts/returns, reorder drafts, site and van stock, work-order materials and usage reports.
- **Business management:** customer invoices, payments, credit notes and job costing; management general ledger with periods, journals, automated/unposted postings and reports; employee profiles, expenses and Egyptian payroll; bills of materials, assembly/disassembly and material planning.
- **AI assistant:** searchable help library, permission-scoped insights, and gated actions that preview before confirmation. Platform policy controls providers, levels, channels, member shares and usage/cost limits. Fresh configuration is off; library help can run without a model.
- **Documents and e-invoicing:** document templates and printable outputs; Egyptian Tax Authority credential/schema/code setup and invoice submission/signing support.
- **Platform and cross-cutting:** tenant onboarding/lifecycle, plans/billing, entitlements, impersonation/audit, feature flags, announcements, templates, storage metering, releases/health, exports/deletion, staff management, branding, custom roles, bilingual English/Arabic RTL, media, push and observability.

## Useful starting points

- Product and setup: `README.md`, `CONTRIBUTING.md`, `docs/`
- CRM/ERP status and scope: `docs/crm-erp/README.md`
- AI behavior and operations: `docs/ai/`
- ETA integration notes: `docs/e-invoicing/`
- Core source: `apps/api/src/routes/v1/`, `apps/web/src/app/`, `apps/mobile/app/`, `packages/operations-dom/src/`, `packages/db/migrations/`

**Read carefully:** root README/roadmap summaries lag some code. Root package version is 1.2.1 and migrations currently reach 0056. Feature visibility is gated by tenant modules, plan entitlements and permissions. ETA credentials and live end-to-end validation are environment-dependent; code presence does not imply legal certification.
