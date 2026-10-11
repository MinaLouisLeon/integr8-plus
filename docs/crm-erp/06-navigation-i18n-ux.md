# 06 — Navigation, languages and screens

## Navigation

`packages/core/src/navigation.ts` has a `crm` group, placed between Work and
Operations. A section can name a `feature`; `visibleNavigation(app,
permissions, features)` shows it only when the company has the module and the
seat holds the section's permission. Callers that pass no flags show no gated
section.

| Section key | Group | Permission | Feature | Web route    | Desktop route | Phase |
| ----------- | ----- | ---------- | ------- | ------------ | ------------- | ----- |
| `crm`       | `crm` | `crm.read` | `crm`   | `/crm`       | `#/crm`       | F1    |
| `leads`     | `crm` | `crm.read` | `crm`   | `/crm/leads` | `#/crm/leads` | C1    |

Web: `apps/web/src/lib/navigation.ts` (`NAV_PATHS`), menu in
`apps/web/src/components/workspace-shell.tsx`. Desktop:
`apps/desktop/src/lib/navigation.ts` (`NAV_ROUTES`, `desktopNavigation`), used
by the side menu and the dashboard cards.

## Screens

Shared screens live in `packages/operations-dom/src/crm/` and are mounted by
thin wrappers: `apps/web/src/app/(app)/crm/*` and
`apps/desktop/src/features/operations/screens.tsx` + `apps/desktop/src/App.tsx`.

| Screen                 | Component            | Phase | Notes                                                                                                                                                                                                                         |
| ---------------------- | -------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM overview           | `CrmOverviewScreen`  | F1    | Says plainly when the module is off or the seat may not read the CRM; links to each CRM screen                                                                                                                                |
| Leads                  | `LeadListScreen`     | C1    | Search, status, source and assignee filters (`me`, `none`), archived toggle, "show more" paging, new-lead dialog, right-click menu on desktop                                                                                 |
| Lead                   | `LeadScreen`         | C1    | Details, edit form (sends only changed fields), quick status select, archive and restore, reload prompt on a version conflict, converted leads read-only with a link to the customer                                          |
| Convert a lead         | `LeadConvertScreen`  | C2    | Three steps: choose the customer (suggestions with reasons, search, or new — nothing preselected), choose the contact, review in plain words; then convert once. One idempotency key per distinct request, so a retry replays |
| Customer → CRM section | `CustomerCrmSection` | C2    | On the existing customer screen, only when the company has the CRM and the seat holds `crm.read`; lists the leads that became the customer                                                                                    |

Routes: web `/crm/leads`, `/crm/leads/[id]` and `/crm/leads/[id]/convert`;
desktop `#/crm/leads`, `#/crm/leads/:leadId` and `#/crm/leads/:leadId/convert`. Amounts are formatted by `formatAmount`
(`packages/operations-dom/src/crm/lead-parts.tsx`), which hands the decimal
string straight to `Intl.NumberFormat`, so no amount passes through a float.
Email and phone fields and values are `dir="ltr"` in both languages.

## Translation keys

English and Arabic, same keys (the parity test fails otherwise):

- `nav.group.crm`, `nav.section.crm`, `nav.hint.crm`, `nav.section.leads`, `nav.hint.leads`
- `crm.overview.*`
- `crm.leads.*` (C1), `crm.status.*`, `crm.source.*`
- `crm.convert.*`, `crm.customer.*` (C2)
- `errors.featureDisabled` — the web maps API code `feature_disabled` to it
  (`apps/web/src/lib/errors.ts`).

Layouts use logical properties only (`ps-`, `text-start`), enforced by lint, so
every CRM screen mirrors in Arabic.
