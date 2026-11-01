# 05 — Permissions and security

## Two independent checks on every CRM route

1. **Permission** — the seat's role must hold it (`assertHolds`, as for every route).
2. **Module** — the company must have `crm` switched on. Declared on the route
   as `feature: 'crm'` and enforced in `apps/api/src/server.ts` (step 6b) by
   `assertFeatureEnabled` in `apps/api/src/http/features.ts`. Refusal: 403
   `feature_disabled`.

Hiding a menu entry is never the control. The menu hides CRM entries for the
same two reasons (`visibleNavigation(app, permissions, features)`), but the API
refuses regardless.

The company's resolved flags are cached for 30 seconds per API process. Changing
a company's flag from the platform dashboard clears that company's entry, and
changing a flag's default clears every entry, in the process that made the
change; other processes catch up within 30 seconds.

## CRM permissions (phase F1)

| Permission               | Owner | Admin | Dispatcher | Engineer | Viewer |
| ------------------------ | :---: | :---: | :--------: | :------: | :----: |
| `crm.read`               |   ✓   |   ✓   |     ✓      |    —     |   ✓    |
| `crm.lead.manage`        |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `crm.lead.convert`       |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `crm.opportunity.manage` |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `crm.activity.manage`    |   ✓   |   ✓   |     ✓      |    —     |   —    |

Decided with the product owner on 2026-10-11: dispatchers have full CRM rights
including conversion; viewers read and change nothing; engineers have no CRM
access (they still read customers for their jobs, through `customer.read`).
`customer.read` alone never reveals CRM data such as deal values.

None of these is staff-only. Integr8 staff acting as a company (impersonation)
hold whatever the seat holds; CRM audit entries record the staff member in
`metadata.impersonatedBy` (from phase C1; `crmAudit` in
`apps/api/src/routes/v1/crm.ts`).

Tests: `packages/core/src/crm.test.ts` pins the table above;
`packages/core/src/permissions.test.ts` keeps every role's grants explicit.

## Rules beyond the role (phase C1)

- An assignee must be an active member of the same company (422
  `assignee_not_member`); a lead cannot be handed to someone outside it.
- Edits carry `expectedVersion`, so two people editing the same lead cannot
  silently overwrite each other (409 `version_conflict`).
- A lead in another company answers 404, by id and by search, exactly as one
  that does not exist.
- The detail response says what the seat may do (`can.edit`, `can.convert`);
  screens use it to hide actions, and the API refuses them anyway.

## Converting (phase C2)

- `crm.lead.convert` to see suggested customers and to convert; the lead screen
  shows the action only when `can.convert` is true (the permission, and the
  lead open and not archived).
- Creating a customer during conversion also checks `customer.manage`, so the
  CRM can never become a back door for adding customers.
- A customer id from another company answers 404 `customer_not_found`, as one
  that does not exist; the response says nothing more about it.
- The customer's CRM summary (`/v1/customers/{id}/crm`) needs `crm.read` and the
  module, while the customer itself needs only `customer.read`: engineers read
  customers for their jobs and never see CRM data through them.

## Opportunities and activities (phase C3)

- Reading the pipeline, opportunities, activities and the dashboard needs
  `crm.read` (viewers included); changing any of them needs
  `crm.opportunity.manage` or `crm.activity.manage` (owners, admins and
  dispatchers). Engineers see none of it.
- Every id in a request — customer, lead, stage, owner, linked record — is
  checked to be this company's before anything is written, and the database's
  composite foreign keys refuse it anyway. Another company's stage is
  `invalid_transition`; another company's record is a 404, as one that does not
  exist.
- An opportunity's history and an activity's links cannot be changed or
  deleted by the application role.
- Detail responses carry `can` flags; screens hide what the seat may not do,
  and the API refuses it regardless.

## Inventory and purchasing (phases E1 and E2)

| Permission           | Owner | Admin | Dispatcher | Engineer | Viewer |
| -------------------- | :---: | :---: | :--------: | :------: | :----: |
| `inventory.read`     |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |
| `inventory.manage`   |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `inventory.move`     |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `inventory.consume`  |   ✓   |   ✓   |     ✓      |    ✓     |   —    |
| `purchasing.read`    |   ✓   |   ✓   |     ✓      |    —     |   ✓    |
| `purchasing.manage`  |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `purchasing.approve` |   ✓   |   ✓   |     —      |    —     |   —    |

