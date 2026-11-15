import { getPlatformDataSource, withTenant } from '@integr8/db';
import { z } from 'zod';
import { entitlementsFor, usageFor } from '../../billing/entitlements.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { isoOrNull } from './schemas.js';

/**
 * What a company is on, and what it is allowed (P17; P42).
 *
 * Integr8 invoices every company directly and sets its plan from the staff
 * app, so this is read-only: the company's Billing screen shows the plan, the
 * limits and the usage against them, and how to reach Integr8.
 */

const subscriptionSchema = z.object({
  plan: z.string(),
  status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'incomplete']),
  trialEndsAt: z.iso.datetime().nullable(),
  /** Whether writes are refused right now, and why. */
  readOnly: z.boolean(),
  readOnlyReason: z.string().nullable(),
  entitlements: z.object({
    seats: z.number().int().nullable(),
    storageBytes: z.number().int().nullable(),
    submissionsPerMonth: z.number().int().nullable(),
  }),
  usage: z.object({
    seatsUsed: z.number().int(),
    submissionsThisMonth: z.number().int(),
  }),
});

export const getSubscriptionRoute = defineRoute({
  method: 'get',
  path: '/v1/billing/subscription',
  operationId: 'getSubscription',
  summary: 'What this company is on, and what it is allowed',
  description:
    'The plan, where it stands, and the limits with the usage against them — the same numbers the API enforces, so a screen can warn before a refusal rather than explain one afterwards. Integr8 invoices every company directly; nothing here is paid in the app.',
  tags: ['billing'],
  security: 'authenticated',
  permission: 'billing.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The subscription.', schema: subscriptionSchema },
  },
  handler: async (_input, context) => {
    const tenantId = context.principal.tenantId;
    const platform = getPlatformDataSource();

    const [subscription, tenant] = await Promise.all([
      withTenant(tenantId, (tx) => tx.subscription.find()),
      platform.tenants.findById(tenantId),
    ]);

    const plan = subscription?.plan ?? 'trial';
    const [entitlements, usage] = await Promise.all([
      entitlementsFor(plan, tenant?.seats ?? null),
      usageFor(tenantId),
    ]);

    return {
      status: 200,
      body: {
        plan,
        status: subscription?.status ?? 'active',
        trialEndsAt: isoOrNull(subscription?.trialEndsAt ?? null),
        readOnly: tenant?.readOnlySince != null,
        readOnlyReason: tenant?.readOnlyReason ?? null,
        entitlements: {
          seats: entitlements.seats,
          storageBytes: entitlements.storageBytes,
          submissionsPerMonth: entitlements.submissionsPerMonth,
        },
        usage,
      },
    };
  },
});

export const billingRoutes = [getSubscriptionRoute] as const;
