import { type ImportRecord, withTenant } from '@integr8/db';
import { z } from 'zod';
import { notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import {
  IMPORT_COLUMNS,
  importTemplate,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
} from '../../imports/definitions.js';
import { IMPORT_QUEUE } from '../../imports/run-import.js';
import { isKnownTimeZone } from '../../imports/zoned-time.js';
import { peopleOf, personBody, personSchema } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * CSV imports of customers, sites and work orders (P10).
 *
 * The file is stored and processed in the background, row by row: each row is
 * written or refused on its own, with the spreadsheet row number and the
 * reason, so one bad row never costs the rest of the file.
 */

const TAGS = ['imports'];

const kindSchema = z.enum(['customers', 'sites', 'work_orders']);

const importSchema = z.object({
  id: z.uuid(),
  kind: kindSchema,
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  fileName: z.string(),
  totalRows: z.number().int(),
  succeededRows: z.number().int(),
  failedRows: z.number().int(),
  createdBy: personSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

const importDetailSchema = importSchema.extend({
  /** Row 1 is the header. At most 5,000 are kept; the counts stay exact. */
  errors: z.array(
    z.object({
      row: z.number().int(),
      column: z.string().nullable(),
      code: z.string(),
      message: z.string(),
    }),
  ),
});

function importBody(record: ImportRecord, people: Map<string, string>) {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    fileName: record.fileName,
    totalRows: record.totalRows,
    succeededRows: record.succeededRows,
    failedRows: record.failedRows,
    createdBy: personBody(record.createdBy, people),
    createdAt: iso(record.createdAt),
    startedAt: isoOrNull(record.startedAt),
    completedAt: isoOrNull(record.completedAt),
  };
}

export const startImportRoute = defineRoute({
  method: 'post',
  path: '/v1/imports',
  operationId: 'startImport',
  summary: 'Import customers, sites or work orders from CSV',
  description: `The CSV is sent as text, at most 5 MB and ${String(MAX_IMPORT_ROWS)} rows, with the first row naming the columns (see the template). Dates without an offset are read in \`timeZone\`, which a browser should set to its own. Returns at once; poll the import for progress and per-row errors. Honours \`Idempotency-Key\`.`,
  tags: TAGS,
  security: 'authenticated',
  permission: 'import.run',
  idempotent: true,
  bodyLimit: MAX_IMPORT_BYTES + 64 * 1024,
  params: noSchema,
  query: noSchema,
  body: z.object({
    kind: kindSchema,
    fileName: z.string().trim().min(1).max(255),
    csv: z.string().min(1).max(MAX_IMPORT_BYTES),
    timeZone: z.string().max(64).default('UTC'),
  }),
  responses: {
    202: { description: 'The import, queued.', schema: importSchema },
    422: { description: 'The time zone is not one the server knows.' },
  },
  handler: async ({ body }, context) => {
    if (!isKnownTimeZone(body.timeZone)) {
      throw unprocessable('unknown_time_zone', 'This time zone is not one the server knows.', [
        {
          field: 'body.timeZone',
          code: 'unknown_time_zone',
          message: `"${body.timeZone}" is not an IANA time zone.`,
        },
      ]);
    }
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const record = await tx.imports.create(
        { kind: body.kind, fileName: body.fileName, source: body.csv },
        context.principal.userId,
      );
      // One attempt: rows written before a crash stay written, and a retry would write them again.
      await tx.jobs.enqueue({
        queue: IMPORT_QUEUE,
        payload: { importId: record.id, timeZone: body.timeZone },
        maxAttempts: 1,
      });
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: 'import.started',
        resourceType: 'import',
        resourceId: record.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { kind: body.kind, fileName: body.fileName, bytes: Buffer.byteLength(body.csv) },
      });
      return { record, people: await peopleOf(tx) };
    });
    return { status: 202, body: importBody(result.record, result.people) };
  },
});

export const listImportsRoute = defineRoute({
  method: 'get',
  path: '/v1/imports',
  operationId: 'listImports',
  summary: 'Recent imports',
  tags: TAGS,
  security: 'authenticated',
  permission: 'import.run',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Newest first.', schema: z.object({ items: z.array(importSchema) }) },
  },
  handler: async (_input, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const [records, people] = await Promise.all([tx.imports.list(), peopleOf(tx)]);
      return records.map((record) => importBody(record, people));
    });
    return { status: 200, body: { items } };
  },
});

export const getImportRoute = defineRoute({
  method: 'get',
  path: '/v1/imports/:importId',
  operationId: 'getImport',
  summary: 'An import’s progress and per-row errors',
  tags: TAGS,
  security: 'authenticated',
  permission: 'import.run',
  params: z.object({ importId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The import.', schema: importDetailSchema },
    404: { description: 'No such import.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const record = await tx.imports.find(params.importId);
      if (record === undefined) {
        throw notFound('This import does not exist.');
      }
      return { ...importBody(record, await peopleOf(tx)), errors: record.errors };
    });
    return { status: 200, body };
  },
});

export const importTemplateRoute = defineRoute({
  method: 'get',
  path: '/v1/imports/templates/:kind',
  operationId: 'getImportTemplate',
  summary: 'The CSV template for an import',
  description:
    'A header row and one example row. The columns are described in `GET /v1/imports/columns/:kind`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'import.run',
  params: z.object({ kind: kindSchema }),
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'CSV.', schema: z.string(), contentType: 'text/csv' } },
  handler: ({ params }) =>
    Promise.resolve({
      status: 200,
      body: importTemplate(params.kind),
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${params.kind}-template.csv"`,
      },
    }),
});

export const importColumnsRoute = defineRoute({
  method: 'get',
  path: '/v1/imports/columns/:kind',
  operationId: 'getImportColumns',
  summary: 'What each column of an import means',
  tags: TAGS,
  security: 'authenticated',
  permission: 'import.run',
  params: z.object({ kind: kindSchema }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The columns, in template order.',
      schema: z.object({
        items: z.array(
          z.object({
            name: z.string(),
            required: z.boolean(),
            description: z.string(),
            example: z.string(),
          }),
        ),
      }),
    },
  },
  handler: ({ params }) =>
    Promise.resolve({
      status: 200,
      body: { items: IMPORT_COLUMNS[params.kind].map((column) => ({ ...column })) },
    }),
});

export const importRoutes = [
  startImportRoute,
  listImportsRoute,
  importTemplateRoute,
  importColumnsRoute,
  getImportRoute,
];
