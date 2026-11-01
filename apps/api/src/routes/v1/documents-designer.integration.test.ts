import { randomUUID } from 'node:crypto';
import { withTenant } from '@integr8/db';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingPrinter } from '../../documents/printer.js';
import { createLogger } from '../../http/logger.js';
import { buildJobHandlers } from '../../jobs/handlers.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';
import { PREVIEW_PER_PERSON_PER_MINUTE } from './documents.js';

/**
 * The PDF designer's 1.3.0 additions over HTTP: "Preview as PDF" (printed,
 * returned, never stored, staff only, rate-limited); version 2 designs and
 * the refusal of an older designer saving over one; and templates against a
 * form's versions — the publish check lists the templates a version breaks,
 * publishing asks to confirm, the template is then marked with the blocks to
 * fix, a save keeps working, and documents keep being made.
 */

const WEB = 'https://app.test.integr8';

let api: ApiHarness;
let owner: Member;
let engineer: Member;
let builder: string;
const tokens = new Map<Member, string>();
let formId: string;
let submissionId: string;
let templateId: string;

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function as(
  who: Member | string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  let token = typeof who === 'string' ? who : tokens.get(who);
  if (token === undefined && typeof who !== 'string') {
    token = await api.signIn(who);
    tokens.set(who, token);
  }
  return api.call(token!, {
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const question = (id: string, label: string) => ({ id, type: 'text', label: { en: label } });

function definition(withResult: boolean) {
  return {
    schemaVersion: 1,
    title: { en: 'Inspection' },
    pages: [
      {
        id: 'page_1',
        sections: [
          {
            id: 'section_1',
            fields: [
              question('customer', 'Customer'),
              ...(withResult ? [question('result', 'Result')] : []),
            ],
          },
        ],
      },
    ],
  };
}

async function publish(withResult: boolean, acknowledge: Record<string, boolean> = {}) {
  const detail = json<{ draft: { revision: number } | null }>(
    await as(builder, 'GET', `/v1/forms/${formId}`),
  );
  const saved = await as(builder, 'PUT', `/v1/forms/${formId}/draft`, {
    definition: definition(withResult),
    expectedRevision: detail.draft?.revision ?? null,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return as(builder, 'POST', `/v1/forms/${formId}/draft/publish`, {
    expectedRevision: json<{ revision: number }>(saved).revision,
    ...acknowledge,
  });
}

function design(extra: Record<string, unknown>[] = []) {
  return {
    schemaVersion: 2,
    page: {
      orientation: 'landscape',
      margins: { top: 30, end: 15, bottom: 20, start: 15 },
      language: 'en',
      header: {
        start: { kind: 'logo', height: 12 },
        center: { kind: 'text', text: { en: 'Job {{work_order.reference}}' }, bold: true },
        end: { kind: 'page' },
        notOnFirstPage: true,
      },
      footer: { start: { kind: 'text', text: { en: '{{company.name}}' } }, end: { kind: 'page' } },
    },
    style: { brandColour: '#0e7490', font: 'integr8-text', tableLines: 'strong' },
    fields: [],
    blocks: [
      { type: 'heading', id: 'title', text: { en: '{{form.title}}' }, level: 1 },
      { type: 'field', id: 'customer', fieldId: 'customer', colour: 'brand' },
      { type: 'field', id: 'result', fieldId: 'result', shaded: true },
      ...extra,
    ],
  };
}

interface TemplateBody {
  id: string;
  revision: number;
  needsAttention: boolean;
  problems: { blockId: string | null; code: string }[];
  design: { schemaVersion: number };
}

beforeAll(async () => {
  api = await startApi({ env: { PDF_RENDERER: 'recording', WEB_APP_URL: WEB } });
  const admin = await api.platformAdmin('ops');
  owner = await api.member('owner', 'owner');
  engineer = await api.member('engineer', 'engineer');
  builder = await api.staff(owner);
  const flag = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/documents`,
    payload: { enabled: true },
  });
  expect(flag.statusCode, flag.body).toBe(200);
  const created = await as(builder, 'POST', '/v1/forms', { title: 'Inspection' });
  formId = json<{ form: { id: string } }>(created).form.id;
  expect((await publish(true)).statusCode).toBe(200);
  const started = await as(engineer, 'POST', '/v1/submissions', { formId });
  const draft = json<{ submission: { id: string; revision: number } }>(started).submission;
  const submitted = await as(engineer, 'POST', `/v1/submissions/${draft.id}/submit`, {
    expectedRevision: draft.revision,
    answers: { customer: 'Nile Towers', result: 'Pass' },
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  submissionId = draft.id;
});

afterAll(async () => {
  await api.close();
});

describe('version 2 templates', () => {
  it('save a header, landscape pages and a style', async () => {
    const created = await as(
      builder,
      'POST',
      '/v1/document-templates',
      { formId, name: 'Inspection report', design: design() },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.statusCode, created.body).toBe(201);
    const template = json<TemplateBody>(created);
    templateId = template.id;
    expect(template.design.schemaVersion).toBe(2);
    expect(template).toMatchObject({ needsAttention: false, problems: [] });
    const stored = await withTenant(api.tenantId, (tx) => tx.documentTemplates.find(templateId));
    expect(stored?.designSchemaVersion).toBe(2);
  });

  it('refuse a version 1 design from an older designer over them', async () => {
    const old = await as(builder, 'PATCH', `/v1/document-templates/${templateId}`, {
      revision: 1,
      design: {
        schemaVersion: 1,
        page: { margins: { top: 20, end: 15, bottom: 20, start: 15 } },
        blocks: [],
      },
    });
    expect(old.statusCode, old.body).toBe(409);
    expect(code(old)).toBe('document_template_newer');
  });
});

describe('preview as PDF', () => {
  it('is for staff only', async () => {
    const refused = await as(owner, 'POST', `/v1/document-templates/${templateId}/preview`, {
      design: design(),
    });
    expect(refused.statusCode).toBe(403);
  });

  it('prints an unsaved design with sample answers, storing nothing', async () => {
    const before = await withTenant(api.tenantId, (tx) => tx.files.usage());
    const printer = api.services.pdf as RecordingPrinter;
    const printed = printer.printed.length;
    const unsaved = design([{ type: 'text', id: 'note', text: { en: 'Not saved yet' } }]);
    const response = await as(builder, 'POST', `/v1/document-templates/${templateId}/preview`, {
      design: unsaved,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = json<{ contentType: string; base64: string; pageCount: number }>(response);
    expect(body.contentType).toBe('application/pdf');
    const pdf = await PDFDocument.load(Buffer.from(body.base64, 'base64'));
    expect(pdf.getPageCount()).toBe(body.pageCount);
    // Landscape, with the header left off the first page through its own print.
    const [width, height] = [pdf.getPage(0).getWidth(), pdf.getPage(0).getHeight()];
    expect(width).toBeGreaterThan(height);
    const job = printer.printed[printed]!;
    expect(job.html).toContain('Not saved yet');
    expect(job.html).toContain('Sample answer');
    expect(job.landscape).toBe(true);
    expect(job.hasHeader).toBe(true);
    expect(job.firstPage?.hasHeader).toBe(false);
    expect(job.html).toContain("font-family:'Inter Variable'");
    expect(job.html).toContain('data:font/woff2;base64,');
    expect(await withTenant(api.tenantId, (tx) => tx.files.usage())).toEqual(before);
  });

  it('prints with a chosen submission of the form', async () => {
    const printer = api.services.pdf as RecordingPrinter;
    const response = await as(builder, 'POST', `/v1/document-templates/${templateId}/preview`, {
      design: design(),
      submissionId,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(printer.printed.at(-1)?.html).toContain('Nile Towers');
  });

  it('is limited to a few a minute for each person', async () => {
    let limited: { statusCode: number; body: string } | undefined;
    for (let attempt = 0; attempt < PREVIEW_PER_PERSON_PER_MINUTE; attempt += 1) {
      const response = await as(builder, 'POST', `/v1/document-templates/${templateId}/preview`, {
        design: design(),
      });
      if (response.statusCode === 429) {
        limited = response;
        break;
      }
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(limited?.statusCode).toBe(429);
    expect(code(limited!)).toBe('rate_limited');
  });
});

describe('templates against the form’s versions', () => {
  it('the publish check lists the templates and blocks a version breaks', async () => {
    const detail = json<{ draft: { revision: number } | null }>(
      await as(builder, 'GET', `/v1/forms/${formId}`),
    );
    const saved = await as(builder, 'PUT', `/v1/forms/${formId}/draft`, {
      definition: definition(false),
      expectedRevision: detail.draft?.revision ?? null,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const check = await as(builder, 'POST', `/v1/forms/${formId}/draft/check`);
    expect(check.statusCode, check.body).toBe(200);
    const affected = json<{
      documentTemplates: { templateId: string; problems: { blockId: string | null }[] }[];
    }>(check).documentTemplates;
    expect(affected).toEqual([
      expect.objectContaining({
        templateId,
        problems: [expect.objectContaining({ blockId: 'result' })],
      }),
    ]);
  });

  it('publishing asks to confirm, then marks the template', async () => {
    const refused = await publish(false);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(['document_templates_affected', 'breaking_changes_unacknowledged']).toContain(
      code(refused),
    );
    const published = await publish(false, {
      acknowledgeBreakingChanges: true,
      acknowledgeTemplateChanges: true,
    });
    expect(published.statusCode, published.body).toBe(200);
    const template = json<TemplateBody>(
      await as(builder, 'GET', `/v1/document-templates/${templateId}`),
    );
    expect(template.needsAttention).toBe(true);
    expect(template.problems).toEqual([
      expect.objectContaining({ blockId: 'result', code: 'unknown_field' }),
    ]);
  });

  it('saving keeps working with the old broken block, but refuses a new one', async () => {
    const current = json<TemplateBody>(
      await as(builder, 'GET', `/v1/document-templates/${templateId}`),
    );
    const kept = await as(builder, 'PATCH', `/v1/document-templates/${templateId}`, {
      revision: current.revision,
      name: 'Inspection report (landscape)',
      design: design([{ type: 'divider', id: 'line' }]),
    });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(json<TemplateBody>(kept).needsAttention).toBe(true);
    const added = await as(builder, 'PATCH', `/v1/document-templates/${templateId}`, {
      revision: json<TemplateBody>(kept).revision,
      design: design([{ type: 'field', id: 'ghost', fieldId: 'ghost' }]),
    });
    expect(added.statusCode, added.body).toBe(422);
    expect(code(added)).toBe('document_template_invalid');
  });

  it('documents are still made, and an older submission prints its own answers', async () => {
    const made = await as(
      engineer,
      'POST',
      `/v1/submissions/${submissionId}/documents`,
      { templateId, fields: {} },
      { 'idempotency-key': randomUUID() },
    );
    expect(made.statusCode, made.body).toBe(202);
    const documentId = json<{ id: string }>(made).id;
    const jobs = await withTenant(api.tenantId, (tx) =>
      tx.jobs.list({ queue: 'documents.render', status: 'pending' }),
    );
    const handlers = buildJobHandlers(api.services, api.config);
    const printer = api.services.pdf as RecordingPrinter;
    for (const job of jobs) {
      await handlers['documents.render']!(job.payload, {
        tenantId: api.tenantId,
        jobId: job.id,
        attempt: 1,
        logger: createLogger({ level: 'error', write: () => undefined }),
      });
    }
    const document = json<{ status: string; failureCode: string | null }>(
      await as(owner, 'GET', `/v1/documents/${documentId}`),
    );
    expect(document).toMatchObject({ status: 'ready', failureCode: null });
    // The submission answered the version that still had "Result".
    expect(printer.printed.at(-1)?.html).toContain('Pass');
  });
});