Decided with the product owner on 2026-10-11: dispatchers run stock and draft
purchases; only owners and admins approve a purchase; engineers see stock and
record parts used on their own jobs from the van assigned to them; viewers
read. Costs are shown only to seats holding `inventory.move`. Every route also
needs the company's `inventory` (or `purchasing`) module.

Two security-definer functions back the ledger: `erp_stock_apply_movement`
(the balance trigger) and `erp_stock_lock_balance`, which refuses a company
other than the transaction's own. A third, `assign_purchase_order_reference`
(0027), numbers purchase orders from a per-company counter the runtime role
cannot read or write directly. All pin `search_path` and are listed in
`SECURITY_DEFINER_FUNCTIONS`; the schema-invariant suite checks both facts.

Purchasing (E2): prices are shown to seats holding `purchasing.manage` or
`inventory.move`; viewers read orders without them. Approval is a separate
permission so that a dispatcher's own draft needs an owner or admin before
goods are received against it; the trigger `erp_purchase_order_lines_guard`
makes the approved lines immutable whatever the role.

## Sales (phase S1)

| Permission     | Owner | Admin | Dispatcher | Engineer | Viewer |
| -------------- | :---: | :---: | :--------: | :------: | :----: |
| `sales.read`   |   ✓   |   ✓   |     ✓      |    —     |   ✓    |
| `sales.manage` |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `sales.issue`  |   ✓   |   ✓   |     —      |    —     |   —    |

Decided with the product owner on 2026-10-11: dispatchers draft and revise
quotes and orders, record a customer's answer, and link or create the jobs
that deliver an order; only owners and admins issue a quote and confirm an
order (which reserves stock) or cancel a confirmed one. Engineers see the
orders their jobs deliver on the job itself and nothing else of sales; viewers
read without internal notes. Every route also needs the company's `sales`
module, which is independent of `crm`, `inventory` and `purchasing`.

The customer's link (ADR-0006): issuing mints 32 random bytes (base64url);
only the SHA-256 is stored, globally unique while live. The public routes
resolve the hash to a company on the platform connection and then read on the
company's own connection, expose the quote and the company's name and logo
and nothing else, answer 404 alike for a spent, revised, withdrawn or unknown
link, and record the customer's answer as audit actor kind `system`
(`customer-link`) with the caller's address, never as a member. Tokens never
appear in the audit log or in server logs; the API returns one only in the
`issue` response.

A fourth security-definer function, `assign_sales_reference` (0029), numbers
quotes and orders from per-company counters the runtime role cannot write;
listed in `SECURITY_DEFINER_FUNCTIONS` and checked by the invariant suite. The
triggers `crm_quote_lines_guard` and `erp_sales_order_lines_guard` make issued
and confirmed lines immutable whatever the role.

## Finance (phase B1)

| Permission       | Owner | Admin | Dispatcher | Engineer | Viewer |
| ---------------- | :---: | :---: | :--------: | :------: | :----: |
| `finance.read`   |   ✓   |   ✓   |     ✓      |    —     |   ✓    |
| `finance.manage` |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `finance.issue`  |   ✓   |   ✓   |     —      |    —     |   —    |

Decided with the product owner on 2026-10-11: dispatchers draft invoices and
credit notes (blank, from an order or from a completed job) and discard
drafts; only owners and admins issue or void an invoice, issue a credit note,
record a payment, allocate or take back an allocation, and change the invoice
settings. Engineers see nothing of finance. Viewers read without internal
notes. Every route also needs the company's `finance` module, independent of
`sales`, `inventory` and `purchasing`.

Job cost and profit (`GET /v1/finance/work-orders/{id}/costs`) and the labour
cost per hour in the settings are shown only to seats that issue finance, move
stock or manage purchasing, the same seats that see part costs elsewhere.
Everyone else gets nulls.

