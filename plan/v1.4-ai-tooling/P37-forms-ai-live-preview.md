# P37 — Forms for AI: a live preview window

**Version:** v1.4 AI tooling
**Status:** `NOT STARTED`
**Depends on:** P07 (form builder), P08 (web renderer), the 1.3.0 form files and Forms for AI
(`docs/forms-ai/README.md`)

## Goal

While somebody builds a form with an AI tool, they watch it take shape: the form as a person
fills it and each PDF as the server prints it, in a browser window that refreshes by itself
after every change the AI makes. They chat ("make the kilometres required, move the logo to the
right"), look, and save the `.integr8form` file only when it is right.

## Scope

Agreed on 2026-11-10:

- **This stage changes the AI tooling only.** The platform's own features (form actions,
  allowances) are planned afterwards, with these tools
  ([`plan/requests/CR-0001-form-actions.md`](../requests/CR-0001-form-actions.md)).
- **The preview window is built first**, together with the developer MCP server (P38).
- **Forms for AI stays offline and keyless** (form builder decision 15). The window is a page
  served by the program on the same computer, on the loopback address only. Nothing leaves the
  machine and no account is needed.
- **The form is shown with the web app's own filler** (`FormFiller` from
  `@integr8/form-renderer-dom`), so conditions, calculations, checks, English and Arabic behave
  exactly as in the product.
- **The PDF is printed the way the server prints it** (`previewTemplate`, already used by
  `preview_pdf`), with the answers typed in the Form tab when there are any.
- **Saving from the window** writes the same file `save_package` writes.

Out of scope: editing the form by clicking in the window (changes are made through the chat),
the phone's native filler (the window offers a phone-width view of the web filler, which the
behaviour check already holds to the same screens), anything that needs the server, and form
actions (they do not exist in the format yet).

## Where things stand (2026-11-10)

| Need                                   | Today                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| The AI sees a PDF                      | `preview_pdf` prints one template and returns page pictures to the AI        |
| The person sees a PDF                  | Only by opening the PDF file `preview_pdf` leaves in a temporary folder      |
| Anybody sees the form as it is filled  | Not possible before import; `summarize_form` lists the questions as text     |
| Changes show up after the AI edits     | No: every look is a new tool call and a new file                             |
| The filler runs outside the web app    | Yes: `@integr8/form-renderer-dom` is a library; the desktop app uses it too  |
| Extra files travel with the executable | Yes: Node SEA assets listed in `apps/forms-ai/src/assets.ts` (pdf.js, fonts) |

## Design

### 1. The preview session

One preview session per running MCP server, held in memory:

- the form definition, the PDF templates and their pictures, as last given by the AI;
- the check result (`checkFormPackage`) for that state;
- the answers the person typed in the window, and the last printed PDF per template;
- notes the person left in the window (see section 5).

Nothing is written to disk except printed PDFs in the scratch folder, as today.

### 2. The local page server

`apps/forms-ai/src/window/server.ts`, on Node's `http` module (no new dependency):

- Listens on `127.0.0.1` and a free port chosen by the system. Never on another address.
- The address carries a random token made at start (`http://127.0.0.1:<port>/?k=<token>`); a
  request without it gets 404. Requests whose `Host` header is not `127.0.0.1:<port>` are
  refused, which closes the DNS-rebinding route, and no CORS headers are sent.
- A strict Content-Security-Policy: scripts, styles, fonts and pictures from itself only, no
  outgoing connections. The page makes no request to any other host.
- Routes: the page and its bundle; `GET /state` (the session); `GET /events` (server-sent
  events: "state changed", "PDF ready"); `POST /answers` (what the person typed);
  `POST /print` (print one template now); `GET /pdf/<template>` (the last print);
  `POST /note`; `POST /save`.
- Stops with the MCP server, or after `close_preview`.

### 3. The page

A small React page in `apps/forms-ai/src/window/page/`, bundled by esbuild into one script and
one stylesheet and carried as SEA assets (added to `ASSETS`; run from source they are read from
`dist`). It uses `@integr8/form-renderer-dom`, `@integr8/i18n` and `@integr8/tokens`, and wears
the Integr8 Media look like the other staff tools.

| Part             | What it shows                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Form** tab     | The real filler. The person can type answers, add photos and a signature (kept in memory through a local `MediaAdapter`), and press Submit, which sends nothing and shows what was checked |
| **PDF** tab      | One entry per template: the printed PDF in the browser's own viewer, with "Use my answers" or "Use sample answers", language and company colour                                            |
| **Checks** tab   | The check report the AI sees (`formatCheck`), and the question list from `summarize_form` with its "To confirm" items                                                                      |
| Header controls  | English or Arabic, phone or desktop width, light or dark                                                                                                                                   |
| Footer           | "Save the form file…" and "Suggest a change to the platform" (the second arrives with P39)                                                                                                 |
| Connection badge | "Live" while the events stream is open; "Disconnected, the AI tool was closed" otherwise                                                                                                   |

