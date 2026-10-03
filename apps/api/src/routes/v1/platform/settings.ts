import { toPlatformUserId } from '@integr8/core';
import { ANNOUNCEMENT_SEVERITIES, type Announcement, getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso, isoOrNull } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { announcementSchema, featureFlagSchema, platformListSchema } from './schemas.js';

/**
 * Feature flags and announcements (P15).
 *
 * Both are the platform reaching into every company at once, which is why both
 * live behind a platform token and both are audited.
 *
 * Flags are two tables on purpose: `feature_flags` says what a flag is and what
 * everybody gets by default, `tenant_feature_flags` overrides it for one
 * company. A company with no row gets the default, so turning something on for
 * everybody is one row rather than a row per customer — and turning it off for
 * one difficult account afterwards does not have to find them all again.
 */

/**
 * The shape a flag key must have, matching the check constraint on the table.
 *
 * Declared here as well so a bad key is a 422 that says what is wrong, rather
 * than a 500 from Postgres refusing it three layers down.
 */
const flagKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]{0,63}$/u, 'Lower case letters, digits and underscores');

export const listFlagsRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/flags',
  operationId: 'listFeatureFlags',
  summary: 'Every feature flag and its default',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The flags.', schema: platformListSchema(featureFlagSchema) },
  },
  handler: async (_input, context) => {
    void context;
    const flags = await getPlatformDataSource().settings.listFlags();
    return {
      status: 200,
      body: {
        items: flags.map((flag) => ({
          key: flag.key,
          description: flag.description,
          defaultEnabled: flag.defaultEnabled,
        })),
      },
    };
  },
});

export const upsertFlagRoute = defineRoute({
  method: 'put',
  path: '/v1/platform/flags/:key',
  operationId: 'upsertFeatureFlag',
  summary: 'Declare a flag, or change what it does by default',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ key: flagKey }),
  query: noSchema,
  body: z.object({
    description: z.string().min(1).max(500),
    defaultEnabled: z.boolean(),
  }),
  responses: { 200: { description: 'Saved.', schema: featureFlagSchema } },
  handler: async ({ params, body }, context) => {
    const flag = await getPlatformDataSource().settings.upsertFlag({
      key: params.key,
      description: body.description,
      defaultEnabled: body.defaultEnabled,
    });

    await recordPlatformAction(context, {
      action: 'flag.declared',
      targetKind: 'feature_flag',
      targetId: flag.key,
      metadata: { defaultEnabled: body.defaultEnabled },
    });

    return {
      status: 200,
      body: {
        key: flag.key,
        description: flag.description,
        defaultEnabled: flag.defaultEnabled,
      },
    };
  },
});

export const setCompanyFlagRoute = defineRoute({
  method: 'put',
  path: '/v1/platform/companies/:tenantId/flags/:key',
  operationId: 'setCompanyFlag',
  summary: 'Turn a flag on or off for one company',
  description:
    'Sending `null` removes the override, which is different from turning it off: the company goes back to whatever the default is, including when the default later changes.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid(), key: flagKey }),
  query: noSchema,
  body: z.object({ enabled: z.boolean().nullable() }),
  responses: {
    200: {
      description: 'The company’s flags, resolved.',
      schema: z.object({ flags: z.record(z.string(), z.boolean()) }),
    },
  },
  handler: async ({ params, body }, context) => {
    const settings = getPlatformDataSource().settings;
    await settings.setFlag({
      tenantId: params.tenantId,
      key: params.key,
      enabled: body.enabled ?? undefined,
      updatedBy: toPlatformUserId(context.platform.platformUserId),
    });

    await recordPlatformAction(context, {
      action: body.enabled === null ? 'flag.override_removed' : 'flag.set',
      tenantId: params.tenantId,
      targetKind: 'feature_flag',
      targetId: params.key,
      metadata: { enabled: body.enabled },
    });

    return { status: 200, body: { flags: await settings.flagsFor(params.tenantId) } };
  },
});

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export const listAnnouncementsRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/announcements',
  operationId: 'listAnnouncements',
  summary: 'Banners now showing, and the ones still to start',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: z.object({
    includeFinished: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  }),
  body: noSchema,
  responses: {
    200: { description: 'The announcements.', schema: platformListSchema(announcementSchema) },
  },
  handler: async ({ query }, context) => {
    void context;
    const announcements = await getPlatformDataSource().settings.listAnnouncements({
      includeFinished: query.includeFinished,
    });
    return { status: 200, body: { items: announcements.map(toAnnouncement) } };
  },
});

export const createAnnouncementRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/announcements',
  operationId: 'createAnnouncement',
  summary: 'Put a banner in front of everybody',
  description:
    'Shown by the web, desktop and mobile apps, which each ask for what applies to them on `/v1/me`. The message is by language tag so one banner serves every locale rather than the English-speaking half of a customer.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: z.object({
    /** Null, or absent, means every company. */
    tenantId: z.uuid().nullable().default(null),
    severity: z.enum(ANNOUNCEMENT_SEVERITIES).default('info'),
    // At least one language. The table has the same constraint, and reaching
    // it would be a 500 for what is plainly a bad request.
    message: z
      .record(z.string().min(2).max(10), z.string().min(1).max(2000))
      .refine((value) => Object.keys(value).length > 0, 'At least one language is needed'),
    startsAt: z.iso.datetime().optional(),
    endsAt: z.iso.datetime().nullable().default(null),
    dismissible: z.boolean().default(true),
  }),
  responses: { 201: { description: 'Created.', schema: announcementSchema } },
  handler: async ({ body }, context) => {
    const announcement = await getPlatformDataSource().settings.createAnnouncement({
      tenantId: body.tenantId,
      severity: body.severity,
      message: body.message,
      ...(body.startsAt === undefined ? {} : { startsAt: new Date(body.startsAt) }),
      endsAt: body.endsAt === null ? null : new Date(body.endsAt),
      dismissible: body.dismissible,
      createdBy: toPlatformUserId(context.platform.platformUserId),
    });

    await recordPlatformAction(context, {
      action: 'announcement.created',
      tenantId: body.tenantId,
      targetKind: 'announcement',
      targetId: announcement.id,
      metadata: { severity: body.severity, everybody: body.tenantId === null },
    });

    return { status: 201, body: toAnnouncement(announcement) };
  },
});

export const endAnnouncementRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/announcements/:id/end',
  operationId: 'endAnnouncement',
  summary: 'Take a banner down',
  description:
    'Ends it now rather than deleting it. It was shown to people, and that is history worth keeping.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ id: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Ended.', schema: announcementSchema },
    404: { description: 'No such announcement, or it had already ended.' },
  },
  handler: async ({ params }, context) => {
    const ended = await getPlatformDataSource().settings.endAnnouncement(params.id);
    if (ended === undefined) {
      throw notFound(`No announcement ${params.id} is running`);
    }

    await recordPlatformAction(context, {
      action: 'announcement.ended',
      tenantId: ended.tenantId,
      targetKind: 'announcement',
      targetId: ended.id,
    });

    return { status: 200, body: toAnnouncement(ended) };
  },
});

function toAnnouncement(row: Announcement): z.infer<typeof announcementSchema> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    severity: row.severity,
    message: row.message,
    startsAt: iso(row.startsAt),
    endsAt: isoOrNull(row.endsAt),
    dismissible: row.dismissible,
    createdAt: iso(row.createdAt),
  };
}

export const platformSettingsRoutes = [
  listFlagsRoute,
  upsertFlagRoute,
  setCompanyFlagRoute,
  listAnnouncementsRoute,
  createAnnouncementRoute,
  endAnnouncementRoute,
];
