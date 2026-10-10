import { toPlatformUserId, toTenantId } from '@integr8/core';
import { getPlatformDataSource, TENANT_PLANS, type TenantSummary, withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { forgetTenantStatus } from '../../../http/suspension.js';
import { onboardCompany } from '../../../platform/onboarding.js';
import { iso, isoOrNull } from '../schemas.js';
import { deliverInvitation } from '../../../email/deliver.js';
import { acceptInvitationUrl } from '../../../email/links.js';
import { INTEGR8_INVITER } from './support.js';
import { recordPlatformAction } from './audit.js';
import {
  companySettingsSchema,
  billingModeSchema,
  companyDetailSchema,
  companySummarySchema,
  onboardResponseSchema,
  planSchema,
  platformListSchema,
} from './schemas.js';

/**
 * The company directory, and what you can do to a company from it (P15).
 *
 * The whole point of P15 is that running the business needs no terminal, so
 * every one of these replaces something that used to be a psql session or a
 * Cloudflare dashboard: onboarding, suspending, changing a plan, scheduling a
 * deletion. Each writes to the platform audit log first-class, because these
 * are the actions somebody will one day need to account for.
 */

/** https only, bounded; the phone app hands it to a web view. */
const websiteUrlSchema = z
  .string()
  .max(2048)
  .regex(/^https:\/\/\S+$/u);

export const listCompaniesRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies',
  operationId: 'listCompanies',
  summary: 'Every company on the platform',
  description:
    'Status, plan, seats, storage used, when they joined and when anybody last did anything. One query with correlated sub-selects rather than a fan-out per company: the directory is the first screen and it has to stay fast as the list grows.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: z.object({
    /** Cancelled companies are hidden unless asked for. */
    includeCancelled: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    search: z.string().max(200).optional(),
  }),
  body: noSchema,
  responses: {
    200: { description: 'The directory.', schema: platformListSchema(companySummarySchema) },
  },
  handler: async ({ query }, context) => {
    void context;
    const platform = getPlatformDataSource();
    const companies = await platform.tenants.directory({ includeDeleted: query.includeCancelled });
    const scheduled = await pendingPurges();

    const needle = query.search?.trim().toLowerCase();
    const matching =
      needle === undefined || needle === ''
        ? companies
        : companies.filter(
            (company) =>
              company.name.toLowerCase().includes(needle) ||
              company.slug.toLowerCase().includes(needle),
          );

    return {
      status: 200,
      body: { items: matching.map((company) => toSummary(company, scheduled)) },
    };
  },
});

export const getCompanyRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId',
  operationId: 'getCompany',
  summary: 'One company, with its activity and flags',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The company.', schema: companyDetailSchema },
    404: { description: 'No such company.' },
  },
  handler: async ({ params }, context) => {
    void context;
    const platform = getPlatformDataSource();
    const summary = (await platform.tenants.directory({ includeDeleted: true })).find(
      (company) => company.id === params.tenantId,
    );
    if (summary === undefined) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    const scheduled = await pendingPurges();
    const flags = await platform.settings.flagsFor(params.tenantId);

    const owners = await withTenant(toTenantId(params.tenantId), async (tx) =>
      (await tx.tenantUsers.list()).filter(
        (member) => member.role === 'owner' || member.role === 'admin',
      ),
    );
    const invitations = await withTenant(toTenantId(params.tenantId), (tx) =>
      tx.invitations.listPending(),
    );
    const now = Date.now();

    const subscription = await platform.billing.find(params.tenantId);
    const tenant = await platform.tenants.findById(params.tenantId);
    const settings = await withTenant(toTenantId(params.tenantId), (tx) => tx.settings.get());

    return {
      status: 200,
      body: {
        ...toSummary(summary, scheduled),
        settings: toCompanySettings(settings),
        invitations: invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          createdAt: iso(invitation.createdAt),
          expiresAt: iso(invitation.expiresAt),
          expired: invitation.expiresAt.getTime() <= now,
        })),
        activity: await platform.tenants.monthlyActivity(params.tenantId),
        billing:
          subscription === undefined
            ? null
            : {
                provider: subscription.provider,
                status: subscription.status,
                plan: subscription.plan,
                interval: subscription.interval,
                currentPeriodEnd: isoOrNull(subscription.currentPeriodEnd),
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                trialEndsAt: isoOrNull(subscription.trialEndsAt),
                pastDueSince: isoOrNull(subscription.pastDueSince),
                graceEndsAt: isoOrNull(subscription.graceEndsAt),
                remindersSent: subscription.remindersSent,
                readOnlySince: isoOrNull(tenant?.readOnlySince ?? null),
                readOnlyReason: tenant?.readOnlyReason ?? null,
                providerCustomerId: subscription.providerCustomerId,
                providerSubscriptionId: subscription.providerSubscriptionId,
              },
        featureFlags: flags,
        owners: owners.map((member) => ({
          userId: member.userId,
          email: member.email,
          role: member.role,
          status: member.status,
        })),
      },
    };
  },
});