What the database enforces whatever the role: an issued or void invoice and an
issued credit note never change (`erp_invoices_guard`,
`erp_credit_notes_guard`, and the line guards); a receipt is never updated or
deleted (the runtime role has `select, insert` only); an allocation is removed
by stamping it, never deleted; no allocation exceeds what the receipt has left
or the invoice owes, and none crosses customers or currencies
(`erp_payment_allocations_guard`, security definer, locking both rows); no
credit note exceeds what the invoice owes. Two more security-definer functions
come with 0030, `assign_finance_reference` and `erp_payment_allocations_guard`,
both listed in `SECURITY_DEFINER_FUNCTIONS`. Purging a company still works with
issued documents. Deletes are allowed only while `purge_tenant` runs, and the
runtime role cannot fake that marker (`integr8_purging`).

The invoice is a commercial record. The issuer block is printed as the company
typed it, and the settings screen says so; Integr8 makes no tax, e-invoicing
or compliance claim.

## Assets (phase E3; ADR-0008)

| Permission     | Owner | Admin | Dispatcher | Engineer | Viewer |
| -------------- | :---: | :---: | :--------: | :------: | :----: |
| `asset.read`   |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |
| `asset.record` |   ✓   |   ✓   |     ✓      |    ✓     |   —    |
| `asset.manage` |   ✓   |   ✓   |     ✓      |    —     |   —    |

Decided with the product owner on 2026-10-11: the office keeps the register —
registers anywhere, edits, moves, retires, reissues tags, prints them, links
and unlinks any job and imports from CSV. Engineers register an asset found at
the site of a job they are on, record its condition and link it to that job,
from the phone or the web. Owners, admins, dispatchers and viewers read every
asset; an engineer reads the assets of sites they have a job at, and anything
else answers 404 like any record they cannot see. Whoever may read an asset
reads its whole history, including jobs other engineers worked: opening one of
those jobs is still subject to the job's own access. Every route also needs the
company's `assets` module, independent of the others.

A tag's QR code holds only a link, `<web app>/a/<code>`, with a twelve-character
random code that is unique across Integr8 and says nothing about the asset.
The page it opens is inside the signed-in app: a stranger who scans a tag
reaches the sign-in page, and after signing in sees the asset only if their
company owns it and their role may read it. A reissued tag stops opening
anything. The sign-in page returns to the scanned page only for a same-origin
path (`safeReturnPath`), never an outside address.

On the phone, the assets of the engineer's sites are held with their whole
history and photos, as the jobs are; evicting a site evicts its assets.
Changes from the phone are idempotent and checked again by the server; a form
started for an asset the server no longer allows is kept, without the asset.

What the database enforces whatever the role: events are appended and never
changed (the runtime role has `select, insert`); an asset is never deleted
(no delete grant); its site belongs to its customer (composite key); serials
are unique per company and tags across Integr8; numbers are assigned by
`assign_asset_reference` (security definer, in `SECURITY_DEFINER_FUNCTIONS`)
and never change.

## Database

See [03-data-model.md](./03-data-model.md): row-level security on every CRM
table, no delete grant on leads, composite tenant keys on every reference, and
the conversion rule enforced by a trigger.

## The general ledger (phase A1; ADR-0009)

| Permission      | Owner | Admin | Dispatcher | Engineer | Viewer |
| --------------- | :---: | :---: | :--------: | :------: | :----: |
| `ledger.read`   |   ✓   |   ✓   |     —      |    —     |   ✓    |
| `ledger.post`   |   ✓   |   ✓   |     —      |    —     |   —    |
| `ledger.manage` |   ✓   |   ✓   |     —      |    —     |   —    |
| `ledger.unlock` |   ✓   |   —   |     —      |    —     |   —    |

Decided with the product owner on 2026-10-12: owners, admins and viewers read
the ledger; owners and admins draft and post journals, work the unposted list,
lock months, close years and change the chart and settings; only the owner
unlocks a month or reopens a year, always with a reason, and only the owner
allows a person to post a journal they drafted. Dispatchers and engineers see
nothing of the ledger. Every route also needs the company's `ledger` module,
independent of `finance`, `inventory` and `purchasing`; the automatic postings
come from those modules' documents whenever the ledger is set up.