A form that fails its check still shows as far as it compiles; where it cannot compile, the Form
tab shows the check's messages instead of an empty page.

### 4. Tools the AI gets

| Tool                | What it does                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_preview`      | Starts the page server if needed, stores the form, templates and pictures, opens the person's default browser on the window, and returns the address and the check report              |
| `update_preview`    | Replaces the form, the templates or both; the window refreshes; returns the check report. Typed answers are kept for questions that still exist with the same type                     |
| `get_preview_state` | What the person did in the window: their answers, the Submit outcome, the notes they left, which tab is open. The AI calls it when the person says "look at what I typed" or similar   |
| `close_preview`     | Stops the page server                                                                                                                                                                  |
| `preview_pdf`       | Unchanged. It still returns page pictures to the AI; when a window is open it also refreshes that template's PDF tab                                                                   |
| `save_package`      | Unchanged. The window's Save button calls the same code with the session's state; its folder and "file exists" rules stay. The click is the person's confirmation `save_package` needs |

The server's instructions text gains: open the preview once the first version of the form
checks, call `update_preview` after every change, and tell the person the window refreshed.

Opening the browser: `start` on Windows, `open` on macOS, `xdg-open` on Linux, through the
existing `Host` abstraction so tests do not open anything. If it fails, the tool returns the
address for the person to open themselves.

### 5. Notes from the person

A "Leave a note for the AI" box on every tab stores a short text with the tab and the question
or block it is about. `get_preview_state` returns the unread notes. This keeps small remarks
("this label is too long") next to what they are about, and is what P39 builds change requests
on.

### 6. Printing

- Printing needs Chrome, Edge or Chromium on the computer, as `preview_pdf` does. Without one
  the PDF tab says so and the Form and Checks tabs still work.
- A print starts when the PDF tab is opened, when the template changed, or on "Print again";
  never on every keystroke. One print at a time; a newer request replaces a waiting one.
- The printed file is served from the scratch folder and replaced on the next print.

### 7. Build and size

- `scripts/bundle.mjs` gains a second esbuild entry for the page (browser target, minified).
  `scripts/build-sea.mjs` already packs everything in `ASSETS`.
- React, the filler and the catalogues add a few megabytes to a program of about 130 MB.
- `pnpm pins:check`: any new dependency of `apps/forms-ai` (`react`, `react-dom`) is pinned to
  the exact versions the web app uses.

### 8. Testing

- Unit: the session (answers kept across an update), token and `Host` checks, the routes, the
  events stream, the Save route's "file exists" answer.
- The page: rendered with Testing Library as the other DOM packages are, on a form with
  conditions, a calculation, a repeating section and Arabic.
- A smoke test that starts the server, loads the window in the found browser through the
  existing CDP client, types an answer and reads the PDF tab; skipped when no browser is found,
  like the preview tests today.
- The MCP tools: `open_preview` → `update_preview` → `get_preview_state` with a fake `Host`.

### 9. Docs

- `docs/forms-ai/README.md`: "For staff" gains the window; "The tools the AI sees" gains the
  four tools; "For maintainers" gains the page bundle and the loopback rules.
- `MEMORY.md` and this file at the end of the work.
- No setup-guide step: the program is downloaded from the dashboard's Downloads page as before.

## Tasks

- [ ] `feat(forms-ai)`: the preview session and the loopback page server with its safety rules
- [ ] `feat(forms-ai)`: the page (Form, PDF and Checks tabs, language, width, theme) and its bundle
- [ ] `feat(forms-ai)`: `open_preview`, `update_preview`, `get_preview_state`, `close_preview`;
      `preview_pdf` refreshes an open window; the instructions text
- [ ] `feat(forms-ai)`: Save from the window; notes for the AI
- [ ] `build(forms-ai)`: page bundle as SEA assets; exact pins
- [ ] `docs`: Forms for AI page, `MEMORY.md`

## Exit criteria

- [ ] With an AI tool connected, `open_preview` opens a browser window showing the form in the
      product's own filler and each PDF template
- [ ] After the AI changes the form or a template, the window shows the change without a reload
      by the person, and answers already typed are still there
- [ ] Conditions, calculations, required checks and repeating sections behave in the window as
      they do in the web app, in English and Arabic
- [ ] The PDF tab prints with the answers typed in the Form tab
- [ ] "Save the form file…" writes a file that imports into the app as a draft
- [ ] The page server answers only on `127.0.0.1`, only with its token, and the page loads
      nothing from another host (checked by a test)
- [ ] Without Chrome or Edge the window still shows the form and says why there is no PDF
- [ ] The Windows, macOS and Linux executables carry the page (the release build's own check)

## Notes

- To verify during the build: that the browser's built-in viewer shows a PDF inside the page
  under the strict policy on Chrome, Edge, Firefox and Safari; if one refuses, that browser gets
  the page pictures `preview_pdf` already makes.
- Forms for AI's update check still finds nothing while the repository is private (an open item
  in `MEMORY.md`); the new version reaches staff through the Downloads page.