export const onboardCompanyRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies',
  operationId: 'onboardCompany',
  summary: 'Onboard a company, end to end',
  description:
    'Creates the company, seeds its job types, invites its owner and creates its R2 bucket in one call. No manual database or Cloudflare step — that is the exit criterion this endpoint exists to meet.',
  tags: ['platform'],
  security: 'platform',
  // Not `idempotent`: the dedupe table is tenant-scoped and a platform request
  // has no tenant to scope it to. The slug's unique index is what stops a
  // double submission creating two companies.
  params: noSchema,
  query: noSchema,
  body: z.object({
    slug: z
      .string()
      .min(2)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u, 'Lower case letters, digits and hyphens'),
    name: z.string().min(1).max(200),
    plan: z.enum(TENANT_PLANS).default('trial'),
    /** Null means uncapped. */
    seats: z.number().int().min(1).max(100_000).nullable().default(null),
    /**
     * `invoiced` starts the company active on its plan with no trial, since
     * Integr8 is taking the money; `self_serve` starts the trial as before.
     */
    billingMode: billingModeSchema.default('self_serve'),
    // A real address check, not just a length: the invitations table has one
    // too, and reaching it would mean a 500 after the company row committed.
    ownerEmail: z.email().max(320),
    /** The company's own website, https only. Its phone app opens on this page. */
    websiteUrl: websiteUrlSchema.nullable().optional(),
    /**
     * Email the owner's invitation now. Off by default: a company is usually
     * set up first (its forms, job types and look), and the invitation is sent
     * from the company's page once there is something to log in to. The link
     * is returned either way.
     */
    sendInvitation: z.boolean().default(false),
    /** Overrides the default starter set; an empty array seeds none. */
    jobTypes: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          code: z.string().min(1).max(32),
        }),
      )
      .max(50)
      .optional(),
  }),
  responses: {
    201: { description: 'Onboarded.', schema: onboardResponseSchema },
    409: { description: 'That slug is taken.' },
  },
  handler: async ({ body }, context) => {
    const platform = getPlatformDataSource();
    if ((await platform.tenants.findBySlug(body.slug)) !== undefined) {
      throw conflict('slug_taken', `A company already uses the slug "${body.slug}"`);
    }

    const onboarded = await onboardCompany({
      slug: body.slug,
      name: body.name,
      plan: body.plan,
      seats: body.seats,
      billingMode: body.billingMode,
      ownerEmail: body.ownerEmail,
      websiteUrl: body.websiteUrl ?? null,
      ...(body.jobTypes === undefined ? {} : { jobTypes: body.jobTypes }),
      onboardedBy: toPlatformUserId(context.platform.platformUserId),
      // The platform path always invites: whoever is onboarding this company is
      // not the person who will own it.
      ownerAccess: { kind: 'invitation' },
      invitationTtlSeconds: INVITATION_TTL_SECONDS,
      media: context.services.media,
      billing: {
        provider: context.services.billing.provider,
        trialDays: context.config.BILLING_TRIAL_DAYS,
      },
    });

    await recordPlatformAction(context, {
      action: 'tenant.onboarded',
      tenantId: onboarded.tenant.id,
      tenantSlug: onboarded.tenant.slug,
      targetKind: 'tenant',
      targetId: onboarded.tenant.id,
      metadata: {
        plan: body.plan,
        seats: body.seats,
        billingMode: body.billingMode,
        ownerEmail: body.ownerEmail,
        jobTypes: onboarded.jobTypes,
        bucket: onboarded.storage.bucket,
        storageError: onboarded.storage.error,
      },
    });

    const summary = (await platform.tenants.directory({ includeDeleted: true })).find(
      (company) => company.id === onboarded.tenant.id,
    );

    // Sent now only when asked: usually the company is set up first and the
    // invitation goes from its page when there is something to log in to.
    const delivery =
      body.sendInvitation && onboarded.invitation !== null
        ? await deliverInvitation({
            sender: context.services.email,
            config: context.config,
            logger: context.logger,
            tenantId: onboarded.tenant.id,
            email: onboarded.invitation.email,
            token: onboarded.invitation.token,
            invitedBy: INTEGR8_INVITER,
            expiresAt: onboarded.invitation.expiresAt,
          })
        : { sent: false, problem: null };

    return {
      status: 201,
      body: {
        company: toSummary(summary ?? fallbackSummary(onboarded.tenant), new Map()),
        // Never null on this path — `ownerAccess` is `invitation` above — but
        // the type allows it because self-serve onboarding makes the owner
        // directly and has nothing to send.
        ownerInvitation: {
          id: onboarded.invitation?.id ?? '',
          email: onboarded.invitation?.email ?? onboarded.tenant.name,
          expiresAt: iso(onboarded.invitation?.expiresAt ?? new Date()),
          // The token itself, once, so the dashboard can show a link to send by
          // hand. It is never logged and never stored in plaintext.
          acceptUrl:
            onboarded.invitation === null
              ? null
              : acceptInvitationUrl(context.config.WEB_APP_URL, onboarded.invitation.token),
          emailed: delivery.sent,
          emailProblem: delivery.problem,
        },
        storage: { bucket: onboarded.storage.bucket ?? '', created: onboarded.storage.created },
      },
    };
  },
});

