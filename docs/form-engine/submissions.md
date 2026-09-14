# Submissions

A published form is filled in on the web or desktop app, stored, found again, and
corrected without ever losing what was first submitted (P08). Four layers, each enforcing
what it is best placed to:

```
@integr8/form-renderer-dom          the renderer and the screens around it (web + desktop)
        │  answers, via the engine's state machine
apps/api  routes/v1/submissions.ts  revalidates every submit against its bound version
        │
@integr8/db  migration 0008         lifecycle, history and reportable values, by trigger
        │
media storage (apps/api/src/media)  local disk now, R2 in P09, behind one interface
```

---

## The lifecycle

```
draft ──submit──▶ submitted ──reopen (reason)──▶ reopened ──submit (reason)──▶ submitted
```

| Rule                                                         | Enforced by                                              |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| A draft's answers change freely; it is its author's alone    | API (visibility), database (transitions)                 |
| Submitted answers cannot change                              | `enforce_submission_lifecycle` trigger, every role       |
| Reopening and correcting each need a reason                  | the same trigger                                         |
| Every submit, reopening and correction is kept, with answers | `record_submission_change` trigger → `submission_events` |
| Nobody can edit or delete that history                       | statement triggers; the runtime role has only `select`   |
| A submission stays bound to its version and its person       | triggers from 0006 and 0008                              |

Autosave names the revision it is based on, as the builder's does: a save from a device
that is behind is refused with 409 `submission_changed`, so two devices cannot overwrite
each other. Drafts live on the server, so a form started on a laptop is finished on any
other device the person signs in on.

## The server validates for truth

`POST /v1/submissions/:id/submit` runs `validateSubmission` from `@integr8/form-engine`
against the version the submission is bound to — the same function the renderer runs as
the person types — and stores the server's result, not the client's. A 422
`invalid_submission` names each question under `body.answers.<id>` with the engine's code
and, where there is one, its parameters (`{ maximum: "10" }`). It refuses:

- a question the form does not have, an answer to a hidden question, or a value for a
  calculated one;
- an answer of the wrong shape (a number sent for a decimal), breaking a limit, or a
  choice the form does not offer;
- a photo, file or signature that was never uploaded by this company, or whose type or
  size differ from what storage holds;
- a "today" more than a day from the server's, so a client cannot move the date that
  "before today" rules are judged on.

Nothing is stored when a submit is refused.

## Who sees what

|              | Fill | Own submissions | Everyone's | Reopen and correct |
| ------------ | :--: | :-------------: | :--------: | :----------------: |
| Owner, admin |  ✓   |        ✓        |     ✓      |         ✓          |
| Dispatcher   |  ✓   |        ✓        |     ✓      |                    |
| Engineer     |  ✓   |        ✓        |            |                    |
| Viewer       |      |                 |     ✓      |                    |

Filling also needs the person's role in the form's own fill roles (P07's settings). Drafts
are visible only to their author. The author of a reopened submission may correct it.
Anything a caller may not see answers 404.

## Reporting

Postgres cannot give each company's forms their own generated columns without running DDL
at publish, so reportable answers go into a typed side table instead:

- At publish, `reportableFields` from the engine decides which questions report and as
  what: text, number, date, time, date-time or boolean. Long text and evidence (photos,
  files, signatures, locations) do not. The list is stored on the version and never
  changes.
- Whenever a submission becomes submitted, the trigger rewrites its rows in
  `submission_values` — one per answer, one per option of a multi-select — in the column
  its type names. While it is reopened, the last submitted values stay.
- Each value type has its own index leading with company, form and question.
- `submissions.search` is a generated full-text vector over every written answer.

`GET /v1/submissions?formId=…&filter=pressure:gt:4&filter=result:eq:fail` pages by keyset.
Ten thousand submissions per company in two companies filter in 5–45 ms locally
(`submission-reporting.integration.test.ts`, budget 300 ms).

`GET /v1/submissions/export?formId=…` streams CSV with the same filters: one column per
question any published version asked, headed by its answer key; a byte-order mark so a
spreadsheet opens Arabic as UTF-8; and text that a spreadsheet would run as a formula
prefixed with an apostrophe.

## Media

```
POST /v1/media                → a pending record, and a link to PUT the bytes to
PUT  <link>                   → straight to storage
POST /v1/media/:id/complete   → the API checks storage holds exactly what was declared
GET  /v1/media/:id            → a five-minute link to read it
```

`MediaStorage` (`apps/api/src/media/storage.ts`) has one implementation today:
`LocalDiskStorage`, which signs its own upload and download links with HMAC so they behave
like R2 presigned URLs, and serves them outside `/v1`. P09 adds the R2 implementation; the
routes, the widgets and the submission checks do not change. Production refuses to start
with local storage.

Types a browser would execute when a link is opened — HTML, SVG, XML, JavaScript — are
refused whatever a form's question says. Everything else is checked against the question's
own limits by the widget before sending and by the engine at submit.

## The renderer

`@integr8/form-renderer-dom` is shared by the web and desktop apps. P01 keeps widgets out
of `packages/` because React DOM and React Native cannot share them; two React DOM apps
can, and the plan's exception is recorded in P01.

- `FormFiller` — pages one at a time, section navigation, announced progress, a list of
  every problem when review is blocked (each a link that moves focus to its question), a
  review screen of exactly what will be sent, and the server's refusals linked the same
  way. A correction asks why.
- `AnswerView` — answers read back against their own version, optionally marking what
  changed since an earlier state.
- A widget for every field type, on native controls where one exists. The signature pad
  takes mouse, trackpad, pen and finger through Pointer Events and always offers typing a
  name instead. Digits typed on an Arabic or Persian keyboard become the ones the engine
  stores.
- `@integr8/form-renderer-dom/screens` — the fill, list and detail screens, for an app that
  supplies an API client, its routing and a download function.

Tailwind classes live in the package, so each app's stylesheet adds
`@source '…/node_modules/@integr8/form-renderer-dom/dist';`.

### Adding a field type

After the steps in [the engine's README](README.md#adding-a-field-type):

1. a widget in `src/widgets/` and a case in `field.tsx`; a group of controls goes in
   `isGroup`;
2. a case in `widgets.test.tsx` — the test fails until every registry type has one;
3. a value in `REPORTABLE_TYPES` and a rendering in `answer-view.tsx`.

## Running it locally

The API needs `API_CORS_ORIGINS` outside development (in development the local web and
desktop origins are allowed), and writes uploads to `MEDIA_LOCAL_DIR` (default
`.data/media`, ignored by git). See `apps/api/.env.example`.
