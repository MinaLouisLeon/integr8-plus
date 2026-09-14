# The form builder

The desktop app's form builder (P07) is where a company admin turns "the boiler service
sheet" into a form an engineer can fill in. It is built on three layers, and each one
refuses the kind of mistake it is best placed to catch.

```
apps/desktop/src/features/forms     what the admin sees and does
        │  every edit is an engine authoring operation
@integr8/form-engine  authoring/    pure edits, conditions as sentences, diffs
        │  PUT draft · POST check · POST publish · POST test-submission
apps/api  routes/v1/forms.ts        the only way to a published version
        │
@integr8/db  forms, form_versions   immutable once published, enforced by triggers
```

---

## The rules that shape it

- **A draft may be invalid; a published version may not.** Autosave stores whatever the
  builder has, because a half-built form is what a draft is. Publish compiles the whole
  definition and refuses anything that does not compile, with a 422 whose details name
  every offending field. There is no other route to a published version.
- **Nobody publishes what they did not see.** Every save and every publish names the draft
  revision it is based on. A second tab that saves on a stale revision gets 409
  `draft_conflict`; a publish of a draft that changed since it was reviewed gets 409
  `draft_changed`.
- **Breaking changes are acknowledged, not discovered.** Removing a question that
  submissions answered is legal — earlier versions keep it — but publishing it without
  `acknowledgeBreakingChanges: true` is refused with 409 `breaking_changes_unacknowledged`.
  The builder explains each one by what it costs: a gap in reports, or work for anybody
  with an unfinished draft.
- **A test fill is not a submission.** `POST /v1/forms/:id/draft/test-submission` runs the
  exact validation a real submission gets against the saved draft and writes nothing.

## API

| Route                                      | Who          | What                                                    |
| ------------------------------------------ | ------------ | ------------------------------------------------------- |
| `GET /v1/forms`                            | everyone     | Forms; drafts and unpublished forms only for builders   |
| `POST /v1/forms`                           | owner, admin | A new form with an empty draft (idempotent)             |
| `GET /v1/forms/:id`                        | everyone     | The form, its live version, and its draft for builders  |
| `PATCH /v1/forms/:id`                      | owner, admin | Title, who may fill it, whether a signature is required |
| `POST /v1/forms/:id/clone`                 | owner, admin | A copy with no history (idempotent)                     |
| `PUT /v1/forms/:id/draft`                  | owner, admin | Autosave on `expectedRevision`                          |
| `POST /v1/forms/:id/draft/check`           | owner, admin | Every issue, and the diff against the live version      |
| `POST /v1/forms/:id/draft/publish`         | owner, admin | The new immutable version, with change note and summary |
| `POST /v1/forms/:id/draft/test-submission` | owner, admin | The server's verdict on a test fill; `stored: false`    |
| `GET /v1/forms/:id/versions[/:versionId]`  | everyone     | Published history, and any one version read-only        |
| `GET /v1/form-templates[/:key]`            | everyone     | The global template library                             |
| `POST /v1/form-templates/:key/clone`       | owner, admin | A new form from a template (idempotent)                 |

Every publish is written to the audit log as `form.published`, with the version number and
how many breaking changes were acknowledged.

Form settings — who may fill a form and whether a signature is mandatory — take effect at
once and are not versioned: they describe how the company uses the form, not what it asks.
Which job types require a form arrives with job types in P10.

## The template library

`form_templates` is a platform table: it belongs to no company, the runtime role may only
read it, and a company copies a template rather than using it. The library is whatever
`@integr8/form-engine/templates` ships, loaded with:

```sh
pnpm --filter @integr8/db db:templates
```

It is an upsert — removing a template from the code does not remove it from the database,
because companies may already have started from it. Run it after migrations in every
environment; it is product content, not seed data.

## In the desktop app

`apps/desktop/src/features/forms`:

| Path                               | Responsibility                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `model/editor.ts`                  | The editing reducer: definition, selection, bounded undo and redo                |
| `model/catalog.ts`                 | Palette groups and property editors, read from the engine's type registry        |
| `model/calculation.ts`             | Calculations as a left-to-right chain, and back                                  |
| `model/recovery.ts`                | The local copy that survives a crash, and what to offer on reopening             |
| `model/rename.ts`                  | A new question's answer key following its wording, until something depends on it |
| `model/issues.ts`                  | Which element to open for a compile issue                                        |
| `use-draft-sync.ts`                | Autosave, retry, conflict detection                                              |
| `components/canvas.tsx`            | Palette and drag-and-drop canvas (dnd-kit), with keyboard and button moves       |
| `components/config-panel.tsx`      | Everything about the selected question, section or page                          |
| `components/condition-builder.tsx` | "Show this when…" and custom checks, as sentences                                |
| `components/form-renderer.tsx`     | The preview: `viewForm` rendered for desktop and phone                           |
| `components/changes-panel.tsx`     | The server's check, the diff, and the publish dialog                             |

### Conditions as sentences

The builder never shows an expression. A condition is a list of clauses — a question, a
comparison named in words, an answer chosen the way the question itself is answered — joined
by "all of" or "any of", and `toExpression` / `fromExpression` in the engine turn that into
the typed syntax tree and back. An expression the builder cannot phrase (written by hand,
or later by AI generation) is shown read-only with a way to remove it, never rewritten into
something it did not say.

### Answer keys

A question's id is the key its answers are stored under, forever. A new question starts
keyed by its kind (`pick_one`) because it has no wording yet; when the admin finishes typing
the wording, the key is re-derived from it (`appliance_safe_to_use`) — but only while no
published version has used the key and no rule reads it, and never onto a key an earlier
version used for something else. After that it is fixed, and renaming the question changes
its label only.

### Autosave and recovery

Every edit is written to `localStorage` under the company and form, then sent about 800 ms
after the last change. A failed save retries with backoff and shows "Not saved yet"; a
conflict stops and offers to load the other version. On opening a form, a local copy that
never reached the server is offered back — with a warning if somebody has saved since. The
copy is removed as soon as the server has the same definition.

### Adding a property to a field type

Add it to the type's schema in `@integr8/form-engine`, then:

1. give it an editor in `editorFor` (`model/catalog.ts`) — `catalog.test.ts` fails until you do;
2. give it a label under `forms.config.property` in `@integr8/i18n` — `form-builder.test.ts`
   fails until you do.

## Running it locally

The builder needs the API, a migrated database with templates loaded, and a user who is an
owner or admin. See [the database runbook](../database/runbook-supabase-setup.md) for the
first two.

The desktop app and the API run on different origins (`localhost:3002` and `:3000`), and
**the API does not yet send CORS headers**, so a browser tab — and very likely the Tauri
webview — cannot call it cross-origin. This predates P07 and is tracked in the P07 phase
file; until it is fixed, a local run needs either CORS on the API or a same-origin proxy.