Segregation of duties: a `manual` or `opening` journal is posted by someone
other than its drafter, and rewriting a draft makes its writer the drafter.
When the owner allows self-approval, the poster confirms it and the journal
keeps `self_approved`, shown wherever it is read and kept in the audit.

What the database enforces whatever the role: a journal is inserted as a
draft; it posts only when the ledger is set up, dated on or after the start, in
an open month, balanced on two lines or more, on accounts in use, and approved
by a second person when written by hand; a posted journal and its lines never
change or disappear (`erp_journals_guard`, `erp_journal_lines_guard`); only a
year's closing journal and its reversal go into a locked month, on the year's
last day and on income, expense and retained earnings (0035); an account's
type is fixed once posted to; the start and fiscal year are fixed once a
journal is posted. The unposted list is written only by the database's
functions (the runtime role may read it and update a waiting row, and a
resolved row never changes). Four security-definer functions come with A1 —
`assign_journal_reference`, `erp_ledger_capture`, `erp_ledger_try_post`,
`erp_ledger_backfill` — all listed in `SECURITY_DEFINER_FUNCTIONS`. Posting a
document runs in a subtransaction: a failure is recorded on the document and
never blocks an invoice, payment or stock movement.

It is a management ledger. Reports say so; Integr8 makes no tax, statutory
accounts or compliance claim for it.

## HR, staff expenses, payroll and manufacturing (phases H1 and M1; ADR-0010, ADR-0011)

Two roles join the five: **HR manager** (the people, their pay and their
claims, nothing of the operation) and **inventory manager** (the store,
purchasing and manufacturing). Either can also be **granted on top of any
role** (`member_grants`): the member keeps their role and gains the
capability's permissions. Only the owner makes someone an HR manager — by
role, invitation or grant — or changes an HR manager's role; an owner or
admin gives the inventory grant. A grant travels in the access token (`grt`)
and taking it back ends the member's sessions.

| Permission             | Owner | Admin | HR manager | Inventory manager | Dispatcher | Engineer | Viewer |
| ---------------------- | :---: | :---: | :--------: | :---------------: | :--------: | :------: | :----: |
| `hr.read`              |   ✓   |   ✓   |     ✓      |         —         |     —      |    —     |   —    |
| `hr.sensitive`         |   ✓   |   —   |     ✓      |         —         |     —      |    —     |   —    |
| `hr.manage`            |   ✓   |   —   |     ✓      |         —         |     —      |    —     |   —    |
| `expense.submit`       |   ✓   |   ✓   |     ✓      |         ✓         |     ✓      |    ✓     |   ✓    |
| `expense.approve`      |   ✓   |   ✓   |     ✓      |         —         |     —      |    —     |   —    |
| `payroll.run`          |   ✓   |   —   |     ✓      |         —         |     —      |    —     |   —    |
| `payroll.approve`      |   ✓   |   —   |     ✓      |         —         |     —      |    —     |   —    |
| `manufacturing.read`   |   ✓   |   ✓   |     —      |         ✓         |     —      |    —     |   ✓    |
| `manufacturing.manage` |   ✓   |   ✓   |     —      |         ✓         |     —      |    —     |   —    |

The inventory manager also holds `tenant.read`, `member.read`, `form.read`,
`customer.read`, `inventory.*`, `purchasing.read`, `purchasing.manage` and
`sales.read`; the HR manager `tenant.read`, `member.read` and `form.read`.
Every route also needs the company's module: `hr`, `payroll` (which needs
`hr`) or `manufacturing` (which needs `inventory`).

- **Every member sees their own** profile (with their own numbers), claims
  and payslips, whatever their role.
