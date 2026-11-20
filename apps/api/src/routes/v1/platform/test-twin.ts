import { ROLES, toPlatformUserId, toTenantId } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { makeTestTwin } from '../../../platform/test-twin.js';
import { recordPlatformAction } from './audit.js';

/**
 * Making a test twin of a company (P44, option A), from the staff app's
 * company page: a new test company with the company's setup and none of its
 * business, for the developer MCP server to build in. What is copied and why
 * is in `platform/test-twin.ts`.
 *
 * A full staff session only (no `platformScopes`): a session limited to test
 * companies is refused with 403 `session_scope`, because this reads a real
 * company. The reason is required and lands in the platform audit log, and
 * the real company's own audit log says a twin was made of it.
 */

const companyRefSchema = z.object({ id: z.uuid(), slug: z.string(), name: z.string() });

const testTwinSchema = z.object({
  source: companyRefSchema,
  twin: companyRefSchema,
  /** The made-up people, one per built-in role; none can sign in. */
  people: z.array(z.object({ role: z.enum(ROLES), email: z.string(), userId: z.uuid() })),
  copied: z.object({
    people: z.number().int(),
    roles: z.number().int(),
    qualificationTypes: z.number().int(),
    jobTypes: z.number().int(),
    deadlineRules: z.number().int(),
    expenseCategories: z.number().int(),
    forms: z.number().int(),
    publishedForms: z.number().int(),
    documentTemplates: z.number().int(),
    pictures: z.number().int(),
    modules: z.number().int(),
    droppedActions: z.number().int(),
  }),
  /**
   * Set when the twin's storage could not take the pictures: the logo, the app
   * icon and the PDF templates were left out, everything else was copied.
   */
  storageProblem: z.string().nullable(),
});

export const makeTestTwinRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/test-twin',
  operationId: 'makeTestTwin',
  summary: 'Make a test twin of a company',
  description:
    'Creates a new test company with this company’s setup and none of its business: settings and branding (logo and app icon copied), modules and tabs, company roles, qualification types, job types with their forms and required qualifications, deadline rules, expense categories, and every form that is not archived (its last published version published again, its draft kept) with its PDF templates and their pictures. Never copied: people, customers, sites, jobs, submissions, documents, stock, money, the ledger, HR, payroll, contracts, website keys, the website address, e-invoicing settings, sign-in accounts. The twin gets one made-up member per built-in role (addresses under example.com, no sign-in), so the developer MCP server can act as each. Full staff session only; audited in the platform audit log and in both companies’ own logs.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: z.object({
    /** Why, for the audit logs: whose build this is for. */
    reason: z.string().trim().min(3).max(500),
    name: z.string().trim().min(1).max(200).optional(),
    slug: z
      .string()
      .min(2)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u, 'Lower case letters, digits and hyphens')
      .optional(),
  }),
  responses: {
    201: { description: 'The twin, and what was copied into it.', schema: testTwinSchema },
    403: { description: 'A staff session limited to test companies (`session_scope`).' },
    404: { description: 'No such company.' },
    409: {
      description:
        'The company is closed (`company_closed`), the slug is taken (`slug_taken`), or a picture its PDF templates use is gone from storage (`document_template_image_missing`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const made = await makeTestTwin({
      sourceTenantId: params.tenantId,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.slug === undefined ? {} : { slug: body.slug }),
      by: toPlatformUserId(context.platform.platformUserId),
      media: context.services.media,
    });

    await recordPlatformAction(context, {
      action: 'tenant.test_twin_made',
      tenantId: made.source.id,
      tenantSlug: made.source.slug,
      targetKind: 'tenant',
      targetId: made.twin.id,
      reason: body.reason,
      metadata: {
        twinTenantId: made.twin.id,
        twinSlug: made.twin.slug,
        copied: made.counts,
        storageProblem: made.storageProblem,
      },
    });
    // The real company's own log says a copy of its setup was made, and by whom.
    await withTenant(toTenantId(made.source.id), (tx) =>
      tx.auditLog.append({
        actorKind: 'platform_user',
        actorId: context.platform.platformUserId,
        actorLabel: 'Integr8 staff',
        action: 'tenant.test_twin_made',
        resourceType: 'tenant',
        resourceId: made.source.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { twinTenantId: made.twin.id, twinSlug: made.twin.slug, reason: body.reason },
      }),
    );

    const ref = (tenant: { id: string; slug: string; name: string }) => ({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
    });
    return {
      status: 201,
      body: {
        source: ref(made.source),
        twin: ref(made.twin),
        people: made.people,
        copied: made.counts,
        storageProblem: made.storageProblem,
      },
    };
  },
});

export const platformTestTwinRoutes = [makeTestTwinRoute];
