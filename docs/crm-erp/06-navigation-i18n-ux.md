# 06 — Navigation, languages and screens

## Navigation

`packages/core/src/navigation.ts` has a `crm` group, placed between Work and
Operations. A section can name a `feature`; `visibleNavigation(app,
permissions, features)` shows it only when the company has the module and the
seat holds the section's permission. Callers that pass no flags show no gated
section.

| Section key     | Group | Permission | Feature | Web route            | Desktop route         | Phase |
| --------------- | ----- | ---------- | ------- | -------------------- | --------------------- | ----- |
| `crm`           | `crm` | `crm.read` | `crm`   | `/crm`               | `#/crm`               | F1    |
| `leads`         | `crm` | `crm.read` | `crm`   | `/crm/leads`         | `#/crm/leads`         | C1    |
| `opportunities` | `crm` | `crm.read` | `crm`   | `/crm/opportunities` | `#/crm/opportunities` | C3    |
| `activities`    | `crm` | `crm.read` | `crm`   | `/crm/activities`    | `#/crm/activities`    | C3    |

Web: `apps/web/src/lib/navigation.ts` (`NAV_PATHS`), menu in
`apps/web/src/components/workspace-shell.tsx`. Desktop:
`apps/desktop/src/lib/navigation.ts` (`NAV_ROUTES`, `desktopNavigation`), used
by the side menu and the dashboard cards.

## Screens

Shared screens live in `packages/operations-dom/src/crm/` and are mounted by
thin wrappers: `apps/web/src/app/(app)/crm/*` and
`apps/desktop/src/features/operations/screens.tsx` + `apps/desktop/src/App.tsx`.

| Screen                     | Component                | Phase  | Notes                                                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM overview (dashboard)   | `CrmOverviewScreen`      | F1, C3 | Says plainly when the module is off or the seat may not read the CRM; otherwise the dashboard: open pipeline and weighted forecast per currency ("a forecast, not revenue"), won and lost in 30 days, follow-ups overdue / today / mine, open opportunities by stage, leads by status       |
| Leads                      | `LeadListScreen`         | C1     | Search, status, source and assignee filters (`me`, `none`), archived toggle, "show more" paging, new-lead dialog, right-click menu on desktop                                                                                                                                               |
| Lead                       | `LeadScreen`             | C1     | Details, edit form (sends only changed fields), quick status select, archive and restore, reload prompt on a version conflict, converted leads read-only with a link to the customer                                                                                                        |
| Convert a lead             | `LeadConvertScreen`      | C2     | Three steps: choose the customer (suggestions with reasons, search, or new — nothing preselected), choose the contact, review in plain words; then convert once. One idempotency key per distinct request, so a retry replays                                                               |
| Customer → CRM section     | `CustomerCrmSection`     | C2     | On the existing customer screen, only when the company has the CRM and the seat holds `crm.read`; lists the leads that became the customer                                                                                                                                                  |
| Opportunities              | `OpportunityBoardScreen` | C3     | Board (a column per open stage) or list (any status); search and owner filters; each card moves with a **stage select** (keyboard-first; drag-and-drop is a follow-up) and losing asks for a reason in a dialog; new-opportunity dialog with a customer search; right-click menu on desktop |
| Opportunity                | `OpportunityScreen`      | C3     | Details, stage select, edit (chance typed as a percentage, sent as basis points), archive, history in words ("Moved from New to Qualified"), activity panel, reload prompt on a version conflict                                                                                            |
| Follow-ups                 | `ActivitiesScreen`       | C3     | Tabs: overdue, today, upcoming, no date, done; "only mine"; mark done; links to each activity's records                                                                                                                                                                                     |
| Activity panel             | `ActivityPanel`          | C3     | On a lead, an opportunity and a customer: newest first, add a call, email, meeting, note, follow-up or task                                                                                                                                                                                 |
| Lead (additions)           | `LeadScreen`             | C3     | The lead's opportunities with "New opportunity", and its activity panel                                                                                                                                                                                                                     |
| Customer → CRM (additions) | `CustomerCrmSection`     | C3     | Opportunities, leads, "New opportunity", and the customer's activity panel                                                                                                                                                                                                                  |
| Convert a lead (addition)  | `LeadConvertScreen`      | C3     | "Also open an opportunity", prefilled with the lead's company and carrying its estimate and currency                                                                                                                                                                                        |

Routes: web `/crm/leads`, `/crm/leads/[id]`, `/crm/leads/[id]/convert`,
`/crm/opportunities`, `/crm/opportunities/[id]` and `/crm/activities`; desktop
the same under `#/`. Amounts are formatted by `formatAmount`
(`packages/operations-dom/src/crm/lead-parts.tsx`), which hands the decimal
string straight to `Intl.NumberFormat`, so no amount passes through a float.
Email and phone fields and values are `dir="ltr"` in both languages.

## Translation keys

English and Arabic, same keys (the parity test fails otherwise):

- `nav.group.crm`, `nav.section.crm`, `nav.hint.crm`, `nav.section.leads`, `nav.hint.leads`
- `crm.overview.*`
- `crm.leads.*` (C1), `crm.status.*`, `crm.source.*`
- `crm.convert.*`, `crm.customer.*` (C2)
- `crm.stage.*`, `crm.opportunityStatus.*`, `crm.opportunityEvent.*`, `crm.opportunities.*`, `crm.activityKind.*`, `crm.activities.*`, `crm.dashboard.*`, `nav.section|hint.opportunities|activities` (C3). Counts use i18next plurals: English `_one`/`_other`, Arabic all six forms.
- `errors.featureDisabled` — the web maps API code `feature_disabled` to it
  (`apps/web/src/lib/errors.ts`).

Layouts use logical properties only (`ps-`, `text-start`), enforced by lint, so
every CRM screen mirrors in Arabic.
