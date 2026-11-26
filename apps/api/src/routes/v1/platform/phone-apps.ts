import { getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound } from '../../../http/errors.js';
import { defineRoute, noSchema, type PlatformRequestContext } from '../../../http/routes.js';
import { makeStoreReviewer, removeStoreReviewer } from '../../../platform/store-reviewer.js';
import { installerSchema, lookupSchema } from '../schemas.js';
import { recordPlatformAction } from './audit.js';

/**
 * A company's apps from the staff app's company page (0023).
 *
 * Its installers, so Integr8 staff can send a company the desktop app or the
 * phone APK: since the public download page was removed, the invitation page
 * shows them once and this is where they are found again. And the app stores'
 * reviewer account, for a company that publishes its phone app in its own
 * Google Play and App Store accounts.
 *
 * Full staff sessions only: a session limited to test companies has nothing to
 * do here, since test companies have no apps.
 */

const tenantParams = z.object({ tenantId: z.uuid() });

async function liveCompany(tenantId: string) {
  const tenant = await getPlatformDataSource().tenants.findById(tenantId);
  if (tenant?.deletedAt !== null) {
    throw notFound(`No company with id ${tenantId}`);
  }
  return tenant;
}

function who(context: PlatformRequestContext) {
  return {
    platformUserId: context.platform.platformUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  };
}

export const getCompanyAppsRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/apps',
  operationId: 'getCompanyApps',
  summary: 'A company’s newest desktop and phone installers',
  description:
    'Read from the GitHub releases this deployment is set to (`APP_RELEASES=github`): the company’s newest release with installers in it, for staff to download or send. `found` with its files, `none` when nothing is published (or releases are not read here), `unavailable` when GitHub could not be asked. The file links pass through the public site for a private repository, with its per-address download limit.',
  tags: ['platform'],
  security: 'platform',
  params: tenantParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The company’s installers.',
      schema: lookupSchema(
        z.object({ tag: z.string(), version: z.string(), installers: z.array(installerSchema) }),
      ),
    },
    404: { description: 'No such company.' },
  },
  handler: async ({ params }, context) => {
    const tenant = await liveCompany(params.tenantId);
    return {
      status: 200,
      body: await context.services.appReleases.companyInstallers(tenant.slug),
    };
  },
});

const reviewerSchema = z.object({
  /** False when the account already existed and only its password was replaced. */
  created: z.boolean(),
  userId: z.uuid(),
  email: z.string(),
  /** Shown once: type it into each store's "App access" form. */
  password: z.string(),
  /** The sample job made with the account; null when only the password changed. */
  workOrderReference: z.string().nullable(),
});

export const makeStoreReviewerRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/store-reviewer',
  operationId: 'makeStoreReviewer',
  summary: 'Make the app stores’ reviewer account, or give it a new password',
  description:
    'For a company that publishes its phone app in its own stores (0023). Makes an engineer `store-reviewer+<slug>@integr8-media.com` with a password shown once, and one made-up customer, site and job assigned to it, so the Google Play and App Store reviewers can sign in and see the app working without seeing a real customer. Called again, it gives the same account a new password and signs it out of every device. The account holds no seat and its role cannot be changed. Recorded in the platform audit log and the company’s own. A test company has no apps (409 `test_company_no_apps`).',
  tags: ['platform'],
  security: 'platform',
  params: tenantParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The account and its password, shown once.', schema: reviewerSchema },
    404: { description: 'No such company.' },
    409: {
      description:
        '`test_company_no_apps`, or `store_reviewer_email_taken`: somebody in the company already has the reviewer’s address.',
    },
  },
  handler: async ({ params }, context) => {
    const tenant = await liveCompany(params.tenantId);
    if (tenant.isTest) {
      throw conflict('test_company_no_apps', 'A test company has no phone or desktop apps.');
    }
    const made = await makeStoreReviewer({
      tenant,
      identity: context.services.identity,
      sessions: context.services.sessions,
      who: who(context),
    });
    await recordPlatformAction(context, {
      action: made.created ? 'tenant.store_reviewer_created' : 'tenant.store_reviewer_password_set',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'member',
      targetId: made.userId,
      metadata: { email: made.email, workOrderReference: made.workOrderReference },
    });
    return { status: 200, body: made };
  },
});

export const removeStoreReviewerRoute = defineRoute({
  method: 'delete',
  path: '/v1/platform/companies/:tenantId/store-reviewer',
  operationId: 'removeStoreReviewer',
  summary: 'Remove the app stores’ reviewer account from a company',
  description:
    'Takes the reviewer out of the company and signs it out of every device. The sample customer and job stay, as the company’s records. Recorded in the platform audit log and the company’s own.',
  tags: ['platform'],
  security: 'platform',
  params: tenantParams,
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Removed.' },
    404: { description: 'No such company, or it has no reviewer account.' },
  },
  handler: async ({ params }, context) => {
    const tenant = await liveCompany(params.tenantId);
    const removed = await removeStoreReviewer({
      tenant,
      sessions: context.services.sessions,
      who: who(context),
    });
    await recordPlatformAction(context, {
      action: 'tenant.store_reviewer_removed',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'member',
      targetId: removed.userId,
      metadata: { email: removed.email },
    });
    return { status: 204, body: {} };
  },
});

export const platformPhoneAppRoutes = [
  getCompanyAppsRoute,
  makeStoreReviewerRoute,
  removeStoreReviewerRoute,
];