- **Sensitive numbers.** National ID, social insurance number and bank
  account are encrypted by the API with AES-256-GCM under `HR_DATA_KEY`
  (32 bytes, base64), bound to the company, the employee and the field; the
  database never sees them in clear and the company export carries the
  ciphertext. Lists show the last four. A full value is shown only on an
  explicit, audited reveal (`no-store`), to `hr.sensitive` or the person; the
  insurance report and bank file are audited and `no-store` too. Without the
  key those numbers cannot be stored, shown or exported (503
  `hr_key_missing`), and production refuses to start without it. Losing the
  key loses them, so it is kept in the password manager, apart from the
  backups (`docs/database/runbook-backup-and-restore.md`). It rotates:
  `HR_DATA_KEY` seals, older keys listed in `HR_DATA_KEYS_PREVIOUS` still open
  (each tried in turn; GCM's tag rejects a wrong one), and `admin-cli
hr-reseal` re-seals every company's fields under the current key, company by
  company in its own tenant transaction, with an audit line each (setup guide,
  Stage 11 part Z). Stored values keep their `hr1.` shape, so a rollback reads
  them.
- **Separation of duties.** Nobody decides their own expense claim (API and
  `hr_expense_claims_not_self_approved`); a pay run is approved by somebody
  other than whoever last prepared it (API and
  `hr_payroll_runs_not_self_approved`); only the owner confirms the figures
  payroll uses, with a note on who checked them.
- **Receipts** reuse the attachment and media routes, which now accept
  `expense.submit` beside their earlier permissions (`anyPermission`); an
  attachment on a claim is allowed only to its claimant while it can take
  receipts, or to an approver, and attaching to customers' records is
  unchanged.
- **Costs** in manufacturing are hidden from seats without `inventory.move`,
  as in inventory. Drafting purchase orders from a plan needs
  `purchasing.manage` as well; they are approved as usual.

## Follow-ups before the pilot (F2; ADR-0012)

- **`crm.pipeline.manage`** — owners and admins edit pipelines and stages;
  everyone with `crm.read` keeps using them.
- **Exports** are for the managers of each area and audited with their
  filters: leads `crm.lead.manage`, opportunities `crm.opportunity.manage`,
  stock movements and parts usage `inventory.move`. At most 50,000 rows,
  `no-store`; CSV cells that look like formulas are escaped (`toCsv`).
- **The customer timeline** shows each source only to a seat that may read
  it with its module on; figures follow their area (`crm.read`,
  `sales.read`, `inventory.read`), and money is hidden from seats that do
  not see costs.
- **Item media** — everyone who sees an item sees its images and
  datasheets; `inventory.manage` adds and removes them (media upload now
  accepts `inventory.manage` as well).
- **Price lists** are shown only to seats that see prices
  (`purchasing.manage` or `inventory.move`; 403 `prices_hidden`).
- **Van refills** — an engineer (`inventory.consume`) asks for their own van
  and sees only its requests; the store (`inventory.move`) sees every van's
  and picks; online only.
- **Merchant parts** — recorded by whoever works the job
  (`inventory.consume`), seen by those who see the job; the price paid is
  shown to its recorder and to seats that see costs; cancelled by its
  recorder or `inventory.move`.
- **Deliveries by hand** need `sales.manage`; the delivery note
  (`sales.read`) carries no prices.
- **Licences** — CI fails on a dependency whose licence is not permissive
  unless it is listed, with a reason, in `scripts/licences/exceptions.json`
  (`pnpm licences:check`).

## Product gaps before the pilot (G1; ADR-0013)

- **Company roles** are a built-in base plus permissions added or taken
  away. Only the owner defines them (`role.manage`, the owner's alone);
  owners and admins give them out (`member.manage`). A company role never
  holds what only the owner may (`tenant.update`, `billing.manage`,
  `ledger.unlock`, `role.manage`: 422 `permission_not_addable`), and the
  owner never holds a company role.
- **Giving a role** keeps the rank rule (the base may not rank above the
  giver: `role_above_own`) and adds one: a company role holding a
  permission the giver does not hold is the owner's to give
  (`role_beyond_own`, with what is missing).
- **Tokens** carry the overlay (`crl`) read when each access token is
  minted. Changing a role, or a member's role, signs its holders out, so
  the change applies at once rather than at the next refresh. The member
  row keeps the base as `role`, so every check that compares ranks or
  names a built-in role behaves as before.
- **Lots** follow the inventory permissions: reading lots, the lookup and the
  trace need `inventory.read`; switching tracking needs `inventory.manage`.
  Lot balances, like item balances, are written only by the ledger's
  trigger; the runtime role reads them and locks them only through
  `erp_stock_lock_lot_balance`, for its own company.
- **Amount history** is written only by trigger; the runtime role can read
  it and cannot change it, so value by stage reflects what deals were
  worth, not what someone later said they were.