export const suspendCompanyRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/suspend',
  operationId: 'suspendCompany',
  summary: 'Stop serving this company',
  description:
    'Every request from every one of their apps is refused, reads included, with the reason. Not read-only: a suspension is a commercial event, and half-working software is worse to be on the end of than software that says plainly it has stopped.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: z.object({ reason: z.string().min(5).max(500) }),
  responses: {
    200: { description: 'Suspended.', schema: companySummarySchema },
    404: { description: 'No such company.' },
  },
  handler: async ({ params, body }, context) => {
    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.suspend(params.tenantId, body.reason);
    if (tenant === undefined) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    forgetTenantStatus(tenant.id);
    await recordPlatformAction(context, {
      action: 'tenant.suspended',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'tenant',
      targetId: tenant.id,
      reason: body.reason,
    });

    return { status: 200, body: await summaryOf(tenant.id) };
  },
});

export const reactivateCompanyRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/reactivate',
  operationId: 'reactivateCompany',
  summary: 'Start serving this company again',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Reactivated.', schema: companySummarySchema },
    404: { description: 'No such company.' },
  },
  handler: async ({ params }, context) => {
    const tenant = await getPlatformDataSource().tenants.reactivate(params.tenantId);
    if (tenant === undefined) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    forgetTenantStatus(tenant.id);
    await recordPlatformAction(context, {
      action: 'tenant.reactivated',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'tenant',
      targetId: tenant.id,
    });

    return { status: 200, body: await summaryOf(tenant.id) };
  },
});

export const setCompanyPlanRoute = defineRoute({
  method: 'patch',
  path: '/v1/platform/companies/:tenantId/plan',
  operationId: 'setCompanyPlan',
  summary: 'Change a company’s plan, seat count or billing mode',
  description:
    'Sets the plan the API enforces and, for a company Integr8 invoices, the plan its people see on the billing screen. Switching a company to `invoiced` makes its subscription active with no trial and lifts a read-only state that non-payment caused: Integr8 is taking the money now. Switching back to `self_serve` leaves the subscription as the provider last described it.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: z.object({
    plan: planSchema,
    seats: z.number().int().min(1).max(100_000).nullable(),
    /** Left out: unchanged. */
    billingMode: billingModeSchema.optional(),
  }),
  responses: {
    200: { description: 'Changed.', schema: companySummarySchema },
    404: { description: 'No such company.' },
  },
  handler: async ({ params, body }, context) => {
    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.setPlan(params.tenantId, {
      plan: body.plan,
      seats: body.seats,
      ...(body.billingMode === undefined ? {} : { billingMode: body.billingMode }),
    });
    if (tenant === undefined) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    // The subscription row is what `/v1/billing/subscription` shows the
    // company, so it has to agree with the plan just set. For a self-serve
    // company that is all this touches: status, period and dunning belong to
    // the provider. For an invoiced one there is no provider to wait for.
    const invoiced = tenant.billingMode === 'invoiced';
    const subscription = await platform.billing.find(tenant.id);
    if (subscription === undefined) {
      await platform.billing.start({
        tenantId: tenant.id,
        provider: context.services.billing.provider,
        plan: body.plan,
        trialEndsAt: null,
        status: invoiced ? 'active' : 'trialing',
      });
    } else {
      await platform.billing.update(tenant.id, {
        plan: body.plan,
        ...(invoiced
          ? {
              status: 'active',
              trialEndsAt: null,
              pastDueSince: null,
              graceEndsAt: null,
              remindersSent: 0,
            }
          : {}),
      });
    }
    if (invoiced && tenant.readOnlySince !== null) {
      // Read-only is how non-payment ends under self-serve. Integr8 invoicing
      // the company is the payment arrangement now, so writes come back.
      await platform.tenants.setReadOnly(tenant.id, null);
    }

    // The plan decides the storage allowance (P16), and the door-check caches
    // the company row that carries it. Clearing it here means the admin who
    // just moved somebody onto a bigger plan sees uploads accepted at once
    // rather than a minute later.
    forgetTenantStatus(tenant.id);

    await recordPlatformAction(context, {
      action: 'tenant.plan_changed',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'tenant',
      targetId: tenant.id,
      metadata: { plan: body.plan, seats: body.seats, billingMode: tenant.billingMode },
    });

    return { status: 200, body: await summaryOf(tenant.id) };
  },
});

