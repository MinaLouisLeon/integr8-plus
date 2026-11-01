# PDF documents — plan and status

Decided with the owner on 16 October 2026. Decisions:
[`ADR-0001-pdf-documents.md`](./ADR-0001-pdf-documents.md).

## What the owner asked for

Integr8 staff design, for each form they build for a company, PDF templates:
A4 portrait pages with a background that repeats on every page (and, if wanted,
a different first page), holding text, checkboxes, tables, images and a QR code.
A company member turns a submission into a PDF from a template, typing any
document fields the template asks for. The PDF is stored in the company's R2
bucket, and its QR code opens a page where anyone with the link can view and
download it. The company finds its PDFs in a Documents section, searches them by
their fields, and can expire or delete them. A company's own website (Next.js on
Vercel) can look a document up by an agreed field, authenticated by a website
key that only the terminal-created platform account can issue.

## Phases

| Phase | Status   | What it covers                                                                                                                                                                        |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | Complete | This plan; ADR-0001.                                                                                                                                                                  |
| B     | Complete | Permissions, the `documents` module flag, navigation, migration 0048 (templates, documents, field values, website keys), repositories, retention rule.                                |
| C     | Complete | `@integr8/document-render`: the template schema and the HTML renderer shared by the designer's preview and the server.                                                                |
| D     | Complete | The PDF pipeline (Chromium, backgrounds), the render job, routes for templates, documents, the public link, the website lookup and website keys.                                      |
| E     | Complete | The desktop designer, the Documents register and export in the apps, the `/d/<code>` page, the dashboard's website-key panel, the phone's list.                                       |
| F     | Complete | Runbook, the website developer's guide, the setup guide (every copy), full checks, the pull request.                                                                                  |
| G     | Complete | 1.2.4: uploaded PDFs, the sharing switch (new documents start unshared), the lookup by reference, files readable only through their record (0067).                                    |
| H     | Complete | 1.3.0: header and three-place footer, landscape, style and fonts, drag and drop, undo, copy and paste, recovery, Preview as PDF, templates that survive form versions (ADR addendum). |

## Verification log

Commands actually run, with their outcome. "Not run" means not run.

| When    | Command                                                                                                  | Result                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Phase C | `pnpm --filter @integr8/document-render test`, `lint`, `typecheck`                                       | 19 tests pass; clean.                                                                                        |
| Phase D | `pnpm --filter @integr8/api test`                                                                        | 28 files, 227 tests pass, including the Chromium printer printing English and Arabic.                        |
| Phase D | `pnpm --filter @integr8/api test:integration` (fresh test database)                                      | 48 files pass, 1 skipped (R2, needs credentials); 500 tests, 19 of them for documents.                       |
| Phase D | `pnpm --filter @integr8/db test:integration`                                                             | 33 files, 384 tests pass.                                                                                    |
| Phase D | `pnpm turbo run typecheck`                                                                               | 28 tasks pass.                                                                                               |
| Phase D | `pnpm licences:check`                                                                                    | Passes with `playwright-core` and `pdf-lib` added.                                                           |
| Phase E | `pnpm --filter @integr8/operations-dom test`                                                             | 29 files, 294 tests pass, 5 of them for the Documents register.                                              |
| Phase E | `pnpm --filter @integr8/form-renderer-dom test`                                                          | Passes, with 4 tests for Make PDF.                                                                           |
| Phase E | `pnpm --filter @integr8/desktop test`                                                                    | Passes, with 5 tests for the template designer.                                                              |
| Phase E | `pnpm turbo run typecheck lint test` (apps and shared screens)                                           | All pass; an untouched payroll screen test timed out once under the parallel load and passed when run again. |
| Phase E | The `/d/<code>` page against a mock API, in a browser                                                    | Correct on a phone and a desktop, in English and Arabic, and for a stopped link.                             |
| Phase F | `pnpm guide:check`                                                                                       | 15 stages, 62 parts, 263 tick boxes, in step; the published guide republished as version 38.                 |
| Phase F | `pnpm format:check`, `pnpm licences:check`, `pnpm turbo run typecheck lint build`, `pnpm turbo run test` | All pass: 49 build, lint and typecheck tasks, 28 test tasks.                                                 |
| Phase H | `pnpm --filter @integr8/document-render test`, `lint`, `typecheck`                                       | 33 tests pass; clean. Version 1 designs print the same HTML and footer, and the same pixels, as before.      |
| Phase H | `pnpm --filter @integr8/api exec vitest run --project unit src/documents` (with Chromium)                | Passes, including landscape and a header left off the first page.                                            |
| Phase H | API integration: `documents`, `documents-designer`, `forms` suites                                       | 58 tests pass.                                                                                               |
| Phase H | `pnpm --filter @integr8/desktop test`, `lint`, `typecheck`, `vite build`                                 | 143 tests pass; clean; pdf.js bundled as a lazy chunk and its worker.                                        |
| Phase H | Sample PDFs through the real printer path; the designer in a harness against a mocked API                | English and Arabic, portrait and landscape: `docs/screenshots/1.3.0/pdf/`.                                   |
