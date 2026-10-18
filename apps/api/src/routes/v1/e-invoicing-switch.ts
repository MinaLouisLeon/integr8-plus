import { hasFeature, MODULE_REQUIRES } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { z } from 'zod';
import { forgetTenantFeatures } from '../../http/features.js';
import { forbidden } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { forgetTokens } from '../../eta/services.js';
import { crmAudit as audit } from './crm-shared.js';
import { FEATURE, TAGS } from './e-invoicing-shared.js';

/**
 * Integr8's switch for a company's e-invoicing (ADR-0014), from the staff
 * desktop app while acting as the company.
 *
 * It sets the same thing as the dashboard's Features: the company's
 * `e_invoicing` module. Off, every e-invoicing route refuses with 403
 * `feature_disabled`, its menus close, and the worker sends nothing more to
 * the tax authority; nothing is deleted. It stays off until Integr8 is sure
 * it works, which is why only staff hold `eta.switch`.
 *
 * Neither route names the module as a `feature`: they are how it is turned
 * on. Neither needs any e-invoicing server setting: a deployment without
 * `ETA_CREDENTIALS_KEY` still answers, and says so.
 */

const availabilitySchema = z.object({
  /** The company's switch for e-invoicing itself. */
  enabled: z.boolean(),
  /** Whether the finance module e-invoicing needs is on. */
  financeEnabled: z.boolean(),
  /** Whether e-invoicing actually works for the company: its switch and finance both on. */
  active: z.boolean(),
  server: z.object({
    credentialsKeyConfigured: z.boolean(),
    productionAllowed: z.boolean(),
  }),
});

type Availability = z.infer<typeof availabilitySchema>;

async function availability(context: RequestContext): Promise<Availability> {
  const flags = await withTenant(context.principal.tenantId, (tx) => tx.featureFlags.resolved());
  return {
    enabled: flags[FEATURE] === true,
    financeEnabled: (MODULE_REQUIRES[FEATURE] ?? []).every((needed) => flags[needed] === true),
    active: hasFeature(flags, FEATURE),
    server: {
      credentialsKeyConfigured: context.config.ETA_CREDENTIALS_KEY !== undefined,
      productionAllowed: context.config.ETA_ALLOW_PRODUCTION,
    },
  };
}

export const getEtaAvailabilityRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/availability',
  operationId: 'getEtaAvailability',
  summary: 'Whether e-invoicing is switched on for the company',
  description:
    'Integr8 staff only, acting as the company (`eta.switch`). Answers whether the module is on, and whether the server has what e-invoicing needs.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.switch',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'Where the switch stands.', schema: availabilitySchema } },
  handler: async (_input, context) => ({ status: 200, body: await availability(context) }),
});

export const setEtaAvailabilityRoute = defineRoute({
  method: 'put',
  path: '/v1/eta/availability',
  operationId: 'setEtaAvailability',
  summary: 'Switch e-invoicing on or off for the company',
  description:
    'Integr8 staff only, acting as the company (`eta.switch`). Sets the company’s `e_invoicing` module, as the dashboard’s Features does. Off closes every e-invoicing screen and route at once and stops further sending; nothing is deleted, and switching it on again brings everything back.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.switch',
  params: noSchema,
  query: noSchema,
  body: z.object({ enabled: z.boolean() }),
  responses: {
    200: { description: 'Where the switch now stands.', schema: availabilitySchema },
    403: { description: 'Not Integr8 staff.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const staff = principal.impersonatedBy;
    if (staff === undefined) {
      // `eta.switch` is staff-only, so the permission check has already
      // refused anybody else; this keeps the route honest if that changes.
      throw forbidden('Only Integr8 staff can switch e-invoicing on or off.');
    }
    const platform = getPlatformDataSource();
    const before = await availability(context);
    await platform.settings.setFlag({
      tenantId: principal.tenantId,
      key: FEATURE,
      enabled: body.enabled,
      updatedBy: staff.pid,
    });
    await platform.platformAudit.append({
      platformUserId: staff.pid,
      actorLabel: (await platform.platformUsers.findById(staff.pid))?.email ?? staff.pid,
      action: 'flag.set',
      tenantId: principal.tenantId,
      tenantSlug: null,
      targetKind: 'feature_flag',
      targetId: FEATURE,
      reason: null,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { enabled: body.enabled, from: 'staff_app', grantId: staff.gid },
    });
    await withTenant(principal.tenantId, (tx) =>
      audit(tx, context, 'eta.module_switched', 'tenant', principal.tenantId, {
        enabled: body.enabled,
        was: before.enabled,
      }),
    );
    // The company sees the change on its next request, and a token cached
    // while it was on is not used after it is off.
    forgetTenantFeatures(principal.tenantId);
    forgetTokens(context.services.eta, principal.tenantId);
    return { status: 200, body: await availability(context) };
  },
});

export const etaSwitchRoutes = [getEtaAvailabilityRoute, setEtaAvailabilityRoute];