export const updateCompanySettingsRoute = defineRoute({
  method: 'patch',
  path: '/v1/platform/companies/:tenantId/settings',
  operationId: 'updateCompanySettings',
  summary: 'Change a company’s website, or whether its own apps are built',
  description:
    'The two branding facts the dashboard owns. The rest of the look — logo, icon, colours, theme — is set from the desktop app while acting as the company, where it can be previewed. Switching `appsEnabled` on puts the company in the list the release pipeline builds for.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: z.object({
    websiteUrl: websiteUrlSchema.nullable().optional(),
    appsEnabled: z.boolean().optional(),
  }),
  responses: {
    200: { description: 'Changed.', schema: companySettingsSchema },
    404: { description: 'No such company.' },
  },
  handler: async ({ params, body }, context) => {
    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.findById(params.tenantId);
    if (tenant?.deletedAt !== null) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    const settings = await withTenant(toTenantId(tenant.id), (tx) => tx.settings.update(body));

    await recordPlatformAction(context, {
      action: 'tenant.settings_changed',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'tenant',
      targetId: tenant.id,
      metadata: { fields: Object.keys(body), appsEnabled: settings.appsEnabled },
    });

    return { status: 200, body: toCompanySettings(settings) };
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCompanySettings(settings: {
  logoMediaId: string | null;
  appIconMediaId: string | null;
  brandColour: string | null;
  shellColour: string | null;
  defaultTheme: 'light' | 'dark' | 'system';
  websiteUrl: string | null;
  appsEnabled: boolean;
}): z.infer<typeof companySettingsSchema> {
  return {
    logoMediaId: settings.logoMediaId,
    appIconMediaId: settings.appIconMediaId,
    brandColour: settings.brandColour,
    shellColour: settings.shellColour,
    defaultTheme: settings.defaultTheme,
    websiteUrl: settings.websiteUrl,
    appsEnabled: settings.appsEnabled,
  };
}

/** Long enough to survive a holiday, matching the tenant-side invitation TTL. */
const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

function toSummary(
  company: TenantSummary,
  scheduled: Map<string, Date>,
): z.infer<typeof companySummarySchema> {
  return {
    id: company.id,
    slug: company.slug,
    name: company.name,
    status: company.status,
    plan: company.plan,
    seats: company.seats,
    billingMode: company.billingMode,
    members: company.members,
    activeMembers: company.activeMembers,
    storageBytes: company.storageBytes,
    createdAt: iso(company.createdAt),
    lastActivityAt: isoOrNull(company.lastActivityAt),
    suspendedAt: isoOrNull(company.suspendedAt),
    suspendedReason: company.suspendedReason,
    deletionScheduledFor: isoOrNull(scheduled.get(company.id) ?? null),
  };
}

async function summaryOf(tenantId: string): Promise<z.infer<typeof companySummarySchema>> {
  const platform = getPlatformDataSource();
  const company = (await platform.tenants.directory({ includeDeleted: true })).find(
    (row) => row.id === tenantId,
  );
  if (company === undefined) {
    throw notFound(`No company with id ${tenantId}`);
  }
  return toSummary(company, await pendingPurges());
}

function fallbackSummary(tenant: {
  id: string;
  slug: string;
  name: string;
  status: TenantSummary['status'];
  plan: TenantSummary['plan'];
  seats: number | null;
  billingMode: TenantSummary['billingMode'];
  createdAt: Date;
  suspendedAt: Date | null;
  suspendedReason: string | null;
}): TenantSummary {
  return {
    ...tenant,
    updatedAt: tenant.createdAt,
    onboardedBy: null,
    members: 0,
    activeMembers: 0,
    storageBytes: 0,
    lastActivityAt: null,
  } as TenantSummary;
}

/** Which companies have a purge scheduled, so the directory can say so. */
async function pendingPurges(): Promise<Map<string, Date>> {
  const deletions = await getPlatformDataSource().lifecycle.listDeletions();
  return new Map(
    deletions
      .filter((row) => row.cancelledAt === null && row.completedAt === null)
      .map((row) => [row.tenantId, row.purgeAfter]),
  );
}

export const platformCompanyRoutes = [
  listCompaniesRoute,
  onboardCompanyRoute,
  getCompanyRoute,
  suspendCompanyRoute,
  reactivateCompanyRoute,
  setCompanyPlanRoute,
  updateCompanySettingsRoute,
];
