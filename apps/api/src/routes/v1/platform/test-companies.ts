import { toTenantId } from '@integr8/core';
import { getPlatformDataSource, TEST_OUTBOX_CHANNELS, withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso } from '../schemas.js';
import { platformListSchema } from './schemas.js';

/**
 * Reading back what happened in a test company (0077, P38).
 *
 * The developer MCP server calls a route as one of a test company's people and
 * then asks what came of it: the lines the company's own audit log gained, and
 * the mail and push it would have sent. Both answer for test companies only:
 * a limited session is held to them by `http/session-scope.ts`, and a full
 * session asking about a real company is refused here, because a real
 * company's outbox is always empty and its audit log has a screen of its own.
 */

const outboxEntrySchema = z.object({
  id: z.uuid(),
  channel: z.enum(TEST_OUTBOX_CHANNELS),
  recipient: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  /** Attachments by name, type and size; for push, the message's data. */
  details: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});

const companyAuditEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  actorKind: z.string(),
  actorId: z.string().nullable(),
  actorLabel: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

const sinceQuery = z.iso
  .datetime()
  .optional()
  .describe('Only entries at or after this moment, e.g. the time a call was sent.');
const limitQuery = z.coerce.number().int().min(1).max(200).default(50);

async function testCompany(tenantId: string) {
  const tenant = await getPlatformDataSource().tenants.findById(tenantId);
  if (tenant === undefined) {
    throw notFound(`No company with id ${tenantId}`);
  }
  if (!tenant.isTest) {
    throw conflict('not_a_test_company', 'This is not a test company.');
  }
  return tenant;
}

export const testOutboxRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/test-outbox',
  operationId: 'listTestOutbox',
  summary: 'What a test company would have emailed or pushed',
  description:
    'A test company sends no mail and no push notifications; each message is kept here for 7 days instead, newest first. Attachments are listed, not kept.',
  tags: ['platform'],
  security: 'platform',
  platformScopes: ['full', 'test_companies'],
  params: z.object({ tenantId: z.uuid() }),
  query: z.object({
    since: sinceQuery,
    channel: z.enum(TEST_OUTBOX_CHANNELS).optional(),
    limit: limitQuery,
  }),
  body: noSchema,
  responses: {
    200: { description: 'Newest first.', schema: platformListSchema(outboxEntrySchema) },
    404: { description: 'No such company.' },
    409: { description: '`not_a_test_company`.' },
  },
  handler: async ({ params, query }) => {
    await testCompany(params.tenantId);
    const entries = await getPlatformDataSource().testOutbox.list(params.tenantId, {
      ...(query.since === undefined ? {} : { since: new Date(query.since) }),
      ...(query.channel === undefined ? {} : { channel: query.channel }),
      limit: query.limit,
    });
    return {
      status: 200,
      body: {
        items: entries.map((entry) => ({
          id: entry.id,
          channel: entry.channel,
          recipient: entry.recipient,
          subject: entry.subject,
          body: entry.body,
          details: entry.details,
          createdAt: iso(entry.createdAt),
        })),
      },
    };
  },
});

export const testCompanyAuditRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/test-audit',
  operationId: 'listTestCompanyAudit',
  summary: "A test company's own audit lines",
  description:
    "The company's audit log, newest first: what a call changed, read back. Test companies only; every action the developer MCP server takes is here under the staff account behind it.",
  tags: ['platform'],
  security: 'platform',
  platformScopes: ['full', 'test_companies'],
  params: z.object({ tenantId: z.uuid() }),
  query: z.object({ since: sinceQuery, limit: limitQuery }),
  body: noSchema,
  responses: {
    200: { description: 'Newest first.', schema: platformListSchema(companyAuditEntrySchema) },
    404: { description: 'No such company.' },
    409: { description: '`not_a_test_company`.' },
  },
  handler: async ({ params, query }) => {
    const tenant = await testCompany(params.tenantId);
    const entries = await withTenant(toTenantId(tenant.id), (tx) =>
      tx.auditLog.list({
        ...(query.since === undefined ? {} : { since: new Date(query.since) }),
        limit: query.limit,
      }),
    );
    return {
      status: 200,
      body: {
        items: entries.map((entry) => ({
          id: entry.id,
          occurredAt: iso(entry.occurredAt),
          actorKind: entry.actorKind,
          actorId: entry.actorId,
          actorLabel: entry.actorLabel,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          requestId: entry.requestId,
          metadata: entry.metadata,
        })),
      },
    };
  },
});

export const platformTestCompanyRoutes = [testOutboxRoute, testCompanyAuditRoute];
