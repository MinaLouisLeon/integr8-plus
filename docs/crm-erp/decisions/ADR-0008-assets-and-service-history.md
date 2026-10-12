# ADR-0008 — Assets, tags and service history

**Status:** Accepted (E3 planning, 2026-10-11); implemented in E3

## Context

A field-service company services the same machines again and again. P24
(`plan/v1.1-inventory/P24-asset-register-and-service-history.md`) asks that
scanning a tag on a machine shows everything ever done to it, offline, and
lists eight features: the register, printable tags, scanning on the phone, the
timeline, condition and status, warranty alerts, prefilling a form from the
last visit, and CSV import. The product owner chose all eight for E3 on
2026-10-11. This record fixes their shape.

## Decision — the register

- An **asset** belongs to one customer's site (`(tenant_id, customer_id,
site_id)` composite foreign key to `sites`), is numbered `AS-000001` onwards
  per company when created, and has a name, optional make, model and
  manufacturer serial, an optional catalogue item, a location within the site,
  install date, warranty expiry, notes, a **status** (`active`,
  `out_of_service`, `retired`) and a last recorded **condition** (`good`,
  `fair`, `poor`, `unusable`). The serial, when given, is unique within the
  company, compared trimmed and case-insensitively.
- Every change that matters to the history — registered, edited, moved to
  another site, status changed, condition recorded, tag reissued — appends an
  immutable **asset event** with who, when and what it was before. An asset is
  never moved without an event and never deleted; it is retired.
- Routes live under `/v1/assets/*`, tables under `erp_*`, behind a new
  `assets` module switch, off by default and independent of the other modules.

## Decision — jobs and the timeline

- A job names zero or more of its site's assets. A form submission and a part
  used may name the asset they concern. When a job has exactly one asset and a
  submission, part or photo on it names none, it is attributed to that asset
  when the timeline is read, so linking an asset after the work was done still
  shows the work.
- The **timeline** is read, not stored: the asset's events, the jobs linked to
  it, the submissions and parts attributed to it, and the photos on those jobs
  and submissions, newest first.

## Decision — tags and scanning

- Each asset carries a random **tag code** (twelve characters, Crockford
  base32), unique across Integr8 and reissued on demand, which retires the old
  tag. The printed QR code holds a web link, `{WEB_APP_URL}/a/{code}`. The link
  is not a capability: opening it needs a signed-in seat of the asset's company,
  and any other visitor sees the same "not found" as for an unknown code.
- Labels print from the asset screen and the asset list (one tag, or a sheet of
  the selected assets), through the browser's own print. QR codes are encoded
  by `uqr` (MIT, no dependencies) if its licence file and tarball check out;
  otherwise by an encoder written in the repository.
- The phone scans with the camera it already uses for barcode questions, reads
  the code out of the link and opens the asset from its own copy, with no
  signal. A phone camera outside the app opens the link in the browser.

## Decision — offline

- Assets ride with the sites the phone already holds (the sites of the
  engineer's jobs), each with its **full** history: every event, job,
  submission (with its answers), part and photo, photos downloaded at full size
  through the existing download queue. Evicting a site evicts its assets.
- From the phone an engineer may register an asset at the site of a job they
  are on, record its condition and link it to that job, through the outbox,
  idempotently, like parts used.

## Decision — alerts, prefill and import

- **Warranty alerts:** a company setting (default 60 days, 0 to 365) says how
  far ahead to warn. The dashboard lists assets whose warranty ends within it;
  the asset and its jobs carry a badge; the phone raises one local
  notification per asset and expiry date for synced assets inside the window.
  No email: there is no mail sender in the product yet.
  As built: more than three due at once (a new phone's first sync) fold into
  one notification; an alert is recorded as given before it is shown, so a
  crash costs one notification, never a repeat.
- **Prefill:** a form field may be marked "carry over from the asset's last
  submission". Starting that form for an asset fills only those fields from the
  last submission of the same form on the same asset, and says which answers
  came from last time. Photo, signature, file and location fields cannot be
  marked, nor calculated or read-only ones.

  As built: the server works out the carried answers, moved onto the form's
  current version, and records which on the draft (`submissions.carried_over`,
  0032). The phone gets the same per asset and form in its pull and uses it
  only while its own copy of the form is that version. A job's one asset is
  chosen for you; with several, web and desktop offer a choice and the phone
  starts the form from the asset's screen. A form a phone started offline for
  an asset that has since left the job is kept, without the asset.

- **Import:** a fourth CSV import kind, `assets`, matched to an existing
  customer and site, with the same preview, errors-by-row and template as the
  others.

## Decision — who

- `asset.read`: owners, admins, dispatchers and viewers read every asset;
  engineers read the assets of sites they have a job at. Whoever reads an
  asset reads its whole history, including jobs other engineers worked: the
  history is the point of the register. Opening one of those jobs is still
  subject to the job's own access.
- `asset.manage`: owners, admins and dispatchers create, edit, move, retire,
  reissue tags, print, link to any job and import.
- `asset.record`: the above plus engineers, who may register an asset at a job's
  site, record its condition and link it to their job, from the phone.

## Consequences

The history is assembled from records the product already keeps, so nothing is
copied and nothing drifts. The phone holds more than before: a site with many
assets and photos costs storage, which the sync screen reports. NFC, universal
links that open the app from the system camera, preventive-maintenance
schedules and email alerts are left for later.
