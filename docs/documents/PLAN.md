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

| Phase | Status      | What it covers                                                                                                                                         |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | Complete    | This plan; ADR-0001.                                                                                                                                   |
| B     | Complete    | Permissions, the `documents` module flag, navigation, migration 0048 (templates, documents, field values, website keys), repositories, retention rule. |
| C     | Complete    | `@integr8/document-render`: the template schema and the HTML renderer shared by the designer's preview and the server.                                 |
| D     | Not started | The PDF pipeline (Chromium, backgrounds), the render job, routes for templates, documents, the public link, the website lookup and website keys.       |
| E     | Not started | The desktop designer, the Documents register and export in the apps, the `/d/<code>` page, the dashboard's website-key panel, the phone's list.        |
| F     | Not started | Runbook, the website developer's guide, the setup guide (every copy), full checks, the pull request.                                                   |

## Verification log

Commands actually run, with their outcome. "Not run" means not run.

| When | Command | Result |
| ---- | ------- | ------ |
